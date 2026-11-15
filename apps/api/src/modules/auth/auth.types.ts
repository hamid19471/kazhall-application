import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { SessionAudience } from './audience';

/**
 * TOKEN PURPOSE (`typ`).
 *
 * Access and refresh tokens are signed with the SAME secret, so without a
 * purpose claim they are interchangeable: a stolen refresh token — which is
 * long-lived and, unlike an access token, is meant to be usable exactly once
 * against exactly one endpoint — authenticated as an access token against every
 * protected route. That was a live defect.
 *
 * Every issued token now carries `typ`, and every verifier asserts it:
 *   - JwtStrategy.validate        requires 'access'
 *   - AuthService.refreshToken    requires 'refresh'
 *   - RealtimeGateway handshake   requires 'access'
 *
 * Tokens minted before this change carry no `typ` and are rejected everywhere,
 * which forces one clean re-login rather than leaving a bypass open.
 */
export const TOKEN_TYPE_ACCESS = 'access';
export const TOKEN_TYPE_REFRESH = 'refresh';

export type TokenType = typeof TOKEN_TYPE_ACCESS | typeof TOKEN_TYPE_REFRESH;

interface BaseJwtClaims {
  sub: number;
  identifier: string;
  roles: UserRoleEnum[];
  branch: number | null;
  typ: TokenType;
  /**
   * WHICH APPLICATION THIS SESSION BELONGS TO.
   *
   * Cookies are scoped by host, not by port, so the storefront, the admin
   * console and the till all received the same cookie and each accepted the
   * others' sessions. `aud` is the signed half of the fix — the cookie name is
   * the other half, and both are checked, so renaming a cookie cannot smuggle a
   * token into a surface it was not issued for. See `audience.ts`.
   */
  aud: SessionAudience;
  /**
   * PASSWORD/SESSION VERSION — `users."passwordVersion"` as it stood when this
   * token was minted (migration 0027).
   *
   * THE WHOLE INVALIDATION CONTRACT IS THIS ONE CLAIM. A verifier accepts the
   * token only while `pv` still EQUALS the column; changing a password
   * increments the column, so every token carrying the old value dies at the
   * very next request and a token minted afterwards is accepted immediately.
   *
   * It replaces the `iat`-versus-`passwordChangedAt` comparison, which could
   * not order a token minted in the SAME SECOND as a password change: `iat` is
   * whole seconds and the column is microseconds, so the information needed to
   * order them had already been discarded. An integer compared for equality
   * has no such tie to break.
   *
   * Optional in the TYPE only because a token signed before migration 0027
   * genuinely does not carry it. Such a token is REFUSED — see
   * {@link isStaleSessionVersion}, which fails closed on an absent claim.
   */
  pv?: number;
  /**
   * Seconds since epoch, set by jsonwebtoken.
   *
   * NO LONGER AN AUTHORISATION INPUT. It is still emitted (it is part of what
   * `jsonwebtoken` signs) and is still useful in a log, but nothing decides
   * whether a session is alive by looking at it. See `pv` above for why.
   */
  iat?: number;
  exp?: number;
}

export interface AccessTokenPayload extends BaseJwtClaims {
  typ: typeof TOKEN_TYPE_ACCESS;
}

export interface RefreshTokenPayload extends BaseJwtClaims {
  typ: typeof TOKEN_TYPE_REFRESH;
  /** Primary key of the refresh_tokens row backing this token. */
  jti: string;
}

/** Shape attached to `req.user` by JwtStrategy.validate. */
export interface AuthenticatedUser {
  sub: number;
  identifier: string;
  roles: UserRoleEnum[];
  branch: number | null;
  /** The audience the presented cookie and its token both belong to. */
  audience: SessionAudience;
  /**
   * EFFECTIVE CAPABILITY CODES, expanded from the roles read out of the
   * database ON THIS REQUEST. Never a token claim, never anything the caller
   * sent. `PermissionsGuard` is the only thing that reads it for
   * authorisation; controllers may read it to shape a response, but must not
   * use it in place of a guard.
   */
  permissions: string[];
  /**
   * `users.mustChangePassword`. Enforced in `JwtAuthGuard`, which refuses
   * every route not marked `@AllowPasswordChangePending()` while it is set.
   */
  mustChangePassword: boolean;
}

