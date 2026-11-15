/**
 * The RECOVERY transport: honest polling against the authoritative HTTP
 * endpoints.
 *
 * It is no longer the primary path. `createFallbackTransport` runs it only
 * while the Socket.IO transport is disconnected, and stops it the moment the
 * socket reconnects — so in the normal case this file costs nothing. It is
 * still the DEFAULT inside `createRealtimeClient`, because that function cannot
 * construct a socket without a factory the app has to supply.
 *
 * This is NOT a simulated websocket. It makes real requests, diffs the
 * responses, and synthesizes the same event payloads the gateway would have
 * broadcast — which is safe precisely because realtime is advisory and HTTP is
 * authoritative. The trade-offs vs. a real socket are:
 *
 *  - latency is the poll interval, not milliseconds
 *  - it only observes what the UI has `track()`ed
 *  - it costs one request per interval per tracked kind
 *
 * Endpoint choice is role-aware, because the customer and staff surfaces expose
 * different things:
 *
 *  | interest            | endpoint                        | who        | synthesizes            |
 *  |---------------------|---------------------------------|------------|------------------------|
 *  | `cart`              | `GET /cart`                     | any signed | `availability:updated` |
 *  | `product`           | `GET /products/:id`             | public     | `availability:updated` |
 *  | `variants`          | `GET /inventory/availability`   | **staff**  | `stock:updated` + `availability:updated` |
 *  | `order` (customer)  | `GET /me/orders/:id`            | owner      | `order.status.updated` |
 *  | `order` (staff)     | `GET /orders/:id`               | staff      | `order.status.updated` |
 *
 * `GET /inventory/availability` is 403 for a `site` user, so a customer surface
 * must track `cart` / `product`, never `variants`. Tracking `variants` as a
 * customer is not a crash — the poll fails quietly and the transport backs off.
 *
 * `GET /cart` is doubly valuable: it lazily expires reservations server-side, so
 * polling it is the documented recovery path for missed frames.
 */

import { isApiError } from "../errors";
import type { ApiClient } from "../http";
import type { RealtimeTransport, RealtimeTransportContext } from "./client";
import type { AvailabilitySnapshot, CartView, CustomerOrder, PublicProduct } from "../types";

export interface PollingTransportOptions {
  /** Base interval. Default 15 000 ms. */
  intervalMs?: number;
  /** Interval when the tab is hidden. Default 60 000 ms. `0` pauses entirely. */
  hiddenIntervalMs?: number;
  /** Multiplier applied per consecutive failure. Default 2. */
  backoffFactor?: number;
  /** Upper bound for the backed-off interval. Default 120 000 ms. */
  maxIntervalMs?: number;
  /** Poll immediately on start. Default `true` (it doubles as the initial sync). */
  immediate?: boolean;
}

interface PollState {
  /** variantId -> last observed inStock */
  availability: Map<number, boolean>;
  /** variantId -> last observed physical stock */
  stock: Map<number, number>;
  /** orderId -> last observed status */
  orderStatus: Map<number, string>;
}

const DEFAULTS = {
  intervalMs: 15_000,
  hiddenIntervalMs: 60_000,
  backoffFactor: 2,
  maxIntervalMs: 120_000,
  immediate: true,
} as const;

