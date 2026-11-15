import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';

import { AuthMessages } from 'src/common/constants/auth.messages';
import { RedisService } from 'src/database/redis.service';
import { OtpChallenge } from '../entities/otp-challenge.entity';
import { OtpSender } from './otp-sender';
import {
  OTP_CODE_LENGTH,
  OTP_IP_WINDOW_SECONDS,
  OTP_MAX_SENDS_PER_IP,
  OTP_MAX_SENDS_PER_MOBILE,
  OTP_MAX_VERIFY_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_SEND_WINDOW_SECONDS,
  OTP_TTL_SECONDS,
  normalizeMobile,
} from '../otp.policy';

/** Machine-readable `error` codes. Stable contract — clients switch on these. */
export const OTP_ERROR_COOLDOWN = 'OTP_COOLDOWN';
export const OTP_ERROR_RATE_LIMITED = 'OTP_SEND_RATE_LIMITED';
export const OTP_ERROR_INVALID = 'OTP_INVALID';

interface IssuedRow {
  id: number;
  expiresAt: Date;
  sendCount: number;
}

interface RefusalRow {
  cooldownSeconds: number;
  windowSeconds: number;
}

interface ConsumeRow {
  consumedAt: Date | null;
}

/**
 * ===========================================================================
 * OtpService — issuing and consuming one-time codes safely
 * ===========================================================================
 *
 * THE CONTROLS, AND THE PRIMITIVE EACH ONE RESTS ON
 * -------------------------------------------------
 *  cooldown (per mobile)     the `WHERE "resendAvailableAt" <= now()` clause of
 *                            the upsert. Not a read-then-check: the check is
 *                            part of the writing statement, so two concurrent
 *                            sends cannot both pass it.
 *  rate limit (per mobile)   the `sendCount`/`windowStartedAt` pair in the same
 *                            statement. A fixed window that rolls over when it
 *                            has elapsed, evaluated with the DATABASE's clock.
 *  rate limit (per IP)       a Redis counter with a real TTL
 *                            (`RedisService.incrWithExpiry`). Redis is the
 *                            right home for this one and the wrong home for
 *                            everything else: it is a cheap, shared, expiring
 *                            counter that nothing durable depends on.
 *  bounded attempts          `WHERE "attempts" < "maxAttempts"` inside the
 *                            counting UPDATE, plus the CHECK constraint
 *                            `ck_otp_challenges_attempts` as a structural
 *                            backstop.
 *  expiry                    `"expiresAt" > now()` inside the same UPDATE, so
 *                            an expired code follows the identical code path to
 *                            a wrong one.
 *  one-time consumption      `"consumedAt" IS NULL` in that UPDATE's WHERE, and
 *                            `"consumedAt" = now()` in its SET. One statement
 *                            both consumes and reports whether it consumed.
 *
 * NO USER ENUMERATION
 * -------------------
 * `issue()` NEVER LOOKS UP A USER. There is nothing for it to look one up for
 * any more — the account is created on first successful verification — so the
 * response cannot depend on whether the number is registered, by construction
 * rather than by remembering to keep two branches in step.
 *
 * `consume()` collapses "no challenge", "wrong code", "expired code" and
 * "attempt bound exhausted" into one identical 401. Note what that costs and
 * why it is still right: the client cannot be told "you have used all your
 * attempts, request a new code". Telling it would reveal to a third party
 * hammering a number that a challenge exists for it, i.e. that somebody is
 * mid-login. The UI answer is to offer "resend code" after ANY verification
 * failure, which is good UX regardless.
 *
 * WHAT IS NOT COVERED HERE
 * ------------------------
 * `"codeHash" = $2` is a plain SQL comparison, not a constant-time one. That is
 * deliberate and safe: the compared value is an HMAC-SHA256 DIGEST, not the
 * secret. An attacker submits a code, never a hash, and cannot steer the digest
 * — so there is no prefix to walk, and the bound of five attempts is the real
 * control. (`AuthService.otpCompare`'s `timingSafeEqual` guarded a comparison
 * with the same property.)
 */
@Injectable()
export class OtpService {
  constructor(
    @InjectRepository(OtpChallenge)
    private readonly challenges: Repository<OtpChallenge>,
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    private readonly sender: OtpSender,
  ) {}

