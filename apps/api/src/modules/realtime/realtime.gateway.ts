import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import UserRoleEnum from '../user/enums/user-role.enum';
import {
  AUDIENCE_COOKIES,
  isSessionAudience,
  SessionAudience,
} from '../auth/audience';
import { User } from '../user/entities/user.entity';
import {
  AccessTokenPayload,
  isStaleSessionVersion,
  readLifecycle,
  TOKEN_TYPE_ACCESS,
} from '../auth/auth.types';
import { parseCorsOrigins } from 'src/configs/env.validation';
import { isEligibleForAudience } from '../auth/audience';
import { PermissionService } from '../auth/permissions/permission.service';
import { CatalogCacheService } from 'src/database/cache.service';

/**
 * Minimal RFC-6265 `Cookie:` header parser.
 *
 * Replaces `require('cookie')`. The `cookie` package is NOT a dependency of
 * this project — `require.resolve('cookie')` fails — so the previous
 * implementation threw on the very first line of every handshake and the catch
 * block silently disconnected every client. The gateway was 100% dead.
 *
 * A cookie header is `name=value; name=value`. Values may be quoted and are
 * percent-encoded; names are never encoded. Later duplicates do not override
 * earlier ones, matching the `cookie` package's behaviour.
 */
export function parseCookieHeader(
  header: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;

    const name = part.slice(0, eq).trim();
    if (!name || Object.prototype.hasOwnProperty.call(out, name)) continue;

    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value; // malformed %-escape: keep the raw value
    }
  }
  return out;
}

/**
 * ===========================================================================
 * WHY THERE ARE TWO KINDS OF SOCKET
 * ===========================================================================
 *
 * The gateway used to refuse every unauthenticated handshake, which was the
 * right default and the wrong outcome: a shop's catalogue and product pages are
 * PUBLIC, so the customers who most need to see "that just sold out" — the ones
 * who have not signed in — were the only ones who could not. They got no
 * socket, and (because an anonymous session probe signs the client out) no
 * polling either.
 *
 * So an anonymous storefront socket is now a first-class, deliberately tiny
 * thing. It carries no principal, joins exactly one room, and receives exactly
 * one kind of frame. Modelling it as a DISCRIMINATED UNION rather than as an
 * authenticated socket with nullable fields is the point: every place that
 * reads a user id, a role, a branch or a token has to say what it does when
 * there is no principal, and the compiler will not let it forget.
 */
export interface AuthenticatedSocketData {
  kind: 'authenticated';
  userId: number;
  roles: UserRoleEnum[];
  /**
   * Effective permission codes, resolved from the DATABASE at handshake and
   * again on every sweep.
   *
   * The token's role list is deliberately not the authority here. A role
   * changed, deactivated, or stripped of a grant after the token was minted
   * must change what the socket may receive, and a claim minted minutes ago
   * cannot know that.
   */
  permissions: string[];
  branchId: number | null;
  /** Which application opened this socket. Decides the rooms it may join. */
  audience: SessionAudience;
  /** Raw access token, kept so the periodic sweep can re-verify it. */
  token: string;
  /** Token expiry in ms since epoch. */
  expiresAtMs: number;
  /**
   * The token's `pv` claim — the session epoch it was minted under.
   *
   * A socket OUTLIVES the request that opened it, so "kill every session NOW"
   * has to reach sockets that are already open and not merely the next
   * handshake. The periodic sweep re-reads `users."passwordVersion"` and
   * disconnects any socket whose stored epoch no longer matches.
   *
   * It replaced `issuedAtSeconds`, which was compared against
   * `users."passwordChangedAt"`: a whole-second value against a microsecond
   * one, which could not be ordered when a socket was opened in the change's
   * own second.
   */
  sessionVersion: number;
}

/**
 * An anonymous PUBLIC storefront socket. No principal, and therefore no user
 * room, no branch, no roles, no token and nothing to re-validate.
 */
export interface AnonymousSocketData {
  kind: 'anonymous';
  /** Anonymous mode exists for exactly one surface. */
  audience: 'storefront';
}

export type SocketData = AuthenticatedSocketData | AnonymousSocketData;

/**
 * The principal as the DATABASE currently describes it — the authority for
 * every authorization decision the gateway makes, at handshake and on every
 * sweep. Never assembled from token claims.
 */
export interface LoadedPrincipal {
  id: number;
  roles: UserRoleEnum[];
  permissions: string[];
  branchId: number | null;
  mustChangePassword: boolean;
  passwordVersion: number | null;
}

export type AuthenticatedSocket = Socket<
  Record<string, never>,
  Record<string, never>,
  Record<string, never>,
  SocketData
>;

// ==========================================================================
// ROOMS
// ==========================================================================

/**
 * PUBLIC. Every storefront socket joins it — anonymous and signed-in alike —
 * and it carries availability INVALIDATIONS and nothing else.
 *
 * Its existence is what let the last global broadcast be removed. Availability
 * used to go out via `server.emit(...)`, i.e. to every connected socket
 * including every till and admin console. A room means the frame reaches the
 * audience it was written for, and the "is this payload safe for everyone?"
 * question has exactly one answer instead of depending on who happened to be
 * connected.
 */
export const ROOM_PUBLIC_AVAILABILITY = 'public:availability';

/**
 * STAFF availability invalidation — still no quantities.
 *
 * Separate from the public room because the two channels become stale for
 * DIFFERENT reasons. A basket reservation changes what the storefront may sell
 * and changes nothing the till may sell (POS outranks basket holds), so a
 * reservation frame must not reach this room: it would send every till in the
 * shop to re-read availability for a number that did not move.
 *
 * Not branch-scoped, deliberately. `product_variants.stock` is one number for
 * the whole business, so availability is not a branch-partitioned fact — and
 * scoping it by branch is precisely what made the till blind to administrator
 * corrections, which carry no branch and so reached the admin room only.
 */
export const ROOM_STAFF_AVAILABILITY = 'staff:availability';

