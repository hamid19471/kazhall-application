/**
 * The realtime contract, transcribed from `apps/api/src/modules/realtime/`.
 *
 * ## The one rule
 *
 * **Realtime is advisory. HTTP responses are authoritative.** Every frame is
 * published after commit and may be dropped, duplicated or delivered late. A
 * dropped frame is never a correctness problem: `GET /cart`,
 * `GET /inventory/availability` and the catalogue re-derive the truth. Treat a
 * frame as "something changed, consider refetching", never as the new value.
 * There is no longer any exception to that rule: the availability frame states
 * no value at all, which is what makes one frame safe for an anonymous visitor
 * and a till alike.
 *
 * ## Connection
 *
 * Socket.IO, default namespace `/`, default path `/socket.io`, on the SAME port
 * as the HTTP API. Authentication is the audience's access **cookie on the
 * handshake** — there is no `auth` payload, no query token and no Bearer path,
 * so the browser must connect with credentials.
 *
 * ## Anonymous is a supported state, for the storefront only
 *
 * A `storefront` handshake carrying NO storefront cookie is accepted as an
 * ANONYMOUS public socket: it joins `public:availability` and nothing else, and
 * receives only availability invalidations. That is what lets a guest browsing
 * the catalogue see a variant sell out.
 *
 * A cookie that is PRESENT and BAD is never downgraded to anonymous — it is
 * refused. Anonymous mode is for "no credential was supplied", never for "a
 * credential failed", because the second would turn every authentication error
 * into a quiet success. `pos` and `admin` have no anonymous mode at all.
 *
 * A re-validation sweep runs every 60 s server-side and will disconnect an
 * expired session mid-stream, and will join/leave `admins` / `branch:<id>` when
 * roles or branch change. Clients must expect to be dropped, refresh, and
 * reconnect — and must refetch after every reconnect.
 *
 * ## Rooms (assigned by the server at handshake; clients cannot join)
 *
 *  - `user:<userId>`   — always
 *  - `public:availability`  — EVERY storefront socket, anonymous included
 *  - `staff:availability`   — pos + admin, for POS-relevant invalidation
 *  - `branch:<branchId>`    — only when `branchId !== null`
 *  - `staff:super-admin`    — only a super_admin on the admin surface
 *
 * ## Emit-only
 *
 * There are no `@SubscribeMessage` handlers. Clients never send messages.
 */

/**
 * WHY something went stale. Coarse and non-sensitive; never a quantity.
 *
 *  - `stock`       physical units moved (sale, adjustment, fulfilment, reversal)
 *  - `reservation` a basket hold was taken, changed, released or expired
 *  - `allocation`  an order allocation was created or released
 *  - `catalogue`   the variant was created, retired or reinstated
 */
export type AvailabilityReason =
  | "stock"
  | "reservation"
  | "allocation"
  | "catalogue";

/**
 * An ADVISORY POINTER at stale data. It is not a state update, and nothing on
 * it may be rendered.
 *
 * ## What changed, and why it had to
 *
 * This replaced `{ variantId, inStock }`. That boolean could not be correct for
 * both audiences at once — storefront sellability subtracts basket reservations
 * and POS sellability does not — so one field meant two different things
 * depending on who read it, and five server-side emit sites derived it five
 * different ways, two of them ignoring whether the variant was even active.
 *
 * `productId` is here because `GET /products` returns no variant ids: without
 * it a listing page cannot tell whether a frame concerns anything it is
 * showing, and its only option is to refetch the whole current page.
 *
 * On receiving one: refetch the authoritative endpoint for whatever this page
 * shows. Never write a field of this payload into rendered inventory state.
 */
export interface AvailabilityInvalidatedPayload {
  variantId: number;
  productId: number;
  reason: AvailabilityReason;
}

/** Staff-only. Carries a real committed count. */
export interface StockUpdatedPayload {
  variantId: number;
  /** Committed `balanceAfter`. */
  newStock: number;
  branchId: number | null;
}