  // =========================================================================
  // issue
  // =========================================================================

  /**
   * Issues a code for `rawMobile` and hands it to `OtpSender`.
   *
   * Returns nothing on success — and returns exactly the same nothing whether
   * or not the number belongs to an existing user.
   *
   * Throws 429 with `error: OTP_COOLDOWN` or `OTP_SEND_RATE_LIMITED` and a
   * `retryAfterSeconds` detail when a control refuses. Neither refusal depends
   * on user existence.
   *
   * @param clientIp the DIRECT socket peer. See `StorefrontOtpController` for
   *   why no forwarded header is believed and what has to be configured before
   *   one may be.
   */
  async issue(rawMobile: string, clientIp: string): Promise<void> {
    const mobile = this.requireNormalized(rawMobile);

    // Per-IP first, and counted for EVERY call including the ones the
    // per-mobile controls go on to refuse. An attacker probing many numbers
    // from one host should spend their own budget doing it.
    await this.enforceIpQuota(clientIp);

    // Generated BEFORE the write because its hash is part of the row; if the
    // upsert refuses, this code is discarded and never delivered.
    const code = this.generateCode();

    // No CTE wrapper needed here (unlike `consume()` below): PostgreSQL reports
    // the command tag of `INSERT ... ON CONFLICT DO UPDATE` as INSERT, so
    // TypeORM returns `raw.rows` and not the `[rows, rowCount]` pair it returns
    // for a bare UPDATE.
    const issued = await this.challenges.query<IssuedRow[]>(
      `INSERT INTO "otp_challenges" (
         "mobile", "codeHash", "attempts", "maxAttempts", "sendCount",
         "windowStartedAt", "resendAvailableAt", "expiresAt", "consumedAt",
         "createdAt", "updatedAt"
       ) VALUES (
         $1, $2, 0, $3::int, 1,
         now(),
         now() + interval '1 second' * $4::int,
         now() + interval '1 second' * $5::int,
         NULL, now(), now()
       )
       ON CONFLICT ("mobile") DO UPDATE SET
         "codeHash"          = EXCLUDED."codeHash",
         "attempts"          = 0,
         "maxAttempts"       = EXCLUDED."maxAttempts",
         "resendAvailableAt" = EXCLUDED."resendAvailableAt",
         "expiresAt"         = EXCLUDED."expiresAt",
         "consumedAt"        = NULL,
         "windowStartedAt"   = CASE
             WHEN "otp_challenges"."windowStartedAt"
                    <= now() - interval '1 second' * $6::int
             THEN now() ELSE "otp_challenges"."windowStartedAt" END,
         "sendCount"         = CASE
             WHEN "otp_challenges"."windowStartedAt"
                    <= now() - interval '1 second' * $6::int
             THEN 1 ELSE "otp_challenges"."sendCount" + 1 END,
         "updatedAt"         = now()
       WHERE "otp_challenges"."resendAvailableAt" <= now()
         AND (
           "otp_challenges"."windowStartedAt"
             <= now() - interval '1 second' * $6::int
           OR "otp_challenges"."sendCount" < $7::int
         )
       RETURNING "id", "expiresAt", "sendCount"`,
      [
        mobile,
        this.hashCode(mobile, code),
        OTP_MAX_VERIFY_ATTEMPTS,
        OTP_RESEND_COOLDOWN_SECONDS,
        OTP_TTL_SECONDS,
        OTP_SEND_WINDOW_SECONDS,
        OTP_MAX_SENDS_PER_MOBILE,
      ],
    );

    // No row means the guarded DO UPDATE declined: either the cooldown has not
    // elapsed or this hour's budget for the number is spent. Which one it was
    // is read back afterwards, purely to build an accurate `retryAfterSeconds`
    // — the refusal itself was already decided, atomically, above.
    if (issued.length === 0) {
      throw await this.buildSendRefusal(mobile);
    }

    // The single exit path for the plaintext code. Nothing else in this class
    // touches it after this line, and it is never logged.
    await this.sender.send(mobile, code);
  }