/**
 * EXACT stock counts and order lifecycle — the room formerly called `admins`.
 *
 * ## Why it is renamed
 *
 * It was named for a group and gated on a ROLE (`super_admin`) while the rest
 * of the application decides admin-console access by PERMISSION
 * (`admin.access`). Two meanings, one name: a reader could not tell whether
 * "admins" meant "the admin console" (in which case a delegated administrator
 * holding `admin.access` + `orders.read` belonged in it) or "our most
 * privileged users" (in which case they did not).
 *
 * ## Which meaning was chosen, and why
 *
 * The name now states the rule: this room is for a SUPER ADMIN on the admin
 * surface. That is deliberate rather than conservative. Its frames carry exact
 * physical stock, order totals, and the identity of the cashier who rang a
 * sale — the union of what several different capabilities protect on the HTTP
 * side. A single room cannot be "authorized consistently" with any one
 * permission while carrying the data of several, so it is authorized by the
 * only principal that holds them all.
 *
 * A delegated administrator is not left with a silently degraded console: no
 * admin screen consumes realtime at all today, which is why `apps/web`'s admin
 * tree no longer opens a socket. When a screen does start consuming events,
 * the right move is a new content-scoped, permission-gated room beside this
 * one — the shape {@link ROOM_STAFF_AVAILABILITY} already demonstrates — and
 * not widening this one.
 */
export const ROOM_SUPER_ADMIN = 'staff:super-admin';

export const branchRoom = (branchId: number | string) => `branch:${branchId}`;
export const userRoom = (userId: number | string) => `user:${userId}`;

/**
 * The two facts about a socket that are safe to name in an operational log.
 *
 * Both read `socket.data`, which the gateway populated itself at handshake
 * time — never `socket.handshake`, which carries the cookie header. An
 * anonymous socket has no principal, so `userIdOf` is null for it and
 * `audienceOf` says so in words rather than reporting `storefront` and
 * implying a signed-in customer.
 */
const userIdOf = (socket: { data?: SocketData }): number | null =>
  socket.data?.kind === 'authenticated' ? socket.data.userId : null;

const audienceOf = (socket: {
  data?: SocketData;
}): SessionAudience | 'anonymous' | null => {
  const data = socket.data;
  if (data === undefined) return null;
  return data.kind === 'anonymous' ? 'anonymous' : data.audience;
};

/**
 * STAFF-ONLY event carrying EXACT physical stock. Exact quantities are
 * `sale`/`super_admin` data everywhere else in this API (`GET
 * /inventory/lookup` and `GET /inventory/availability` are both role-gated), so
 * the live channel must not be the one place a retail customer can read them.
 */
export const STOCK_EVENT = 'stock:updated';

/**
 * PUBLIC availability INVALIDATION. Safe for an anonymous visitor.
 *
 * Renamed from `availability:updated`, and the rename is the contract change.
 * The old event carried `inStock: boolean`, which could not be correct for
 * both audiences at once: storefront sellability subtracts basket reservations
 * and POS sellability does not, so one boolean meant different things to the
 * two clients reading it — and five different emit sites derived it five
 * different ways, two of them ignoring whether the variant was even active.
 *
 * This event states only WHAT WENT STALE. The client refetches an authoritative
 * endpoint; nothing on the frame is ever rendered.
 */
export const AVAILABILITY_EVENT = 'availability:invalidated';

/**
 * STAFF availability invalidation. Same shape, different room and a narrower
 * trigger: it fires only for changes that can move `availableForPos`.
 *
 * A basket reservation is the case that matters. It changes what the storefront
 * may sell and changes nothing the till may sell, so it publishes the public
 * event and NOT this one.
 */
export const POS_AVAILABILITY_EVENT = 'pos:availability:invalidated';

/**
 * The complete payload of `availability:updated`. It is deliberately as small
 * as it can be while still being useful to a storefront.
 *
 *  - `variantId` -- which SKU changed.
 *  - `inStock`   -- a BOOLEAN, never a count.
 *
 * `inStock: false` is authoritative in one direction only, and that asymmetry
 * is the point: it is derived from the COMMITTED physical `balanceAfter`
 * returned by the R2 conditional UPDATE, so zero physical units really does
 * mean nothing can be sold. `inStock: true` means only that physical units
 * exist -- some or all of them may be held by other customers' baskets or by
 * paid orders -- so a client must still read `GET /inventory/availability` (or
 * re-read the catalogue) before promising a sale. It is an advisory hint to
 * refresh, not a quantity and not a reservation.
 *
 * NO "low stock" BAND IS EMITTED. A threshold ("only 3 left!") is a merchandising
 * decision the owner has not made, and inventing one here would both leak a
 * near-exact quantity and smuggle a business rule into a notification channel.
 */
/**
 * WHY something went stale. A coarse, non-sensitive category — never a
 * quantity, never an identity.
 *
 * It exists so a client can decide how hard to work: a `catalogue` change may
 * warrant re-reading a product document, while a `reservation` change on a
 * variant the page is not showing can be ignored outright. Four values, chosen
 * to be the coarsest set that still supports that decision.
 */
export const AVAILABILITY_REASONS = [
  /** Physical stock moved: a sale, an adjustment, a fulfilment, a reversal. */
  'stock',
  /** A basket hold was taken, changed, released or expired. Storefront only. */
  'reservation',
  /** An order allocation was created or released (checkout, cancellation). */
  'allocation',
  /** The variant's catalogue state changed: created, retired, reinstated. */
  'catalogue',
] as const;

export type AvailabilityReason = (typeof AVAILABILITY_REASONS)[number];

/**
 * The complete payload of an availability invalidation, public or staff.
 *
 * It is an ADVISORY POINTER, not a state update:
 *
 *  - `variantId`  — which SKU went stale.
 *  - `productId`  — so a listing page can reconcile exactly one product
 *                   instead of refetching its whole current page. `GET
 *                   /products` returns no variant ids, so without this the
 *                   listing genuinely cannot tell whether a frame concerns
 *                   anything it is showing.
 *  - `reason`     — the coarse category above.
 *
 * NO quantity, NO boolean, NO customer, NO basket, NO cashier, NO branch, NO
 * order. `realtime.gateway.spec.ts` asserts the key set, so adding a field
 * fails a test rather than quietly widening what an anonymous socket learns.
 *
 * The removed `inStock` is worth naming: it was the field that made this event
 * ambiguous, and its absence is what makes one frame safe to send to an
 * anonymous visitor and a till alike.
 */
export interface AvailabilityInvalidatedPayload {
  variantId: number;
  productId: number;
  reason: AvailabilityReason;
}

/**
 * Structured handshake/disconnect reason codes.
 *
 * Every rejection used to be an identical silent `disconnect(true)` from a bare
 * `catch {}` — in a file whose own history includes a gateway that was 100%
 * dead behind exactly that shape. Operations could not distinguish "bad
 * audience" from "no cookie" from "stale epoch" from "the database is down".
 *
 * These codes are logged and are what the tests assert on. They are
 * deliberately coarse and carry NO token, NO cookie and NO credential — a
 * rejection log line is not a place to put the thing that was rejected.
 */