/**
 * Lifecycle columns added by migration 0006 (`users.deactivatedAt`,
 * `users.passwordChangedAt`).
 *
 * The COLUMNS are owned by workstream A (migrations); the ENTITY FIELDS are
 * owned by workstream C. Until C declares them on `User`, auth reads them
 * through this structural view so the code compiles today and starts working
 * the moment the fields land — no coordination window where auth is broken.
 */
export interface UserLifecycleFields {
  deactivatedAt?: Date | string | null;
  /**
   * Migration 0006. STILL WRITTEN AND STILL DISPLAYED — the admin user screen
   * shows "password last changed" and an operator needs that — but NO LONGER
   * AN AUTHORISATION INPUT. `passwordVersion` decides whether a session is
   * alive; this column only records when it last happened.
   */
  passwordChangedAt?: Date | string | null;
  /** Migration 0023. Read structurally for the same reason as the two above. */
  mustChangePassword?: boolean | null;
  /** Migration 0027. The session epoch. See {@link isStaleSessionVersion}. */
  passwordVersion?: number | string | null;
}

export function readLifecycle(user: object): {
  deactivatedAt: Date | null;
  passwordChangedAt: Date | null;
  mustChangePassword: boolean;
  passwordVersion: number | null;
} {
  const raw = user as UserLifecycleFields;
  return {
    deactivatedAt: toDateOrNull(raw.deactivatedAt),
    passwordChangedAt: toDateOrNull(raw.passwordChangedAt),
    // Defaults to FALSE, not true: a row loaded without the column (a partial
    // select, a pre-0023 fixture) must not lock its owner out of the system.
    mustChangePassword: raw.mustChangePassword === true,
    // Defaults to NULL, not to a number. A row loaded without the column
    // cannot state its session epoch, and `isStaleSessionVersion` treats "no
    // stated epoch" as stale — the opposite default from `mustChangePassword`,
    // because here the fail-closed direction is the safe one.
    passwordVersion: toVersionOrNull(raw.passwordVersion),
  };
}

/**
 * `users."passwordVersion"` is an `integer` column, but a row may arrive
 * through a raw query where node-postgres has typed it as a string, so both
 * are accepted and anything else is `null` (i.e. stale).
 */
function toVersionOrNull(
  value: number | string | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * ===========================================================================
 * IS THIS TOKEN FROM A PASSWORD EPOCH THAT HAS ENDED?
 * ===========================================================================
 *
 * THE ONE QUESTION every session check now asks, in every audience, over HTTP
 * and over the websocket alike. It takes no clock, no timestamp and no
 * tolerance, and it is a plain equality.
 *
 * WHAT IT REPLACED, AND WHY THAT HAD TO GO. The previous check compared a
 * JWT's `iat` with `users."passwordChangedAt"`. `iat` is in WHOLE SECONDS and
 * the column has microsecond precision, so a token minted in the SAME SECOND
 * as a password change could not be placed on either side of it — the
 * information needed to do so had been discarded by the rounding. The code
 * resolved that tie by failing closed, which was the right choice of two wrong
 * answers: it never let a compromised session survive, but it DID reject a
 * legitimate login that happened to land in the change's own second, once,
 * after which a retry succeeded. A user saw a password change that looked like
 * it had failed and then worked.
 *
 * No comparison could have fixed it, because the ambiguity was in the data.
 * `passwordVersion` removes the data that was ambiguous.
 *
 * THE THREE REJECTIONS, and why each is the safe direction:
 *
 *  1. NO CLAIM ON THE TOKEN. A token signed before migration 0027 carries no
 *     `pv`. It cannot be placed in the version sequence at all, and "predates
 *     the mechanism" is not a reason to trust it. Rejected.
 *  2. NO VERSION ON THE ROW. A user row loaded without the column (a partial
 *     projection, a fixture built against an older schema) cannot state its
 *     current epoch. A verifier that cannot establish the epoch must not admit
 *     the session. Rejected.
 *  3. THEY DIFFER. The ordinary case: the password changed, the column moved,
 *     this token is from before. Rejected.
 *
 * EQUALITY, NOT `<`. A token whose `pv` is somehow AHEAD of the row is just as
 * unexplainable as one behind it — it would mean a token minted from a version
 * the database has since gone backwards from. There is no benign reading of
 * that, so it is refused too.
 */
export function isStaleSessionVersion(
  tokenVersion: unknown,
  currentVersion: number | null,
): boolean {
  if (currentVersion === null) return true;
  if (typeof tokenVersion !== 'number' || !Number.isInteger(tokenVersion)) {
    return true;
  }
  return tokenVersion !== currentVersion;
}

function toDateOrNull(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