/**
 * Two shapes share this name.
 *
 *  - staff (`admins` ∪ `branch:<id>`): `{ orderId, status, branchId }`, plus
 *    `voidedAt` from void/return.
 *  - **owner** (`user:<id>`): deliberately narrower — `{ orderId, status }`.
 *    No branch, no cashier, no totals. Do not expect the staff fields here.
 */
export interface OrderStatusUpdatedPayload {
  orderId: number;
  status: string;
  branchId?: number | null;
  voidedAt?: string | null;
}

export interface OrderCreatedPayload {
  orderId: number;
  branchId?: number | null;
  orderNumber?: string | null;
  channel?: string;
  status?: string;
  totalPrice?: number;
  cashierUserId?: number | null;
}

/** Payment confirmed but stock could not be allocated. Staff channel. */
export interface OrderAwaitingStockPayload {
  orderId: number;
  branchId?: number | null;
}

/**
 * Declared in the gateway's emit union but currently emitted by no call site.
 * Model it defensively rather than assuming it will never arrive.
 */
export interface OrderVoidedPayload extends Record<string, unknown> {
  branchId?: number | null;
}

/** Every event the gateway can emit, keyed by its exact wire name. */
export interface RealtimeEventMap {
  /** PUBLIC. Every storefront socket, anonymous included. */
  "availability:invalidated": AvailabilityInvalidatedPayload;
  /**
   * STAFF. Same payload, `staff:availability` room, and a narrower trigger: it
   * fires only for changes that can move `availableForPos`, so a basket
   * reservation never produces one.
   */
  "pos:availability:invalidated": AvailabilityInvalidatedPayload;
  "stock:updated": StockUpdatedPayload;
  "order.created": OrderCreatedPayload;
  "order.status.updated": OrderStatusUpdatedPayload;
  "order.awaiting_stock": OrderAwaitingStockPayload;
  "order.voided": OrderVoidedPayload;
}

export type RealtimeEventName = keyof RealtimeEventMap;

export const REALTIME_EVENTS: readonly RealtimeEventName[] = [
  "availability:invalidated",
  "pos:availability:invalidated",
  "stock:updated",
  "order.created",
  "order.status.updated",
  "order.awaiting_stock",
  "order.voided",
] as const;

/**
 * Events a storefront socket can ever receive.
 *
 * An ANONYMOUS storefront socket receives only the first of them: it has no
 * user room, so nothing addressed to a principal can reach it.
 */
export const CUSTOMER_SAFE_EVENTS: readonly RealtimeEventName[] = [
  "availability:invalidated",
  "order.status.updated",
] as const;

/** The one event an anonymous, unauthenticated socket may receive. */
export const ANONYMOUS_SAFE_EVENTS: readonly RealtimeEventName[] = [
  "availability:invalidated",
] as const;

export type RealtimeStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "error";

/** Why the client is asking you to refetch. */
export type ResyncReason = "connected" | "reconnected" | "poll-recovered" | "manual";

export type Unsubscribe = () => void;

/** Room names, matching the server exactly. */
export const ROOM_PUBLIC_AVAILABILITY = "public:availability";
export const ROOM_STAFF_AVAILABILITY = "staff:availability";
export const ROOM_SUPER_ADMIN = "staff:super-admin";
export const userRoom = (userId: number): string => `user:${userId}`;
export const branchRoom = (branchId: number): string => `branch:${branchId}`;

/** Default Socket.IO mount point. */
export const SOCKET_IO_PATH = "/socket.io";
export const SOCKET_IO_NAMESPACE = "/";

/**
 * What the UI currently cares about. The polling fallback needs this because,
 * unlike a socket, it cannot receive what it does not ask for.
 */
export type RealtimeInterest =
  | { kind: "cart" }
  | { kind: "product"; productId: number }
  /** Staff only — `GET /inventory/availability` is 403 for a `site` user. */
  | { kind: "variants"; variantIds: number[] }
  | { kind: "order"; orderId: number; scope: "customer" | "staff" };

export interface InterestSnapshot {
  cart: boolean;
  productIds: number[];
  variantIds: number[];
  customerOrderIds: number[];
  staffOrderIds: number[];
}