export const REJECTION = {
  NO_AUDIENCE: 'no_audience_named',
  ANON_NOT_ALLOWED: 'anonymous_not_allowed_for_audience',
  MALFORMED_TOKEN: 'malformed_or_unverifiable_token',
  WRONG_TOKEN_TYPE: 'wrong_token_type',
  WRONG_AUDIENCE_CLAIM: 'token_audience_mismatch',
  UNKNOWN_OR_DEACTIVATED: 'unknown_or_deactivated_user',
  STALE_EPOCH: 'stale_password_epoch',
  MUST_CHANGE_PASSWORD: 'password_change_required',
  AUDIENCE_NOT_PERMITTED: 'audience_not_permitted',
  SESSION_EXPIRED: 'access_token_expired',
  INTERNAL: 'internal_error',
} as const;

export type RejectionCode = (typeof REJECTION)[keyof typeof REJECTION];

/** Thrown inside the handshake so the catch can log a category, not a mystery. */
export class HandshakeRejection extends Error {
  constructor(readonly code: RejectionCode) {
    super(code);
    this.name = 'HandshakeRejection';
  }
}

/** How often live connections are re-checked against the database. */
export const REVALIDATION_INTERVAL_MS = 60_000;

/**
 * The log event name operations alerts on.
 *
 * Stable and greppable: an authorization change that committed but could not
 * be pushed to the live sockets is a security-relevant condition, and the point
 * of a fixed event name is that a dashboard can count it without matching
 * English prose that may be reworded.
 */
export const RECONCILIATION_FAILURE_EVENT = 'realtime.reconciliation.failed';

/**
 * WHAT A RECONCILIATION FAILURE REPORTS.
 *
 * Emitted as `logger.error(JSON.stringify(payload))` so it is one line, parses
 * as JSON, and survives Nest's default text transport.
 *
 * WHAT IS DELIBERATELY ABSENT: the socket handshake, its headers, its cookies,
 * any access or refresh token, any password material. Nothing here is derived
 * from the request at all except the numeric user id and the audience name --
 * and `safeErrorText` is what guarantees the error string cannot smuggle any
 * of it back in.
 */
export interface ReconciliationFailure {
  event: typeof RECONCILIATION_FAILURE_EVENT;
  /** `user` = one principal was re-decided; `all` = the whole-node sweep. */
  scope: 'user' | 'all';
  /** `enumerate` = no socket could be inspected; `socket` = one socket failed. */
  stage: 'enumerate' | 'socket';
  /** The caller's reason string, e.g. `role permissions changed`. */
  reason: string;
  /** Present for `scope: 'user'` and for a per-socket failure. */
  userId: number | null;
  audience: SessionAudience | 'anonymous' | null;
  /** How many sockets the pass looked at. `0` when enumeration itself failed. */
  examined: number;
  /** How many failed in this pass. */
  failed: number;
  error: string;
  /**
   * THE MAXIMUM TEMPORARY EXPOSURE WINDOW, in milliseconds.
   *
   * An immediate push that fails is corrected by the periodic sweep, so a
   * socket can hold a withdrawn entitlement for at most one sweep interval
   * after the change commits. Reported with the failure so an operator reads
   * the blast radius without having to know the constant.
   */
  backstopWithinMs: number;
}

/**
 * Error text that is safe to log.
 *
 * Takes the error's class name and message, caps the length, and redacts the
 * two shapes that could carry a credential if an underlying library ever
 * echoed a request back inside an error: a JWT, and this application's cookie
 * names. A driver or adapter error is not expected to contain either -- the
 * redaction is here so that "no cookies, JWTs or secrets are logged" is
 * enforced by code rather than by assumption.
 */
export function safeErrorText(error: unknown): string {
  const raw =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : `NonError: ${String(error)}`;
  return raw
    .replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt]')
    .replace(/kz_[A-Za-z0-9_]*=[^;\s]+/g, '[cookie]')
    .slice(0, 300);
}