  /**
   * Builds the 429 for a send the guarded upsert already refused.
   *
   * This read happens AFTER the decision, never as part of it: the refusal was
   * decided atomically inside the upsert's WHERE clause. All this does is work
   * out an honest `retryAfterSeconds` to put in the body, so a client can show
   * a countdown instead of retrying blindly.
   */
  private async buildSendRefusal(mobile: string): Promise<HttpException> {
    const [refusal] = await this.challenges.query<RefusalRow[]>(
      `SELECT
         GREATEST(0, CEIL(EXTRACT(EPOCH FROM ("resendAvailableAt" - now()))))::int
           AS "cooldownSeconds",
         GREATEST(0, CEIL(EXTRACT(EPOCH FROM (
           "windowStartedAt" + interval '1 second' * $2::int - now()
         ))))::int AS "windowSeconds"
       FROM "otp_challenges" WHERE "mobile" = $1`,
      [mobile, OTP_SEND_WINDOW_SECONDS],
    );

    // The row cannot have vanished (rows are never deleted), but a defensive
    // fallback beats a 500 on an auth endpoint.
    if (!refusal) {
      return this.tooManyRequests(
        OTP_ERROR_RATE_LIMITED,
        AuthMessages.OTP_RATE_LIMITED,
        OTP_RESEND_COOLDOWN_SECONDS,
      );
    }

    if (refusal.cooldownSeconds > 0) {
      return this.tooManyRequests(
        OTP_ERROR_COOLDOWN,
        AuthMessages.OTP_COOLDOWN,
        refusal.cooldownSeconds,
      );
    }

    return this.tooManyRequests(
      OTP_ERROR_RATE_LIMITED,
      AuthMessages.OTP_RATE_LIMITED,
      Math.max(refusal.windowSeconds, 1),
    );
  }

  /**
   * Per-IP send budget.
   *
   * REDIS, WITH A REAL TTL. `RedisService.incr` sets no expiry, so a counter
   * built on it would never reset and would eventually lock a whole household
   * out for ever; `incrWithExpiry` stamps the TTL on the first increment and
   * repairs a counter that has somehow lost one.
   *
   * The window is FIXED, not sliding: the TTL is not pushed forward by later
   * requests, so a legitimate client that trips the limit is unblocked within
   * the hour instead of being held for as long as it keeps trying.
   */
  private async enforceIpQuota(clientIp: string): Promise<void> {
    const { count, ttlSeconds } = await this.redisService.incrWithExpiry(
      `otp:send:ip:${clientIp}`,
      OTP_IP_WINDOW_SECONDS,
    );

    if (count > OTP_MAX_SENDS_PER_IP) {
      throw this.tooManyRequests(
        OTP_ERROR_RATE_LIMITED,
        AuthMessages.OTP_RATE_LIMITED,
        Math.max(ttlSeconds, 1),
      );
    }
  }

  // =========================================================================
  // consume
  // =========================================================================