export function createPollingTransport(options: PollingTransportOptions = {}): RealtimeTransport {
  const intervalMs = options.intervalMs ?? DEFAULTS.intervalMs;
  const hiddenIntervalMs = options.hiddenIntervalMs ?? DEFAULTS.hiddenIntervalMs;
  const backoffFactor = options.backoffFactor ?? DEFAULTS.backoffFactor;
  const maxIntervalMs = options.maxIntervalMs ?? DEFAULTS.maxIntervalMs;
  const immediate = options.immediate ?? DEFAULTS.immediate;

  let ctx: RealtimeTransportContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: AbortController | undefined;
  let stopped = true;
  let consecutiveFailures = 0;
  let hadFailure = false;
  let firstCycleDone = false;
  let unsubscribeInterest: (() => void) | undefined;
  let visibilityHandler: (() => void) | undefined;

  const state: PollState = {
    availability: new Map(),
    stock: new Map(),
    orderStatus: new Map(),
  };

  const isHidden = (): boolean =>
    typeof document !== "undefined" && document.visibilityState === "hidden";

  const nextDelay = (): number => {
    if (isHidden() && hiddenIntervalMs === 0) return Number.POSITIVE_INFINITY;
    const base = isHidden() ? hiddenIntervalMs : intervalMs;
    if (consecutiveFailures === 0) return base;
    return Math.min(maxIntervalMs, base * backoffFactor ** consecutiveFailures);
  };

  const schedule = (delay: number): void => {
    if (stopped) return;
    if (!Number.isFinite(delay)) return; // paused while hidden
    timer = setTimeout(() => {
      void cycle();
    }, delay);
  };

  async function cycle(): Promise<void> {
    if (stopped || !ctx) return;
    abort = new AbortController();
    const signal = abort.signal;
    const snapshot = ctx.interests();
    let failed = false;

    const tasks: Array<Promise<void>> = [];

    if (snapshot.cart) tasks.push(pollCart(ctx, state, signal).catch(markFailure));
    for (const productId of snapshot.productIds) {
      tasks.push(pollProduct(ctx, state, productId, signal).catch(markFailure));
    }
    if (snapshot.variantIds.length > 0) {
      // The endpoint accepts 1–100 ids and one unknown id fails the WHOLE call,
      // so chunk and let a bad chunk fail alone.
      for (const chunk of chunkIds(snapshot.variantIds, 100)) {
        tasks.push(pollVariants(ctx, state, chunk, signal).catch(markFailure));
      }
    }
    for (const orderId of snapshot.customerOrderIds) {
      tasks.push(pollCustomerOrder(ctx, state, orderId, signal).catch(markFailure));
    }
    for (const orderId of snapshot.staffOrderIds) {
      tasks.push(pollStaffOrder(ctx, state, orderId, signal).catch(markFailure));
    }

    function markFailure(error: unknown): void {
      // A cancelled poll is not a failure.
      if (isApiError(error) && error.kind === "aborted") return;
      failed = true;
    }

    await Promise.all(tasks);
    if (stopped) return;

    if (failed) {
      consecutiveFailures += 1;
      hadFailure = true;
      ctx.setStatus("reconnecting");
    } else {
      consecutiveFailures = 0;
      ctx.setStatus("open");
      if (!firstCycleDone) {
        firstCycleDone = true;
        ctx.resync("connected");
      } else if (hadFailure) {
        hadFailure = false;
        // Recovered after a gap: the UI must refetch, exactly as it would after
        // a socket reconnect.
        ctx.resync("poll-recovered");
      }
    }

    schedule(nextDelay());
  }

  return {
    name: "polling",

    start(nextCtx) {
      ctx = nextCtx;
      stopped = false;
      consecutiveFailures = 0;
      firstCycleDone = false;
      hadFailure = false;
      ctx.setStatus("connecting");

      unsubscribeInterest = ctx.onInterestChange(() => {
        // New interest: poll now rather than waiting out the interval.
        if (timer !== undefined) clearTimeout(timer);
        schedule(0);
      });

      if (typeof document !== "undefined") {
        visibilityHandler = () => {
          if (timer !== undefined) clearTimeout(timer);
          schedule(document.visibilityState === "visible" ? 0 : nextDelay());
        };
        document.addEventListener("visibilitychange", visibilityHandler);
      }

      schedule(immediate ? 0 : nextDelay());
    },

    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      abort?.abort();
      abort = undefined;
      unsubscribeInterest?.();
      unsubscribeInterest = undefined;
      if (visibilityHandler && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", visibilityHandler);
      }
      visibilityHandler = undefined;
      state.availability.clear();
      state.stock.clear();
      state.orderStatus.clear();
    },
  };
}

// --- individual pollers ----------------------------------------------------

