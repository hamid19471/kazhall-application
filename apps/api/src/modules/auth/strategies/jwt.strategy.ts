import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { UserService } from 'src/modules/user/user.service';
import { PermissionService } from '../permissions/permission.service';
import { User } from 'src/modules/user/entities/user.entity';
import { AuthMessages } from 'src/common/constants/auth.messages';
import {
  AccessTokenPayload,
  AuthenticatedUser,
  isStaleSessionVersion,
  readLifecycle,
  TOKEN_TYPE_ACCESS,
} from '../auth.types';
import { AUDIENCE_COOKIES, isSessionAudience } from '../audience';
import {
  AUDIENCE_REQUEST_KEY,
  AudienceAwareRequest,
  SELECTED_AUDIENCE_REQUEST_KEY,
} from '../audience-request';

/**
 * Picks the ONE cookie this route is entitled to read.
 *
 * A browser signed into all three applications sends all six cookies. Reading
 * "the access token" without saying which would authenticate a till request
 * with a storefront session — the defect this replaces. The route's declared
 * audiences are walked in their declared order and the first one present wins,
 * so the choice is a property of the route and is stable regardless of cookie
 * ordering in the header.
 */
function extractAudienceCookie(req: AudienceAwareRequest): string | null {
  const required = req[AUDIENCE_REQUEST_KEY];
  if (!required || required.length === 0) return null;

  for (const audience of required) {
    const token = req.cookies?.[AUDIENCE_COOKIES[audience].access];
    if (token) {
      req[SELECTED_AUDIENCE_REQUEST_KEY] = audience;
      return token;
    }
  }
  return null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    configService: ConfigService,
    private readonly usersService: UserService,
    /**
     * Roles have always been re-read from the database here rather than taken
     * from the token; capabilities are expanded from those same rows for the
     * same reason. A permission revoked thirty seconds ago must be gone on the
     * NEXT REQUEST, not at the next token rotation.
     */
    private readonly permissionService: PermissionService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors<AudienceAwareRequest>([
        extractAudienceCookie,
      ]),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET_KEY'),
      passReqToCallback: true,
    });
  }

  async validate(
    req: AudienceAwareRequest,
    payload: AccessTokenPayload,
  ): Promise<AuthenticatedUser> {
    // 1. TOKEN PURPOSE. Access and refresh tokens share a signing secret, so
    //    without this a refresh token authenticates every protected route.
    if (payload?.typ !== TOKEN_TYPE_ACCESS) {
      throw new UnauthorizedException(AuthMessages.WRONG_TOKEN_TYPE);
    }

    // 2. AUDIENCE. Checked against the cookie the extractor chose AND against
    //    the route's declared list. The cookie name alone is not proof — it is
    //    attacker-writable in a way the signature is not — so the signed claim
    //    must agree with the jar the token arrived in, and both must be a
    //    surface this route serves.
    const selected = req[SELECTED_AUDIENCE_REQUEST_KEY];
    const required = req[AUDIENCE_REQUEST_KEY] ?? [];
    if (
      !isSessionAudience(payload?.aud) ||
      !selected ||
      payload.aud !== selected ||
      !required.includes(payload.aud)
    ) {
      throw new UnauthorizedException(AuthMessages.WRONG_TOKEN_AUDIENCE);
    }

    let user: User;
    try {
      user = await this.usersService.findOneById(payload.sub);
    } catch {
      throw new UnauthorizedException(AuthMessages.INVALID_ACCESS_TOKEN);
    }

    const { deactivatedAt, mustChangePassword, passwordVersion } =
      readLifecycle(user);

    // 3. SOFT DEACTIVATION. Retired staff keep their row (orders.cashierUserId
    //    is ON DELETE RESTRICT) but must lose access immediately.
    if (deactivatedAt) {
      throw new UnauthorizedException(AuthMessages.ACCOUNT_DEACTIVATED);
    }

    // 4. PASSWORD CHANGE INVALIDATES EXISTING SESSIONS, in every audience.
    //    The token's `pv` claim must still equal `users."passwordVersion"`.
    //    This is a plain integer equality with no clock in it: the previous
    //    check compared the token's whole-second `iat` against a microsecond
    //    `passwordChangedAt`, and could not order the two when a token was
    //    minted in the change's own second. See `isStaleSessionVersion`.
    if (isStaleSessionVersion(payload.pv, passwordVersion)) {
      throw new UnauthorizedException(AuthMessages.SESSION_INVALIDATED);
    }

    // 5. CAPABILITIES. Roles/branch/permissions come from the DATABASE, never
    //    from the token, so a role or permission revocation takes effect on
    //    the next request rather than on the next token rotation. A principal
    //    holding only built-in roles costs no extra query — see
    //    `PermissionService.resolveEffective`.
    const permissions = await this.permissionService.resolveEffective(
      user.roles ?? [],
    );

    return {
      sub: user.id,
      identifier: user.identifier,
      roles: user.roles.map((r) => r.name as UserRoleEnum),
      branch: user.branchId ?? null,
      audience: payload.aud,
      permissions,
      // Enforced by `JwtAuthGuard`, which can see the route and therefore
      // knows whether this one is reachable while the flag is set. The
      // strategy is a singleton and cannot.
      mustChangePassword,
    };
  }
}