  /**
   * Verifies `code` against the live challenge for `rawMobile` and consumes it.
   *
   * Returns the NORMALIZED mobile number on success — the caller uses exactly
   * that string to find or create the user, so the account can never be keyed
   * by a different spelling than the challenge was.
   *
   * Throws an identical 401 (`error: OTP_INVALID`) for every failure mode: no
   * challenge, wrong code, expired code, or attempt bound reached.
   */
  async consume(rawMobile: string, code: string): Promise<string> {
    const mobile = normalizeMobile(rawMobile);
    // Unreachable through the DTO (which validates the normalized form), but
    // if it ever is reached it must look like every other failure rather than
    // like a 400 that distinguishes itself.
    if (!mobile) throw this.invalidOtp();

    // ONE STATEMENT. It counts the attempt, decides the match, and consumes the
    // code, under a single row lock:
    //
    //  - `"consumedAt" IS NULL` is the replay guard. Two simultaneous replays
    //    of a correct code serialise on the row; the loser re-evaluates the
    //    WHERE against the committed row, sees a non-null `consumedAt`, and
    //    updates nothing.
    //  - `"attempts" < "maxAttempts"` is the guessing bound. N parallel wrong
    //    guesses serialise the same way, so exactly `maxAttempts` of them ever
    //    increment the counter regardless of how many arrive at once.
    //  - `"expiresAt" > now()` makes expiry indistinguishable from a wrong
    //    code: same statement, same branch, same response.
    //
    // The attempt is counted even when the code is right, so a successful
    // verification is visible in the row as `attempts = 1`.
    // The UPDATE is wrapped in a data-modifying CTE for one unglamorous
    // reason: TypeORM's `query()` returns `raw.rows` for a SELECT or an INSERT
    // but `[rows, rowCount]` for an UPDATE
    // (typeorm/driver/postgres/PostgresQueryRunner: `case "UPDATE": result.raw
    // = [raw.rows, raw.rowCount]`). Reading `rows[0].consumedAt` off that shape
    // silently yields `undefined`, i.e. EVERY CORRECT CODE WOULD BE REJECTED —
    // caught by the integration tests below, but only because they assert the
    // success path and the database row rather than just the failure statuses.
    //
    // A data-modifying CTE is still ONE statement with one snapshot and one row
    // lock, so every atomicity property above is preserved; the outer SELECT
    // only fixes the result shape.
    const rows = await this.challenges.query<ConsumeRow[]>(
      `WITH consumed AS (
         UPDATE "otp_challenges" SET
           "attempts"   = "attempts" + 1,
           "consumedAt" = CASE
               WHEN "codeHash" = $2 AND "expiresAt" > now() THEN now()
               ELSE NULL END,
           "updatedAt"  = now()
         WHERE "mobile" = $1
           AND "consumedAt" IS NULL
           AND "attempts" < "maxAttempts"
         RETURNING "consumedAt"
       )
       SELECT "consumedAt" FROM consumed`,
      [mobile, this.hashCode(mobile, code)],
    );

    // No row: no challenge for this number, or it was already consumed, or its
    // attempt budget is gone.
    if (rows.length === 0) throw this.invalidOtp();
    // A row, but nothing consumed: wrong code, or expired.
    if (!rows[0].consumedAt) throw this.invalidOtp();

    return mobile;
  }

  // =========================================================================
  // helpers
  // =========================================================================

  /**
   * A uniformly random code over the FULL `10^OTP_CODE_LENGTH` space.
   *
   * Note `crypto.randomInt(100000, 999999)` — the previous call — was wrong
   * twice over: its upper bound is EXCLUSIVE, so `999999` was never issued, and
   * excluding every code with a leading zero threw away 10% of the keyspace for
   * no reason. Both shrink the space an attacker has to search.
   */
  private generateCode(): string {
    const space = 10 ** OTP_CODE_LENGTH;
    return String(crypto.randomInt(0, space)).padStart(OTP_CODE_LENGTH, '0');
  }

  /**
   * HMAC-SHA256 over `<mobile>:<code>`, hex.
   *
   * The mobile number is part of the HMAC input, so a hash captured for one
   * number cannot be replayed against another even if the same code is issued.
   * Same construction and same secret as the flow this replaces, so no
   * in-flight code is invalidated by the change.
   */
  private hashCode(mobile: string, code: string): string {
    const secret = this.configService.getOrThrow<string>('OTP_HMAC_SECRET');
    return crypto
      .createHmac('sha256', secret)
      .update(`${mobile}:${code}`)
      .digest('hex');
  }

  private requireNormalized(rawMobile: string): string {
    const mobile = normalizeMobile(rawMobile);
    if (!mobile) throw new BadRequestException(AuthMessages.INVALID_MOBILE);
    return mobile;
  }

  /** The one and only shape of a verification failure. */
  private invalidOtp(): UnauthorizedException {
    return new UnauthorizedException({
      message: AuthMessages.INVALID_OTP,
      error: OTP_ERROR_INVALID,
    });
  }

  /**
   * `retryAfterSeconds` lands under `details` in the error envelope (see
   * `GlobalExceptionFilter`). No `Retry-After` HEADER is set: the refusal is
   * thrown from the service, which has no `Response` to write to, and adding
   * one would mean leaking the response object into every rate-limited path.
   * Flagged for the contract doc so the frontend reads the body field.
   */
  private tooManyRequests(
    code: string,
    message: string,
    retryAfterSeconds: number,
  ): HttpException {
    return new HttpException(
      { message, error: code, retryAfterSeconds },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