function emitAvailabilityIfChanged(
  ctx: RealtimeTransportContext,
  state: PollState,
  variantId: number,
  productId: number,
  sellable: boolean,
): void {
  /*
   * The poller still DIFFS, and the diff is still a boolean — but it is
   * private to this module now.
   *
   * The socket's frame says only "this went stale". The poller, by contrast,
   * has just read the authoritative answer, so it knows whether anything
   * actually changed; emitting on every cycle regardless would turn a 15-second
   * poll into a 15-second refetch loop in every consumer. So the boolean
   * decides WHETHER to synthesize a frame, and never travels inside one.
   *
   * `reason: "stock"` because a poller cannot tell a sale from an expiry from a
   * basket hold — it sees only the resulting number. It is the conservative
   * choice: `stock` is treated as POS-relevant, so a till on the fallback path
   * re-reads rather than ignoring the change.
   */
  if (state.availability.get(variantId) === sellable) return;
  state.availability.set(variantId, sellable);
  ctx.emit("availability:invalidated", { variantId, productId, reason: "stock" });
}

async function pollCart(
  ctx: RealtimeTransportContext,
  state: PollState,
  signal: AbortSignal,
): Promise<void> {
  const cart = await get<CartView>(ctx.client, "/cart", "spread", signal);
  for (const line of cart.data ?? []) {
    const variantId = line.variant?.id;
    if (variantId === undefined) continue;
    const available = line.availableForBasket;
    if (available === null || available === undefined) continue;
    emitAvailabilityIfChanged(
      ctx,
      state,
      variantId,
      line.productId ?? 0,
      available > 0,
    );
  }
}

async function pollProduct(
  ctx: RealtimeTransportContext,
  state: PollState,
  productId: number,
  signal: AbortSignal,
): Promise<void> {
  const product = await get<PublicProduct>(ctx.client, `/products/${productId}`, "data", signal);
  for (const variant of product.variants ?? []) {
    const inStock = variant.availability?.inStock;
    if (inStock === undefined) continue;
    emitAvailabilityIfChanged(ctx, state, variant.id, productId, inStock);
  }
}

async function pollVariants(
  ctx: RealtimeTransportContext,
  state: PollState,
  variantIds: number[],
  signal: AbortSignal,
): Promise<void> {
  const snapshots = await ctx.client.get<AvailabilitySnapshot[]>("/inventory/availability", {
    envelope: "data",
    signal,
    query: { variantIds },
  });
  for (const snap of snapshots ?? []) {
    emitAvailabilityIfChanged(
      ctx,
      state,
      snap.variantId,
      // The staff availability endpoint now carries the owning product, so the
      // synthesized frame is the same shape as the socket's.
      snap.productId ?? 0,
      snap.availableForBasket > 0,
    );
    if (state.stock.get(snap.variantId) !== snap.physicalStock) {
      state.stock.set(snap.variantId, snap.physicalStock);
      ctx.emit("stock:updated", {
        variantId: snap.variantId,
        newStock: snap.physicalStock,
        branchId: null,
      });
    }
  }
}

async function pollCustomerOrder(
  ctx: RealtimeTransportContext,
  state: PollState,
  orderId: number,
  signal: AbortSignal,
): Promise<void> {
  const order = await get<CustomerOrder>(ctx.client, `/me/orders/${orderId}`, "data", signal);
  emitOrderStatus(ctx, state, orderId, order.status);
}

async function pollStaffOrder(
  ctx: RealtimeTransportContext,
  state: PollState,
  orderId: number,
  signal: AbortSignal,
): Promise<void> {
  const order = await get<{ status?: string; branchId?: number | null }>(
    ctx.client,
    `/orders/${orderId}`,
    "data",
    signal,
  );
  if (typeof order.status === "string") {
    emitOrderStatus(ctx, state, orderId, order.status, order.branchId ?? null);
  }
}

function emitOrderStatus(
  ctx: RealtimeTransportContext,
  state: PollState,
  orderId: number,
  status: string,
  branchId?: number | null,
): void {
  if (state.orderStatus.get(orderId) === status) return;
  const first = !state.orderStatus.has(orderId);
  state.orderStatus.set(orderId, status);
  // Do not synthesize a "change" for the very first observation.
  if (first) return;
  ctx.emit("order.status.updated", {
    orderId,
    status,
    ...(branchId === undefined ? {} : { branchId }),
  });
}

function get<T>(
  client: ApiClient,
  path: string,
  envelope: "spread" | "data",
  signal: AbortSignal,
): Promise<T> {
  return client.get<T>(path, { envelope, signal, cache: "no-store" });
}

function chunkIds(ids: number[], size: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