@WebSocketGateway({
  cors: {
    /**
     * Config-driven, not the hardcoded `https://test.ir` this used to be.
     *
     * The callback form is required: gateway decorator metadata is evaluated at
     * module LOAD time, before ConfigModule has validated and published the
     * environment, so the origin list has to be resolved per handshake instead
     * of once at import.
     */
    origin: (
      requestOrigin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // Same-origin / non-browser clients send no Origin header.
      if (!requestOrigin) return callback(null, true);
      const allowed = parseCorsOrigins(process.env.CORS_ORIGINS);
      callback(null, allowed.includes(requestOrigin));
    },
    credentials: true,
  },
})
export class RealtimeGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleDestroy
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(RealtimeGateway.name);
  private revalidationTimer: NodeJS.Timeout | null = null;
  /** The sweep currently in flight, so shutdown can await it. */
  private inFlightRevalidation: Promise<unknown> | null = null;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    /**
     * The gateway authorizes by CAPABILITY, so it needs the same expansion
     * HTTP uses. Injected rather than reimplemented: a second copy of "which
     * permissions does this role set grant?" is exactly how the socket drifted
     * from the HTTP model in the first place.
     */
    private readonly permissionService: PermissionService,
    /**
     * `CacheModule` is `@Global()`, so this needs no module import.
     *
     * It is here because invalidating the cached catalogue and telling clients
     * to refetch are two halves of ONE post-commit act, and splitting them
     * across call sites is how they get out of order. The public product list
     * is cached for 60 s and its "is anything buyable?" predicate is now
     * reservation-aware, so a basket hold that emitted a frame WITHOUT
     * dropping that cache would send every storefront to re-read a page the
     * cache would answer with the pre-reservation truth — a realtime channel
     * that looks broken while working perfectly.
     */
    private readonly catalogCache: CatalogCacheService,
  ) {}

  afterInit() {
    // A JWT is a snapshot. On an HTTP request that hardly matters — the next
    // request re-authenticates within milliseconds — but a websocket can stay
    // open for hours, so without this a deactivated employee keeps receiving
    // live order traffic until they close the tab.
    /*
     * NOT UNDER TEST. The sweep reads `users` and `roles` on the application's
     * own pool, un-awaited, at a fixed 60-second period — and the integration
     * harness TRUNCATEs both of those tables between tests. A specs file that
     * opens a socket (`auth-password-change`, `realtime-auth`) therefore had a
     * background reader landing on arbitrary test boundaries, which is a lock
     * collision nobody wrote and nobody could see.
     *
     * Specs that need the behaviour call `revalidateAll()` directly, which is
     * both deterministic and what `auth-password-change.int-spec.ts` already
     * does — so gating the TIMER costs no coverage. Same rule as the payment
     * sweepers and the reservation sweeper.
     */
    if (process.env.NODE_ENV === 'test') return;

    this.revalidationTimer = setInterval(() => {
      this.inFlightRevalidation = this.revalidateAll().catch((error) =>
        this.logger.warn(
          `session re-validation sweep failed: ${String(error)}`,
        ),
      );
    }, REVALIDATION_INTERVAL_MS);
    // Do not hold the event loop open (matters for tests and clean shutdown).
    this.revalidationTimer.unref?.();
  }

  /**
   * Stops the sweep AND WAITS FOR THE ONE ALREADY RUNNING.
   *
   * See the payment sweepers for the full reasoning: clearing the interval
   * leaves an in-flight pass querying a DataSource that is being destroyed,
   * and a lock it holds then outlives the application that owned it.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.revalidationTimer) {
      clearInterval(this.revalidationTimer);
      this.revalidationTimer = null;
    }
    const pass = this.inFlightRevalidation;
    this.inFlightRevalidation = null;
    if (pass) await pass;
  }

  /**
   * WHICH SESSION OPENS THE SOCKET.
   *
   * A browser signed into several surfaces sends every audience cookie on the
   * handshake, so "the access token" is not a well-defined thing to read here
   * any more than it is on an HTTP route. The client declares which application
   * is connecting via the `audience` handshake query; the cookie for exactly
   * that audience is read, and the signed `aud` claim must agree. The query
   * parameter therefore selects a cookie — it never grants anything, because a
   * caller who names an audience they hold no cookie for gets nothing.
   */
  private selectHandshakeSession(client: AuthenticatedSocket): {
    /** Absent means NO CREDENTIAL WAS SUPPLIED — never "a bad one". */
    token: string | undefined;
    audience: SessionAudience;
  } {
    const cookies = parseCookieHeader(client.handshake.headers.cookie);
    const requested = client.handshake.query?.audience;
    const audience = Array.isArray(requested) ? requested[0] : requested;

    if (!isSessionAudience(audience)) {
      throw new HandshakeRejection(REJECTION.NO_AUDIENCE);
    }
    /*
     * THE ABSENCE/INVALIDITY DISTINCTION IS THE WHOLE SECURITY BOUNDARY of
     * anonymous mode.
     *
     * A missing cookie means "this visitor is not signed in", and for the
     * storefront that is a legitimate state deserving a public socket. A
     * cookie that is PRESENT but malformed, expired, from an ended password
     * epoch or minted for another audience means something is wrong, and
     * silently downgrading it to an anonymous socket would turn every
     * authentication failure into a quiet success. So this returns `undefined`
     * only for the absent case, and every failure after this point rejects.
     */
    return { token: cookies[AUDIENCE_COOKIES[audience].access], audience };
  }

  async handleConnection(client: AuthenticatedSocket) {
    let audienceForLog: string | undefined;
    try {
      const { token, audience } = this.selectHandshakeSession(client);
      audienceForLog = audience;

      // ---- no credential supplied -------------------------------------
      if (token === undefined) {
        if (audience !== 'storefront') {
          // There is no such thing as an anonymous till or an anonymous
          // console: every frame those surfaces receive is staff data.
          throw new HandshakeRejection(REJECTION.ANON_NOT_ALLOWED);
        }
        client.data = { kind: 'anonymous', audience: 'storefront' };
        await client.join(ROOM_PUBLIC_AVAILABILITY);
        return;
      }

      // ---- a credential WAS supplied: it must be good ------------------
      let payload: AccessTokenPayload;
      try {
        payload = this.jwtService.verify<AccessTokenPayload>(token, {
          secret: this.configService.getOrThrow<string>('JWT_SECRET_KEY'),
        });
      } catch {
        // Deliberately NOT a downgrade to anonymous. See
        // `selectHandshakeSession`.
        throw new HandshakeRejection(REJECTION.MALFORMED_TOKEN);
      }

      // Same purpose check as JwtStrategy: a refresh token must not open a
      // live socket.
      if (payload.typ !== TOKEN_TYPE_ACCESS)
        throw new HandshakeRejection(REJECTION.WRONG_TOKEN_TYPE);

      // The claim must match the jar the token arrived in, exactly as on the
      // HTTP path. Without this a storefront cookie renamed by a hostile client
      // would join till rooms.
      if (payload.aud !== audience)
        throw new HandshakeRejection(REJECTION.WRONG_AUDIENCE_CLAIM);

      const user = await this.loadUser(payload.sub);
      if (!user) throw new HandshakeRejection(REJECTION.UNKNOWN_OR_DEACTIVATED);

      // Same cut-off as JwtStrategy, from the same helper: a token from an
      // ended password epoch is dead everywhere, or a password change would
      // kill HTTP sessions while leaving the live socket — the channel that
      // carries order and stock traffic — happily connected.
      if (isStaleSessionVersion(payload.pv, user.passwordVersion))
        throw new HandshakeRejection(REJECTION.STALE_EPOCH);

      this.assertAuthorized(audience, user);

      client.data = {
        kind: 'authenticated',
        userId: user.id,
        roles: user.roles,
        permissions: user.permissions,
        branchId: user.branchId,
        audience,
        token,
        expiresAtMs: (payload.exp ?? 0) * 1000,
        // Non-null: `isStaleSessionVersion` above refused an absent claim.
        sessionVersion: payload.pv as number,
      };

      // The user room is per-principal and carries that person's own events, so
      // every audience gets it.
      await client.join(userRoom(user.id));
      await this.joinAudienceRooms(client, audience, user);
    } catch (error) {
      const code =
        error instanceof HandshakeRejection ? error.code : REJECTION.INTERNAL;
      /*
       * Logged with a CATEGORY and never with the credential. `debug` for the
       * ordinary refusals a public internet endpoint sees constantly, `warn`
       * for the one that means this service is broken rather than the caller.
       */
      const line = `handshake rejected: ${code} (audience=${audienceForLog ?? 'none'})`;
      if (code === REJECTION.INTERNAL) {
        this.logger.warn(`${line}: ${String(error)}`);
      } else {
        this.logger.debug(line);
      }
      client.disconnect(true);
    }
  }

  /**
   * THE AUTHORIZATION CHECKS THE HANDSHAKE USED TO SKIP.
   *
   * Authentication answers "who is this?"; these two answer "may they be
   * here?", and the socket previously asked only the first. Both are decided
   * from DATABASE state — `mustChangePassword` and the effective permission
   * set — because a token minted before an administrator froze the account or
   * revoked a capability cannot know either.
   *
   * Shared by the handshake and the re-validation sweep on purpose: an
   * invariant enforced in one place and not the other is an invariant with a
   * sixty-second hole in it, which is exactly what this was.
   */
  private assertAuthorized(
    audience: SessionAudience,
    user: LoadedPrincipal,
  ): void {
    /*
     * A staff account frozen pending a forced password change is refused every
     * protected HTTP route (`JwtAuthGuard`), and was nonetheless free to hold a
     * live socket streaming branch stock and order traffic. The HTTP exemptions
     * are `/me`, `change-password` and `logout-all` — none of which is a
     * realtime concern — so there is no equivalent carve-out here.
     *
     * The storefront is excluded because a customer is never in this state:
     * `mustChangePassword` belongs to the staff credential lifecycle, and a
     * customer's door is an OTP.
     */
    if (audience !== 'storefront' && user.mustChangePassword) {
      throw new HandshakeRejection(REJECTION.MUST_CHANGE_PASSWORD);
    }

    /*
     * The same permission rule HTTP login and every token rotation use
     * (`isEligibleForAudience`), so a socket cannot outlive the eligibility
     * that opened it. Revoking `pos.access` from a cashier's role now closes
     * their till socket instead of leaving it in the branch room until the
     * access token happened to expire.
     */
    if (!isEligibleForAudience(user.permissions, audience)) {
      throw new HandshakeRejection(REJECTION.AUDIENCE_NOT_PERMITTED);
    }
  }

  /**
   * ROOMS ARE A PROPERTY OF THE SURFACE, not only of the role.
   *
   * A branch room carries till traffic — stock movements and sales at that
   * counter — so a storefront session must not join it even when the signed-in
   * person happens to be a cashier. The admin room is the same: an
   * administrator browsing the shop as a customer is not an operator console.
   */
  private async joinAudienceRooms(
    client: AuthenticatedSocket,
    audience: SessionAudience,
    user: LoadedPrincipal,
  ): Promise<void> {
    if (audience === 'storefront') {
      /*
       * A signed-in customer joins the SAME public room an anonymous visitor
       * does, and nothing else beyond their own `user:<id>`.
       *
       * That is what makes signing in an upgrade rather than a different
       * world: the catalogue keeps working exactly as it did, and the session
       * only ADDS the private channel. It also means the public payload is
       * validated by every storefront visitor at once, rather than having a
       * signed-in-only variant nobody exercises.
       */
      await client.join(ROOM_PUBLIC_AVAILABILITY);
      return;
    }

    if (audience === 'pos') {
      // `pos.access` was asserted before this point, so a branch room is a
      // capability plus a posting, not a bare column value.
      await client.join(ROOM_STAFF_AVAILABILITY);
      if (user.branchId !== null) {
        await client.join(branchRoom(user.branchId));
      }
      return;
    }

    if (audience === 'admin') {
      /*
       * Availability invalidation is content-scoped and permission-gated:
       * `inventory.read` is the capability the HTTP stock screens require, and
       * this frame carries strictly less than they do (no quantity at all).
       */
      if (user.permissions.includes('inventory.read')) {
        await client.join(ROOM_STAFF_AVAILABILITY);
      }
      // Exact counts, order money and cashier identity — see ROOM_SUPER_ADMIN.
      if (user.roles.includes(UserRoleEnum.superAdmin)) {
        await client.join(ROOM_SUPER_ADMIN);
        if (user.branchId !== null) {
          await client.join(branchRoom(user.branchId));
        }
      }
    }
  }

  handleDisconnect() {
    // Rooms are cleaned up by socket.io; nothing to release.
  }

  // ==========================================================================
  // Emitters — the ONLY supported way to publish
  // ==========================================================================

  /**
   * The `admins` room UNIONED with one branch room. `.to()` chains as a union
   * and socket.io de-duplicates recipients, so an admin who also belongs to the
   * branch receives the event exactly once.
   *
   * A `null`/`undefined` branch (a pure online order, or a stock movement that
   * is not attributable to a till) reaches admins only. It NEVER falls back to
   * a global broadcast: "no branch" means a smaller audience, not a bigger one.
   */
  private staffChannel(branchId: number | null | undefined) {
    const channel = this.server.to(ROOM_SUPER_ADMIN);
    return branchId === null || branchId === undefined
      ? channel
      : channel.to(branchRoom(branchId));
  }

  /**
   * Order lifecycle events -- STAFF ONLY.
   *
   * `server.emit(...)` — which every call site used to do — broadcasts to EVERY
   * connected socket. That leaked order ids, statuses, totals, customer ids and
   * branch attribution to every signed-in retail customer with a socket open.
   * Order events are staff data: they go to `admins` and to the one branch the
   * order belongs to, and nowhere else.
   *
   * THE OWNING CUSTOMER IS NOT AN AUDIENCE OF THIS METHOD, on purpose. A staff
   * payload may legitimately carry branch attribution, cashier ids and totals,
   * and widening this room set to include a `user:<id>` would hand all of that
   * to whichever customer happened to own the order. A customer-facing order
   * notification is a SEPARATE, deliberately narrower payload sent through
   * `emitToUser`; see `PaymentService.publish()`.
   */
  emitOrderEvent(
    event:
      | 'order.created'
      | 'order.status.updated'
      | 'order.voided'
      /**
       * Operational: an order is PAID but its stock is not there. Staff act on
       * it; the customer learns about it through their order state and through
       * the `order.status.updated` they receive on their own channel.
       */
      | 'order.awaiting_stock',
    payload: Record<string, unknown> & { branchId?: number | null },
  ): void {
    if (!this.server) return;
    this.staffChannel(payload.branchId).emit(event, payload);
  }

  /**
   * EXACT physical stock -- STAFF ONLY.
   *
   * This used to be `this.server.emit('stock:updated', payload)`: a GLOBAL
   * broadcast of the exact unit count of every variant to every connected
   * socket, including every retail storefront customer. Exact quantities are
   * role-gated on every HTTP route that serves them (`GET /inventory/lookup`
   * and `GET /inventory/availability` are `sale` + `super_admin`), so a live
   * channel that gave them away to anybody with a session was the one hole in
   * that rule. `sale` staff reach this event through their `branch:<id>` room,
   * which they join at handshake from `users.branchId`.
   *
   * `newStock` must be the COMMITTED `balanceAfter` returned by the R2
   * conditional UPDATE (inventory rule R7), never a number recomputed in memory
   * from a pre-lock snapshot.
   *
   * Physical stock is NOT branch-partitioned in this schema
   * (`product_variants.stock` is one number for the whole business), so
   * `branchId` here does not scope the FACT -- it only names an additional
   * staff audience, e.g. the till that made the sale. Omitting it is always
   * safe.
   *
   * Storefront clients get `availability:updated` instead; see
   * `emitAvailabilityEvent`.
   */
  emitStockEvent(
    payload: Record<string, unknown> & { branchId?: number | null },
  ): void {
    if (!this.server) return;
    this.staffChannel(payload.branchId).emit(STOCK_EVENT, payload);
  }

  /**
   * PUBLIC availability invalidation -- the storefront's channel, anonymous
   * visitors included.
   *
   * ## There is no longer a global broadcast anywhere in this application
   *
   * This used to be `server.emit(...)`: every connected socket, including every
   * till and every admin console, received every storefront availability
   * frame. It was sanctioned because the payload could not carry a quantity or
   * an identity — a reasonable argument for the payload, and no argument at all
   * for the ROOM. Now that storefront sockets have a room of their own, the
   * frame goes to the audience it was written for, and "is this safe for
   * everyone?" is a question nobody has to keep re-answering.
   *
   * `AvailabilityInvalidatedPayload` documents exactly what may travel here.
   * Anything richer belongs on `emitStockEvent` (staff, exact counts) or
   * `emitToUser` (one customer). Wanting a field here is the signal you want
   * one of those two.
   */
  emitAvailabilityEvent(payload: AvailabilityInvalidatedPayload): void {
    this.server?.to(ROOM_PUBLIC_AVAILABILITY).emit(AVAILABILITY_EVENT, payload);
  }

  /**
   * STAFF availability invalidation. Same payload, staff room, narrower trigger.
   *
   * Callers must publish here only for changes that can move
   * `availableForPos`. A basket reservation cannot — POS outranks basket holds
   * — so sending one would tell every till in the shop to re-read a number
   * that did not change. {@link publishAvailabilityInvalidation} enforces that
   * from the reason code so no call site has to remember it.
   */
  emitPosAvailabilityEvent(payload: AvailabilityInvalidatedPayload): void {
    this.server
      ?.to(ROOM_STAFF_AVAILABILITY)
      .emit(POS_AVAILABILITY_EVENT, payload);
  }

  /** Reasons that can change what a TILL may sell. A basket hold cannot. */
  private static readonly POS_RELEVANT_REASONS: readonly AvailabilityReason[] =
    ['stock', 'allocation', 'catalogue'];

  /**
   * THE ONE WAY availability invalidation is published.
   *
   * Call it AFTER the transaction commits, with every variant the transaction
   * touched. It resolves each variant's product in a single query, emits one
   * frame per VARIANT — not per changed database row — and routes to the staff
   * room only when the reason can actually move `availableForPos`.
   *
   * Deduplication happens here rather than at each call site because the call
   * sites are the places that naturally have duplicates: one transaction can
   * release several reservation tranches of the same variant, and each would
   * otherwise become its own frame telling the client the same thing.
   *
   * Never throws. A cache or socket failure must not turn a committed sale into
   * a failed request; the client's reconnect resync and its polling fallback
   * are the recovery paths for a frame that never went out.
   */
  async publishAvailabilityInvalidation(
    variantIds: readonly number[],
    reason: AvailabilityReason,
  ): Promise<void> {
    const ids = [
      ...new Set(
        variantIds.map((id) => Number(id)).filter((id) => Number.isInteger(id)),
      ),
    ];
    if (ids.length === 0) return;

    try {
      const rows = await this.dataSource.query<
        Array<{ id: number | string; productId: number | string | null }>
      >(
        `SELECT "id", "productId" FROM "product_variants" WHERE "id" = ANY($1::int[])`,
        [ids],
      );

      /*
       * CACHE FIRST, THEN ANNOUNCE. A client that reacts to the frame must not
       * be able to read the answer the frame says is stale.
       */
      const productIds = [
        ...new Set(
          rows
            .map((row) => Number(row.productId))
            .filter((id) => Number.isInteger(id)),
        ),
      ];
      await this.catalogCache.invalidateProducts(productIds);

      const posRelevant = RealtimeGateway.POS_RELEVANT_REASONS.includes(reason);

      for (const row of rows) {
        if (row.productId === null) continue;
        const payload: AvailabilityInvalidatedPayload = {
          variantId: Number(row.id),
          productId: Number(row.productId),
          reason,
        };
        this.emitAvailabilityEvent(payload);
        if (posRelevant) this.emitPosAvailabilityEvent(payload);
      }
    } catch (error) {
      this.logger.warn(
        `Could not publish availability invalidation (${reason}) for ${ids.length} variant(s): ${String(error)}`,
      );
    }
  }

  /**
   * ONE customer, on their own room.
   *
   * Basket displacement / expiry notices, and (since the order-event leak was
   * closed) the customer's own order notifications. The payload sent here must
   * contain only facts that customer is already entitled to about their OWN
   * order -- never a branch, a cashier, another customer's order id, or a stock
   * count.
   */
  emitToUser(userId: number, event: string, payload: unknown): void {
    this.server?.to(userRoom(userId)).emit(event, payload);
  }

  // ==========================================================================
  // Re-validation
  // ==========================================================================

  /**
   * ENDS EVERY LIVE SOCKET BELONGING TO ONE USER, IMMEDIATELY.
   *
   * ## Why the 60-second sweep is not enough on its own
   *
   * {@link revalidateAll} catches three things by re-reading the database:
   * an expired access token, a deactivated user, and a password epoch that has
   * moved. Revoking SESSIONS is none of those. It sets `refresh_tokens.revoked`
   * and leaves `users` untouched — the account is active and the epoch has not
   * changed — so the sweep looks at such a socket, finds every credential check
   * satisfied, and leaves it streaming. "Revoke every session after a
   * compromise" therefore closed the refresh path while the websocket kept
   * delivering staff order and stock traffic for the whole remaining lifetime
   * of an access token the attacker already held.
   *
   * There is no epoch to compare against because a socket is not bound to a
   * refresh-token row, so this is deliberately not another predicate for the
   * sweep to evaluate. It is a PUSH: the code that revokes says who, and every
   * socket for that user goes, on this node and on every other one, because
   * the room lookup goes through the adapter.
   *
   * ## Call it AFTER the commit
   *
   * Same rule as every other emit in this application. A rolled-back
   * revocation must not disconnect anybody, so callers wait for the
   * transaction to resolve first.
   *
   * Never throws: a failure to enumerate sockets must not turn a successful
   * revocation into a failed HTTP request. The sweep remains the backstop.
   */
  async disconnectUser(userId: number, reason: string): Promise<number> {
    if (!this.server) return 0;

    let sockets: AuthenticatedSocket[];
    try {
      sockets = (await this.server
        .in(userRoom(userId))
        .fetchSockets()) as unknown as AuthenticatedSocket[];
    } catch (error) {
      this.logger.warn(
        `Could not enumerate sockets for user ${userId} (${reason}): ${String(error)}`,
      );
      return 0;
    }

    let dropped = 0;
    for (const socket of sockets) {
      try {
        // `true` closes the underlying connection rather than only the
        // namespace, so the client cannot keep the transport alive.
        socket.disconnect(true);
        dropped += 1;
      } catch (error) {
        this.logger.warn(
          `Could not disconnect a socket for user ${userId} (${reason}): ${String(error)}`,
        );
      }
    }

    if (dropped > 0) {
      this.logger.log(
        `Disconnected ${dropped} socket(s) for user ${userId}: ${reason}`,
      );
    }
    return dropped;
  }

  /**
   * RE-DECIDE ONE USER'S SOCKETS NOW, instead of at the next sweep.
   *
   * Authorization changes are pushes, not polls. Revoking a capability,
   * deactivating a role, moving a cashier between branches or freezing an
   * account pending a password change all used to leave a live socket exactly
   * as it was for up to a full sixty-second interval — holding rooms whose
   * entitlement had just been withdrawn.
   *
   * It runs the SAME `revalidateSocket` the sweep runs, so there is one
   * decision procedure and not a fast path that can disagree with the slow
   * one. A socket that is still entitled keeps its connection and has its
   * rooms recomputed; one that is not is dropped with a reason code.
   *
   * Call it AFTER the commit, and never let it fail the request: a socket that
   * survives a tick longer than it should is a smaller problem than a rolled
   * back permission change.
   */
  async reconcileUser(userId: number, reason: string): Promise<number> {
    if (!this.server) return 0;
    let sockets: AuthenticatedSocket[];
    try {
      sockets = (await this.server
        .in(userRoom(userId))
        .fetchSockets()) as unknown as AuthenticatedSocket[];
    } catch (error) {
      this.reportReconciliationFailure({
        scope: 'user',
        stage: 'enumerate',
        reason,
        userId,
        audience: null,
        examined: 0,
        failed: 1,
        error: safeErrorText(error),
      });
      return 0;
    }

    const now = Date.now();
    let failed = 0;
    for (const socket of sockets) {
      try {
        await this.revalidateSocket(socket, now);
      } catch (error) {
        /*
         * The socket is dropped -- failing CLOSED is the only safe outcome
         * when we could not establish that it is still entitled.
         *
         * It is also REPORTED. This catch used to be bare, so a reconciliation
         * that failed on every socket returned the same number as one that
         * succeeded on every socket and logged nothing at all. A committed
         * authorization change whose push failed has to be visible.
         */
        failed += 1;
        this.dropSocket(socket, REJECTION.INTERNAL);
        this.reportReconciliationFailure({
          scope: 'user',
          stage: 'socket',
          reason,
          userId,
          audience: audienceOf(socket),
          examined: sockets.length,
          failed,
          error: safeErrorText(error),
        });
      }
    }
    if (sockets.length > 0) {
      this.logger.debug(
        `reconciled ${sockets.length} socket(s) for user ${userId}: ${reason}` +
          (failed > 0 ? ` (${failed} failed and were dropped)` : ''),
      );
    }
    return sockets.length;
  }

  /**
   * ONE STRUCTURED LINE PER RECONCILIATION FAILURE.
   *
   * `error` level, not `warn`: the RBAC mutation has already committed and
   * cannot be rolled back (see the note on `reconcileAll`), so what this
   * records is a live socket that may be holding an entitlement the database
   * has already withdrawn. The sweep will correct it within
   * `backstopWithinMs`, which is exactly why the window is part of the
   * payload -- an operator needs the blast radius, not just the fact.
   *
   * Never throws, and never touches the handshake: see
   * {@link ReconciliationFailure} for what is deliberately absent.
   */
  private reportReconciliationFailure(
    detail: Omit<ReconciliationFailure, 'event' | 'backstopWithinMs'>,
  ): void {
    const payload: ReconciliationFailure = {
      event: RECONCILIATION_FAILURE_EVENT,
      ...detail,
      backstopWithinMs: REVALIDATION_INTERVAL_MS,
    };
    try {
      this.logger.error(JSON.stringify(payload));
    } catch {
      // A logger that throws must not take the caller down with it; the
      // committed authorization change is still correct either way.
    }
  }

  /**
   * RE-DECIDE EVERY SOCKET NOW.
   *
   * For changes to the permission MODEL rather than to one principal: editing
   * a role's grants, or deactivating a role, changes what every holder of that
   * role may receive. Resolving "which users hold this role?" here would
   * duplicate a query the RBAC service already owns, and on a single node the
   * socket count is small, so re-deciding all of them is both simpler and
   * impossible to get wrong by missing a user.
   *
   * This is the one place the multi-node limitation bites hardest: with a
   * cluster adapter, `fetchSockets()` would reach other nodes; without one it
   * reaches only this process. See the deployment note in docs.
   *
   * ## IT MUST NOT ROLL THE MUTATION BACK, and it does not
   *
   * The RBAC change has already committed by the time this runs. Turning a
   * push failure into a failed request would be strictly worse: the
   * authorization change is the half that matters and it is correct, while a
   * socket that outlives its entitlement for one interval is a bounded
   * problem. So this never throws, and its callers do not guard it.
   *
   * ## THE MAXIMUM TEMPORARY EXPOSURE WINDOW (single-node deployment)
   *
   * If the immediate push fails, the periodic sweep re-decides every socket on
   * this node every {@link REVALIDATION_INTERVAL_MS} (60 s), so a live socket
   * can hold a withdrawn entitlement for AT MOST one interval after the change
   * commits — 60 seconds, plus the time one sweep takes to walk the sockets.
   * Every failure is reported with that bound attached; see
   * {@link ReconciliationFailure}. Nothing silently succeeds: a failed pass
   * logs `realtime.reconciliation.failed` at error level.
   *
   * On a MULTI-NODE deployment this bound does not hold, because neither the
   * push nor the sweep reaches another process's sockets. Multi-node Socket.IO
   * delivery is unsupported in this deployment; see docs/ARCHITECTURE.md.
   */
  async reconcileAll(reason: string): Promise<void> {
    this.logger.debug(`reconciling every socket: ${reason}`);
    await this.revalidateAll(reason);
  }

  /**
   * Sweeps every live socket: disconnects those whose access token has expired
   * and those whose user has been deactivated or deleted, and refreshes the
   * room membership of anyone whose roles or branch changed.
   */
  async revalidateAll(reason = 'periodic sweep'): Promise<void> {
    if (!this.server) return;

    let sockets: AuthenticatedSocket[];
    try {
      sockets =
        (await this.server.fetchSockets()) as unknown as AuthenticatedSocket[];
    } catch (error) {
      this.reportReconciliationFailure({
        scope: 'all',
        stage: 'enumerate',
        reason,
        userId: null,
        audience: null,
        examined: 0,
        failed: 1,
        error: safeErrorText(error),
      });
      return;
    }

    const now = Date.now();
    let failed = 0;
    for (const socket of sockets) {
      try {
        await this.revalidateSocket(socket, now);
      } catch (error) {
        // Fail closed, then say so. Silently disconnecting was indistinguishable
        // from a clean sweep in the logs.
        failed += 1;
        socket.disconnect(true);
        this.reportReconciliationFailure({
          scope: 'all',
          stage: 'socket',
          reason,
          userId: userIdOf(socket),
          audience: audienceOf(socket),
          examined: sockets.length,
          failed,
          error: safeErrorText(error),
        });
      }
    }
  }

  private async revalidateSocket(
    socket: AuthenticatedSocket,
    now: number,
  ): Promise<void> {
    const data = socket.data;

    /*
     * An anonymous socket has no principal, so there is nothing to re-check —
     * and nothing that could change to make it unsafe, because the one room it
     * is in carries only public invalidations. Leaving it alone is the correct
     * outcome, not an omission.
     */
    if (data?.kind === 'anonymous') return;

    if (data?.kind !== 'authenticated' || !data.userId) {
      this.dropSocket(socket, REJECTION.INTERNAL);
      return;
    }

    if (data.expiresAtMs && data.expiresAtMs <= now) {
      this.dropSocket(socket, REJECTION.SESSION_EXPIRED);
      return;
    }

    const user = await this.loadUser(data.userId);
    if (!user) {
      this.dropSocket(socket, REJECTION.UNKNOWN_OR_DEACTIVATED);
      return;
    }

    // A password change since the handshake ends this session too. The epoch
    // is re-read from the database on every sweep, so an increment reaches an
    // ALREADY-OPEN socket within one interval rather than at its next
    // handshake — which for a till left signed in all day is never.
    if (isStaleSessionVersion(data.sessionVersion, user.passwordVersion)) {
      this.dropSocket(socket, REJECTION.STALE_EPOCH);
      return;
    }

    /*
     * THE SAME AUTHORIZATION THE HANDSHAKE APPLIES — this is the half that was
     * missing, and the half that made the other half optional.
     *
     * A capability revoked, a role deactivated, or `mustChangePassword` set
     * after the handshake previously changed nothing about a live socket: the
     * sweep re-read the account but only ever asked about the epoch and the
     * deactivation flag, so a cashier whose `pos.access` had been taken away
     * kept their branch room — and its exact stock counts — for the rest of the
     * access token's life.
     */
    try {
      this.assertAuthorized(data.audience, user);
    } catch (error) {
      this.dropSocket(
        socket,
        error instanceof HandshakeRejection ? error.code : REJECTION.INTERNAL,
      );
      return;
    }

    /*
     * Rooms are recomputed from the SAME rule the handshake used, so a role
     * change can never grant a room this socket's audience is not entitled to
     * — a storefront socket whose owner is promoted to super_admin still joins
     * only the public room, because it is still a storefront socket.
     *
     * Every conditionally-granted room is left first, including the ones a
     * permission change may have just revoked. Leaving the OLD branch room
     * matters as much as joining the new one: moving a cashier between
     * branches must not accumulate rooms.
     */
    const stale = [ROOM_SUPER_ADMIN, ROOM_STAFF_AVAILABILITY];
    if (data.branchId !== null) stale.push(branchRoom(data.branchId));
    if (user.branchId !== null) stale.push(branchRoom(user.branchId));
    for (const room of stale) {
      if (socket.rooms.has(room)) await socket.leave(room);
    }
    await this.joinAudienceRooms(socket, data.audience, user);

    socket.data = {
      ...data,
      roles: user.roles,
      permissions: user.permissions,
      branchId: user.branchId,
    };
  }

  /** One place that closes a socket, so every closure is categorised. */
  private dropSocket(socket: AuthenticatedSocket, code: RejectionCode): void {
    this.logger.debug(`socket dropped: ${code}`);
    socket.disconnect(true);
  }

  /**
   * Returns null for an unknown OR soft-deactivated user.
   *
   * Now also resolves the EFFECTIVE PERMISSION SET, through the same
   * `PermissionService.resolveEffective` the HTTP login and every token
   * rotation use. That is what lets the gateway authorize by capability
   * instead of by role name, and it is read fresh every time precisely so a
   * revoked grant or a deactivated role takes effect without waiting for a
   * token to expire. `resolveEffective` skips inactive roles, so deactivating
   * a custom role is enough to close the sockets it authorized.
   */
  private async loadUser(userId: number): Promise<LoadedPrincipal | null> {
    const user = await this.dataSource.getRepository(User).findOne({
      where: { id: userId },
      relations: { roles: true },
    });
    if (!user) return null;

    const { deactivatedAt, mustChangePassword, passwordVersion } =
      readLifecycle(user);
    if (deactivatedAt) return null;

    const roles = user.roles ?? [];
    const permissions = await this.permissionService.resolveEffective(roles);

    return {
      id: user.id,
      // Custom roles are not members of `UserRoleEnum`; the cast is the
      // pre-existing shape and only the three built-in names are ever compared.
      roles: roles.map((role) => role.name as UserRoleEnum),
      permissions,
      branchId: user.branchId ?? null,
      mustChangePassword,
      passwordVersion,
    };
  }
}
