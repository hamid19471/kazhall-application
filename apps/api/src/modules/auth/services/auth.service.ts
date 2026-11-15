import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { LoginDto } from '../dto/login.dto';
import { RegisterDto } from '../dto/register.dto';
import { UserService } from '../../user/user.service';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import * as ms from 'ms';
import { StringValue } from 'ms';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { RefreshToken } from '../entities/refresh-token.entity';
import * as crypto from 'crypto';
import {
  AuthErrorCodes,
  AuthMessages,
} from 'src/common/constants/auth.messages';
import {
  isEligibleForAudience,
  isSessionAudience,
  SessionAudience,
} from '../audience';
import { User } from 'src/modules/user/entities/user.entity';
import { ENV_DEFAULTS } from 'src/configs/env.validation';
import {
  RefreshTokenPayload,
  isStaleSessionVersion,
  readLifecycle,
  TOKEN_TYPE_ACCESS,
  TOKEN_TYPE_REFRESH,
} from '../auth.types';
import { OtpService } from './otp.service';
import { PermissionService } from '../permissions/permission.service';
import { RealtimeGateway } from 'src/modules/realtime/realtime.gateway';

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,

    /**
     * All OTP policy — cooldown, both send rate limits, the attempt bound, the
     * TTL, one-time consumption — lives there, in `otp_challenges` and in one
     * Redis counter. `AuthService` keeps only the part that is about SESSIONS:
     * find-or-create the customer and mint the tokens.
     */
    private readonly otpService: OtpService,

    /**
     * Expands roles into capability codes. Injected here — rather than read
     * from the token — because eligibility is re-decided on every rotation,
     * and a capability revoked a minute ago must be gone at the next rotation
     * rather than at the refresh token's full expiry.
     */
    private readonly permissionService: PermissionService,

    @InjectDataSource()
    private readonly dataSource: DataSource,

    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,

    /**
     * Revoking sessions has to reach the WEBSOCKETS too. See
     * {@link AuthService.revokeAllSessions} — a revocation changes none of the
     * three things the gateway's re-validation sweep looks at, so the only way
     * a revoked session's socket ever closes is if someone tells it to.
     */
    private readonly realtime: RealtimeGateway,
  ) {}

  // ==========================================================================
  // OTP
  // ==========================================================================

  /**
   * Issues a code. Every control lives in `OtpService`; see that class for the
   * policy and the SQL that enforces it.
   *
   * WHAT CHANGED HERE, AND WHY IT WAS URGENT
   * ----------------------------------------
   * The previous implementation was four lines and three defects:
   *
   *   const otp = crypto.randomInt(100000, 999999);
   *   const user = await this.userService.findOneByMobile(mobile);
   *   if (!user) await this.userService.createSiteUser(mobile);   // <-- (1)
   *   await this.redisService.set(`otp:${mobile}`, hash, 120);    // <-- (2)
   *
   *   1. IT CREATED A PERMANENT ACCOUNT BEFORE ANY VERIFICATION. A loop over
   *      `POST /auth/send-otp` inserted an unbounded number of real `site`
   *      users for numbers the caller does not control — free account
   *      creation, free SMS-bombing of a stranger's phone, and a `users` table
   *      an attacker can inflate at will. The account is now created ONLY on a
   *      successful verification (`verifyOtp` below); the pending number is
   *      held in `otp_challenges` until then.
   *   2. NO COOLDOWN AND NO RATE LIMIT, so (1) was not merely possible but
   *      cheap.
   *   3. `randomInt(100000, 999999)` — exclusive upper bound, and no code with
   *      a leading zero — searched 10% smaller a keyspace than it appeared to.
   *
   * There is no longer any user lookup on this path AT ALL, which is what makes
   * the response identical for a registered and an unregistered number by
   * construction rather than by keeping two branches in step.
   *
   * @param clientIp the direct socket peer, supplied by the controller. See
   *   `StorefrontOtpController.sendOtp` for the `trust proxy` deployment
   *   prerequisite.
   */
  async sendOtp(mobile: string, clientIp: string): Promise<void> {
    await this.otpService.issue(mobile, clientIp);
  }

  /**
   * Verifies a code and returns a session.
   *
   * TWO DEFECTS REMOVED
   * -------------------
   *  1. USER ENUMERATION. The old first line was
   *
   *       const user = await this.userService.findOneByMobile(mobile);
   *       if (!user) throw new NotFoundException(AuthMessages.USER_NOT_FOUND);
   *
   *     A 404 "User not found." for an unregistered number and a 401 "Invalid
   *     or expired OTP." for a registered one is a free registration oracle:
   *     anyone could walk a list of mobile numbers and learn which are
   *     customers, without needing a code at all. The lookup now happens only
   *     AFTER the code has been proven correct.
   *  2. NON-ATOMIC CONSUMPTION. `get` then `del` on a Redis key is two round
   *     trips, so two simultaneous replays of one correct code both read it and
   *     both minted a session. Consumption is now a single guarded UPDATE.
   *
   * ACCOUNT CREATION IS DEFERRED TO EXACTLY HERE — the first moment anyone has
   * proven control of the number.
   */
  async verifyOtp(mobile: string, code: string) {
    // Throws an identical 401 for every failure mode, and returns the
    // NORMALIZED number so the account below cannot be keyed by a different
    // spelling than the challenge was.
    const normalizedMobile = await this.otpService.consume(mobile, code);

    const user = await this.findOrCreateSiteUser(normalizedMobile);

    // A soft-deactivated customer must not get a session even with a correct
    // code. This does reveal "this number belongs to a deactivated account" —
    // but only to somebody who has just proven they control the phone, which is
    // not an enumeration channel.
    this.assertActive(user);

    // OTP is the storefront's door and only the storefront's: a number that
    // happens to belong to staff must not mint an admin or till session.
    await this.assertEligible(user, 'storefront');

    const tokens = await this.issueTokens(user, 'storefront');

    return { ...tokens, user };
  }

  /**
   * Find-or-create for the `site` customer behind a verified number.
   *
   * The insert is guarded by `users.mobile`'s UNIQUE constraint rather than by
   * the read above it: `UserService.createSiteUser` rejects a duplicate, so a
   * lost race must be RECOVERED from and not surfaced as a failed login. The
   * race is narrow (only one caller can consume a given challenge, and a second
   * challenge for the same number needs the cooldown to elapse first) but the
   * failure mode — "your code was correct and you were signed out anyway" —
   * is bad enough to be worth three lines.
   */
  private async findOrCreateSiteUser(mobile: string): Promise<User> {
    const existing = await this.userService.findOneByMobile(mobile);
    if (existing) return existing;

    try {
      return await this.userService.createSiteUser(mobile);
    } catch (error) {
      const raced = await this.userService.findOneByMobile(mobile);
      if (raced) return raced;
      // Not a duplicate — e.g. the `site` role row is missing from the
      // database, which is a deployment fault and must stay loud.
      throw error;
    }
  }

  // ==========================================================================
  // Password login / registration
  // ==========================================================================

  async login(loginDto: LoginDto, audience: SessionAudience) {
    const user = await this.userService.findOneByUsername(loginDto.username);

    //check exist user
    if (!user)
      throw new UnauthorizedException(AuthMessages.INVALID_CREDENTIALS);

    //check password
    const isMatch = await bcrypt.compare(loginDto.password, user.password);
    if (!isMatch)
      throw new UnauthorizedException(AuthMessages.INVALID_CREDENTIALS);

    // Soft-deactivated staff (docs/ARCHITECTURE.md section 3) must not be able
    // to sign in, even with correct credentials.
    this.assertActive(user);

    // Eligibility is decided BEFORE a token exists. Minting an admin session
    // for a cashier and leaving @Roles to refuse each request would still put a
    // working admin cookie in their browser.
    await this.assertEligible(user, audience);

    return this.issueTokens(user, audience);
  }

  /**
   * Ordered after the password check on purpose: refusing an ineligible
   * username before verifying its password would turn this route into a role
   * oracle for names the caller cannot authenticate as.
   */
  private async assertEligible(
    user: User,
    audience: SessionAudience,
  ): Promise<void> {
    // Expanded from the roles ON THE USER ROW, never from a token claim, and
    // never from anything the caller sent. A custom role carrying
    // `admin.access` opens the admin door; one without it does not, no matter
    // what else it grants.
    const permissions = await this.permissionService.resolveEffective(
      user.roles ?? [],
    );
    if (!isEligibleForAudience(permissions, audience)) {
      throw new UnauthorizedException({
        error: AuthErrorCodes.AUDIENCE_NOT_PERMITTED,
        message: AuthMessages.AUDIENCE_NOT_PERMITTED,
      });
    }
  }

  async register(registerDto: RegisterDto) {
    const existUser = await this.userService.findOneByUsername(
      registerDto.username,
    );

    //check exist user
    if (existUser)
      throw new BadRequestException(AuthMessages.USER_ALREADY_EXISTS);

    // create user
    return await this.userService.create({
      username: registerDto.username,
      password: registerDto.password,
      role: registerDto.role,
      branchId: registerDto.branchId ?? null,
    });
  }

  // ==========================================================================
  // Refresh rotation
  // ==========================================================================

  /**
   * Rotates a refresh token.
   *
   * ATOMICITY. The old flow was read -> validate -> save(revoked) -> issue.
   * Two concurrent requests carrying the same refresh token both read
   * `revoked = false`, both passed validation, and both were issued a fresh
   * pair — a replayed (or stolen) refresh token minted unlimited sessions.
   *
   * The revocation is now a single guarded conditional UPDATE
   *   `SET revoked = true WHERE tokenId = :id AND revoked = false`
   * whose affected-row count must be exactly 1. Exactly one racer can observe
   * `affected === 1`; every other one loses and is rejected. The replacement
   * token is inserted inside the SAME transaction, so there is no window in
   * which the caller's old token is dead and the new one does not yet exist.
   */
  async refreshToken(refreshToken: string, audience: SessionAudience) {
    if (!refreshToken)
      throw new UnauthorizedException(AuthMessages.INVALID_REFRESH_TOKEN);

    let decoded: RefreshTokenPayload;
    try {
      decoded = this.jwtService.verify<RefreshTokenPayload>(refreshToken, {
        secret: this.configService.getOrThrow<string>('JWT_SECRET_KEY'),
      });
    } catch {
      throw new UnauthorizedException(AuthMessages.INVALID_REFRESH_TOKEN);
    }

    // Purpose check: an ACCESS token presented here must not rotate anything.
    if (decoded.typ !== TOKEN_TYPE_REFRESH)
      throw new UnauthorizedException(AuthMessages.WRONG_TOKEN_TYPE);

    // Audience check: the till's refresh endpoint must not rotate a storefront
    // session into a till session. Asserted on the CLAIM here and again on the
    // stored row below, so neither a forged claim nor a mislabelled row alone
    // is enough.
    if (!isSessionAudience(decoded.aud) || decoded.aud !== audience)
      throw new UnauthorizedException(AuthMessages.WRONG_TOKEN_AUDIENCE);

    const tokenId = decoded.jti;
    const userId = decoded.sub;
    if (!userId || !tokenId)
      throw new UnauthorizedException(AuthMessages.INVALID_TOKEN_PAYLOAD);

    // Re-read the user rather than trusting the roles baked into the old token:
    // a role change or a deactivation must take effect on the next rotation.
    const user = await this.userService.findOneById(userId).catch(() => null);
    if (!user)
      throw new UnauthorizedException(AuthMessages.INVALID_REFRESH_TOKEN);
    this.assertActive(user);

    // A password change must end the WHOLE session, not just the access token.
    // JwtStrategy rejects a stale ACCESS token, but rotation lives outside that
    // check: the holder of a stale REFRESH token would otherwise rotate and be
    // handed a brand new access token, walking straight around the "kill every
    // session NOW" lever. Same rule, same helper, same rejection.
    const currentVersion = readLifecycle(user).passwordVersion;
    if (
      currentVersion === null ||
      isStaleSessionVersion(decoded.pv, currentVersion)
    ) {
      // `currentVersion === null` is restated rather than left to
      // `isStaleSessionVersion` (which already refuses it) so that the
      // compiler can narrow the type for the re-stamping below. Both branches
      // are the same refusal.
      throw new UnauthorizedException(AuthMessages.SESSION_INVALIDATED);
    }

    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(RefreshToken);

      const existToken = await repository.findOne({
        where: { tokenId, userId, audience, revoked: false },
      });

      if (!existToken || new Date(existToken.expiresAt) < new Date()) {
        throw new UnauthorizedException(AuthMessages.INVALID_REFRESH_TOKEN);
      }

      const isMatch = await bcrypt.compare(
        this.digest(refreshToken),
        existToken.tokenHash,
      );
      if (!isMatch) {
        throw new UnauthorizedException(AuthMessages.INVALID_REFRESH_TOKEN);
      }

      // The concurrency primitive. Not `save()`.
      const revocation = await repository
        .createQueryBuilder()
        .update(RefreshToken)
        .set({ revoked: true })
        .where('"tokenId" = :tokenId', { tokenId })
        .andWhere('revoked = false')
        .execute();

      if (revocation.affected !== 1) {
        throw new UnauthorizedException(
          AuthMessages.REFRESH_TOKEN_ALREADY_USED,
        );
      }

      // Eligibility is re-decided on every rotation, not just at login: a
      // cashier promoted away from `sale`, or an admin demoted, must lose the
      // surface at the next rotation rather than keeping it for the refresh
      // token's full 48 hours.
      await this.assertEligible(user, audience);

      const roles = user.roles.map((role) => role.name);
      const branchId = user.branchId ?? null;

      // `currentVersion` was read and checked above, inside this same request.
      // Re-stamping it rather than copying `decoded.pv` keeps one source of
      // truth for the epoch: if a password change commits between the check
      // and here, the rotated token carries the version the row had when it
      // was read, and the very next request rejects it. A rotation can be
      // raced; it cannot outlive the epoch it was issued under.
      const accessToken = this.generateAccessToken(
        user.id,
        user.identifier,
        roles,
        branchId,
        audience,
        currentVersion,
      );
      const newRefreshToken = await this.generateRefreshToken(
        user.id,
        user.identifier,
        roles,
        branchId,
        audience,
        currentVersion,
        manager,
      );

      return { accessToken, refreshToken: newRefreshToken };
    });
  }

  // ==========================================================================
  // Password change
  // ==========================================================================

  /**
   * Self-service password change.
   *
   * Three properties, each of which is the reason a simpler version was
   * rejected:
   *
   *  1. THE CURRENT PASSWORD IS RE-VERIFIED. A valid session proves the
   *     browser signed in once, not that the owner is present. Without this,
   *     an unattended terminal is a permanent takeover.
   *  2. `passwordChangedAt` IS STAMPED, which invalidates every access token
   *     issued before this instant in EVERY audience, and blocks rotation of
   *     every refresh token minted before it — so a compromised session dies
   *     the moment the real owner changes their password, rather than lasting
   *     out the refresh token's 48 hours.
   *  3. `mustChangePassword` IS CLEARED. This is the only route that clears
   *     it, which is what makes the forced-change state exitable.
   *
   * The caller's own session dies with everyone else's. That is deliberate and
   * is what the frontend is told to expect: it signs in again with the new
   * password rather than silently continuing on a token minted under the old
   * one.
   */
  async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.userService.findOneById(userId);

    if (!user.password) {
      throw new BadRequestException({
        error: AuthErrorCodes.PASSWORD_LOGIN_NOT_AVAILABLE,
        message: AuthMessages.PASSWORD_LOGIN_NOT_AVAILABLE,
      });
    }

    const matches = await bcrypt.compare(currentPassword, user.password);
    if (!matches) {
      throw new UnauthorizedException({
        error: AuthErrorCodes.CURRENT_PASSWORD_INVALID,
        message: AuthMessages.CURRENT_PASSWORD_INVALID,
      });
    }

    // Compared against the HASH, not against the plaintext of the request, so
    // "the same password with different whitespace" is still caught.
    const unchanged = await bcrypt.compare(newPassword, user.password);
    if (unchanged) {
      throw new BadRequestException({
        error: AuthErrorCodes.PASSWORD_UNCHANGED,
        message: AuthMessages.PASSWORD_UNCHANGED,
      });
    }

    await this.userService.applyPasswordChange(userId, newPassword, {
      mustChangePassword: false,
    });
  }

  // ==========================================================================
  // Logout / session revocation
  // ==========================================================================

  /**
   * SESSION POLICY — current-session-only (the default).
   *
   * `POST /auth/logout` revokes ONLY the refresh token presented in the
   * request's `refresh_token` cookie. Signing out of a phone must not sign the
   * same person out of the shop's POS terminal mid-sale; a staff member who is
   * logged in at two registers has two independent sessions, and the receipt
   * attribution of the other one must not be interrupted.
   *
   * Revoke-all is available where it is genuinely wanted, as an explicit,
   * separate action:
   *   - `POST /auth/logout-all`                     — the caller's own sessions
   *   - `POST /auth/users/:id/revoke-sessions`      — super_admin, any user
   *     (used after a compromise or when deactivating staff).
   *
   * Note the access token itself is a bearer credential and stays technically
   * valid until it expires — that is why JWT_ACCESS_EXPIRATION is short and why
   * `users.passwordChangedAt` exists as the hard cut-off for the "kill every
   * session NOW" case.
   *
   * Returns the number of refresh tokens revoked. Never throws for an unknown
   * or already-revoked token: logout must be idempotent and must still let the
   * controller clear the cookies.
   */
  async logout(
    refreshToken: string | undefined,
    audience: SessionAudience,
  ): Promise<number> {
    if (!refreshToken) return 0;

    let decoded: RefreshTokenPayload;
    try {
      decoded = this.jwtService.verify<RefreshTokenPayload>(refreshToken, {
        secret: this.configService.getOrThrow<string>('JWT_SECRET_KEY'),
        // An expired refresh token is already useless; we still want to tidy up
        // its row, and we must not 500 the logout.
        ignoreExpiration: true,
      });
    } catch {
      return 0;
    }

    if (decoded.typ !== TOKEN_TYPE_REFRESH || !decoded.jti) return 0;

    // Signing out of the till must leave the storefront and the admin console
    // alone. The audience is part of the WHERE for exactly that reason.
    if (decoded.aud !== audience) return 0;

    const result = await this.refreshTokenRepository
      .createQueryBuilder()
      .update(RefreshToken)
      .set({ revoked: true })
      .where('"tokenId" = :tokenId', { tokenId: decoded.jti })
      .andWhere('audience = :audience', { audience })
      .andWhere('revoked = false')
      .execute();

    return result.affected ?? 0;
  }

  /** Revoke-all path. Used by `/auth/logout-all` and the admin endpoint. */
  async revokeAllSessions(userId: number): Promise<number> {
    const result = await this.refreshTokenRepository
      .createQueryBuilder()
      .update(RefreshToken)
      .set({ revoked: true })
      .where('"userId" = :userId', { userId })
      .andWhere('revoked = false')
      .execute();

    /*
     * AND END THE WEBSOCKETS, which revoking refresh rows does not.
     *
     * The re-validation sweep cannot catch this one: it disconnects on an
     * expired token, a deactivated user or a moved password epoch, and a
     * revocation changes none of the three. Without this line "sign out
     * everywhere" left a live socket delivering order and stock frames until
     * the access token expired on its own — the one thing the caller was
     * trying to stop.
     *
     * After the UPDATE has executed, never before: a revocation that fails
     * must not disconnect anybody.
     */
    await this.realtime.disconnectUser(userId, 'sessions revoked');

    return result.affected ?? 0;
  }

  // ==========================================================================
  // Token minting
  // ==========================================================================

  private async issueTokens(user: User, audience: SessionAudience) {
    const roles = user.roles.map((role) => role.name);
    const branchId = user.branchId ?? null;

    /*
     * THE SESSION EPOCH IS STAMPED INTO BOTH TOKENS.
     *
     * It is read from the `user` row this request already loaded. A password
     * change that commits between that read and this mint leaves the new token
     * carrying the OLD version, which the very next request rejects — the
     * fail-closed direction, and the one that matters: a token minted in the
     * same instant as a password change must not outlive it.
     *
     * `readLifecycle` returns null when the column is absent from the loaded
     * row, and a null epoch would mint a token that can never be verified. A
     * user loaded through `UserService` always carries it (migration 0027 made
     * it NOT NULL), so this throws rather than silently issuing a dead session.
     */
    const passwordVersion = readLifecycle(user).passwordVersion;
    if (passwordVersion === null) {
      throw new UnauthorizedException(AuthMessages.SESSION_INVALIDATED);
    }

    const accessToken = this.generateAccessToken(
      user.id,
      user.identifier,
      roles,
      branchId,
      audience,
      passwordVersion,
    );

    const refreshToken = await this.generateRefreshToken(
      user.id,
      user.identifier,
      roles,
      branchId,
      audience,
      passwordVersion,
    );

    return { accessToken, refreshToken };
  }

  /**
   * `expiresIn` must never be `undefined`: @nestjs/jwt throws
   * `"expiresIn" should be a number of seconds or string representing a
   * timespan`, which used to turn every login into a 500 whenever
   * JWT_ACCESS_EXPIRATION was unset. Boot-time validation (configs/env.validation.ts)
   * now guarantees the variable exists, and this `??` is the belt-and-braces
   * default for any code path that builds a ConfigService without it (tests).
   * The same value drives the access_token cookie maxAge in `AuthCookieService`.
   */
  private accessExpiration(): StringValue {
    return (this.configService.get<string>('JWT_ACCESS_EXPIRATION') ??
      ENV_DEFAULTS.JWT_ACCESS_EXPIRATION) as StringValue;
  }

  private refreshExpiration(): StringValue {
    return (this.configService.get<string>('JWT_REFRESH_EXPIRATION') ??
      ENV_DEFAULTS.JWT_REFRESH_EXPIRATION) as StringValue;
  }

  private generateAccessToken(
    sub: number,
    identifier: string,
    roles: string[],
    branch: number | null,
    aud: SessionAudience,
    /** `users."passwordVersion"`, the epoch this session belongs to. */
    pv: number,
  ): string {
    return this.jwtService.sign(
      { sub, identifier, roles, branch, aud, pv, typ: TOKEN_TYPE_ACCESS },
      { expiresIn: this.accessExpiration() },
    );
  }

  private async generateRefreshToken(
    sub: number,
    identifier: string,
    roles: string[],
    branch: number | null,
    aud: SessionAudience,
    /**
     * `users."passwordVersion"`. Carried by the REFRESH token as well as the
     * access token, deliberately: rotation re-checks it, so a refresh token
     * from an ended epoch cannot be traded for a live access token.
     */
    pv: number,
    manager?: EntityManager,
  ): Promise<string> {
    const tokenId = uuidv4();
    const refreshExpiration = this.refreshExpiration();
    const tokenExpiresAt = new Date(Date.now() + ms(refreshExpiration));

    const refreshToken = this.jwtService.sign(
      {
        identifier,
        sub,
        roles,
        branch,
        aud,
        pv,
        jti: tokenId,
        typ: TOKEN_TYPE_REFRESH,
      },
      { expiresIn: Math.floor(ms(refreshExpiration) / 1000) },
    );

    const repository = manager
      ? manager.getRepository(RefreshToken)
      : this.refreshTokenRepository;

    await repository.save(
      repository.create({
        tokenId,
        userId: sub,
        audience: aud,
        tokenHash: await this.hashToken(refreshToken),
        expiresAt: tokenExpiresAt,
        revoked: false,
      }),
    );

    return refreshToken;
  }

  // ==========================================================================
  // Hashing helpers
  // ==========================================================================

  /**
   * bcrypt silently TRUNCATES its input at 72 bytes. A signed JWT is several
   * hundred bytes, so `bcrypt.hash(jwt)` only ever covered the header and the
   * first part of the payload — two different refresh tokens for the same user
   * issued in the same second could share that prefix, and the stored hash
   * proved almost nothing about the token presented.
   *
   * Hashing a fixed-length sha256 hex digest (64 ASCII bytes, safely under the
   * limit) first means bcrypt covers the ENTIRE token.
   */
  private digest(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private hashToken(token: string): Promise<string> {
    return bcrypt.hash(this.digest(token), 10);
  }

  // `otpHash`, `otpCompare` and `maskMobile` moved out of this class with the
  // OTP flow itself: the HMAC now lives in `OtpService.hashCode` (same secret,
  // same `<mobile>:<code>` input, so no code in flight is invalidated) and the
  // masking in `otp-sender.ts#maskMobile`. Leaving unreferenced copies of a
  // hashing helper behind is how two subtly different versions of one security
  // primitive end up in a codebase.

  /** Rejects soft-deactivated staff (users.deactivatedAt, migration 0006). */
  private assertActive(user: User): void {
    if (readLifecycle(user).deactivatedAt) {
      throw new UnauthorizedException(AuthMessages.ACCOUNT_DEACTIVATED);
    }
  }
}
