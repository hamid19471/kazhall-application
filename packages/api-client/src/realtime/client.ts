/**
 * The realtime client: a thin, transport-agnostic event bus with an explicit
 * transport seam.
 *
 * Why a seam and not a Socket.IO client? Because this package has no
 * `package.json` — both front-ends resolve it from source through a tsconfig
 * `paths` entry — so it cannot declare a dependency and must not import one.
 * `socket.io-client@4.8.3` is declared by the applications that open a socket
 * (`apps/web`, `apps/store`), and each passes `io` in at its composition root.
 *
 * What runs in production is `createFallbackTransport({ primary:
 * createSocketIoTransport(io), fallback: createPollingTransport() })`: the
 * socket carries traffic, and the poller starts only while the socket is down.
 * `createPollingTransport()` remains the DEFAULT here because this package
 * cannot build the socket half by itself, and a default that silently does
 * nothing would be worse than one that is merely slower.
 *
 * Nothing in this file fakes a websocket. `status` reports `"open"` for the
 * polling transport only in the sense that the poller is running; under the
 * composite, `"open"` means the socket is genuinely connected.
 */

import type { ApiClient } from "../http";
import { createPollingTransport } from "./polling";
import {
  type InterestSnapshot,
  type RealtimeEventMap,
  type RealtimeEventName,
  type RealtimeInterest,
  type RealtimeStatus,
  type ResyncReason,
  type Unsubscribe,
} from "./types";

/** Everything a transport is allowed to do to the client. */
export interface RealtimeTransportContext {
  readonly client: ApiClient;
  /** Publish a frame to subscribers. */
  emit<K extends RealtimeEventName>(event: K, payload: RealtimeEventMap[K]): void;
  setStatus(status: RealtimeStatus): void;
  /** Tell subscribers to refetch authoritative state. */
  resync(reason: ResyncReason): void;
  /** What the UI currently cares about. */
  interests(): InterestSnapshot;
  /** Fires when {@link interests} changes. */
  onInterestChange(handler: () => void): Unsubscribe;
}

/**
 * The seam. Implement this to swap polling for a real socket.
 *
 * `start` must be idempotent-safe (the client never calls it twice without a
 * `stop` in between) and must not throw synchronously.
 */
export interface RealtimeTransport {
  readonly name: string;
  start(ctx: RealtimeTransportContext): void | Promise<void>;
  stop(): void | Promise<void>;
}

export type StopReason =
  | "logout"
  | "unmount"
  | "signed-out"
  /**
   * A new session was established, so the socket that was open belongs to the
   * previous one. Distinguished from the others because it is the one stop
   * that is immediately followed by a start, and the one that must NOT release
   * the signed-in subscription that triggered it.
   */
  | "reauthenticated"
  | "manual";

export interface RealtimeClientOptions {
  client: ApiClient;
  /** Defaults to `createPollingTransport()`. */
  transport?: RealtimeTransport;
  /**
   * React to a signed-out transition. Default `true`.
   *
   * What "react" means depends on the surface, and the difference is the whole
   * point:
   *
   *  - `pos` / `admin` — STOP. Every frame those surfaces receive is staff
   *    data, there is no anonymous mode for them, and the gateway would refuse
   *    a credential-less handshake anyway.
   *  - `storefront`    — DOWNGRADE to the anonymous public socket. The
   *    catalogue is public, so a signed-out shopper must keep seeing variants
   *    sell out exactly as they did before signing in. Stopping outright is
   *    what left a logged-out storefront with no realtime at all.
   */
  stopOnSignOut?: boolean;
  /**
   * Auto-(re)start when the API client transitions to signed-in. Default
   * `true`, and it is the counterpart {@link RealtimeClientOptions.stopOnSignOut}
   * needs in order not to be a one-way door.
   *
   * WHY THIS IS NOT OPTIONAL IN PRACTICE. An anonymous storefront load probes
   * the session, 401s, fails the refresh and signs out — so `stopOnSignOut`
   * fires on a page a guest merely LOOKED at. The storefront then signs the
   * customer in with `router.replace`, which does not remount the provider, so
   * nothing calls `start()` again: the basket would sit open on a live session
   * with no socket and no polling fallback, updating only on tab-return. That
   * is precisely the failure this whole transport exists to remove.
   */
  restartOnSignIn?: boolean;
}

export interface RealtimeClient {
  readonly status: RealtimeStatus;
  readonly transportName: string;
  start(): void;
  /** Teardown. Call on logout and on app unmount. Safe to call twice. */
  stop(reason?: StopReason): void;
  on<K extends RealtimeEventName>(
    event: K,
    handler: (payload: RealtimeEventMap[K]) => void,
  ): Unsubscribe;
  onStatus(handler: (status: RealtimeStatus) => void): Unsubscribe;
  /**
   * Fires after a (re)connect. **Refetch here** — this is how a UI recovers the
   * frames it missed while disconnected.
   */
  onResync(handler: (reason: ResyncReason) => void): Unsubscribe;
  /**
   * Register what this part of the UI cares about, so the polling fallback
   * knows what to watch. No-op cost under a real socket. Returns an
   * unsubscribe that removes the interest.
   */
  track(interest: RealtimeInterest): Unsubscribe;
  /** Force a resync notification (e.g. on tab focus). */
  resync(): void;
}

type Handler = (payload: never) => void;

export function createRealtimeClient(options: RealtimeClientOptions): RealtimeClient {
  const { client } = options;
  const transport = options.transport ?? createPollingTransport();
  const stopOnSignOut = options.stopOnSignOut !== false;
  const restartOnSignIn = options.restartOnSignIn !== false;

  const handlers = new Map<RealtimeEventName, Set<Handler>>();
  const statusHandlers = new Set<(status: RealtimeStatus) => void>();
  const resyncHandlers = new Set<(reason: ResyncReason) => void>();
  const interestHandlers = new Set<() => void>();
  const interestEntries = new Set<RealtimeInterest>();

  let status: RealtimeStatus = "idle";
  let running = false;
  let unsubscribeSignOut: Unsubscribe | undefined;
  let unsubscribeSignedIn: Unsubscribe | undefined;
  /**
   * Whether this client has ever held a SESSION.
   *
   * It exists to keep a guest's page load quiet. An anonymous storefront visit
   * probes the session, gets a 401, fails the refresh and fires `signOut` — on
   * a socket that is already anonymous and already correct. Without this flag
   * that signal would tear the socket down and rebuild an identical one on
   * every guest page view, for no change in what the socket can receive.
   */
  let hasHeldSession = false;

  const notifyInterestChange = (): void => {
    for (const handler of interestHandlers) safely(handler);
  };

  const snapshot = (): InterestSnapshot => {
    const productIds = new Set<number>();
    const variantIds = new Set<number>();
    const customerOrderIds = new Set<number>();
    const staffOrderIds = new Set<number>();
    let cart = false;

    for (const interest of interestEntries) {
      switch (interest.kind) {
        case "cart":
          cart = true;
          break;
        case "product":
          productIds.add(interest.productId);
          break;
        case "variants":
          for (const id of interest.variantIds) variantIds.add(id);
          break;
        case "order":
          if (interest.scope === "customer") customerOrderIds.add(interest.orderId);
          else staffOrderIds.add(interest.orderId);
          break;
      }
    }

    return {
      cart,
      productIds: [...productIds],
      variantIds: [...variantIds],
      customerOrderIds: [...customerOrderIds],
      staffOrderIds: [...staffOrderIds],
    };
  };

  const ctx: RealtimeTransportContext = {
    client,
    emit(event, payload) {
      const set = handlers.get(event);
      if (!set) return;
      for (const handler of set) {
        safely(() => (handler as (p: RealtimeEventMap[typeof event]) => void)(payload));
      }
    },
    setStatus(next) {
      if (status === next) return;
      status = next;
      for (const handler of statusHandlers) safely(() => handler(next));
    },
    resync(reason) {
      for (const handler of resyncHandlers) safely(() => handler(reason));
    },
    interests: snapshot,
    onInterestChange(handler) {
      interestHandlers.add(handler);
      return () => {
        interestHandlers.delete(handler);
      };
    },
  };

  const api: RealtimeClient = {
    get status() {
      return status;
    },
    get transportName() {
      return transport.name;
    },

    start() {
      /*
       * THE SIGNED-IN SUBSCRIPTION IS DELIBERATELY OUTSIDE THE `running`
       * GUARD, because its entire job is to fire while this client is STOPPED.
       * It is idempotent (subscribe once, keep it) so a restart does not stack
       * a second listener and turn one login into two handshakes.
       */
      if (restartOnSignIn && !unsubscribeSignedIn) {
        unsubscribeSignedIn = client.auth.onSignedIn(() => {
          hasHeldSession = true;
          // The handshake cookie has just been replaced, so any socket still
          // open is authenticated as the PREVIOUS session — or, on the
          // storefront, is the anonymous one. Replace it: the new handshake
          // carries the new cookie and upgrades to the authenticated rooms.
          if (running) api.stop("reauthenticated");
          api.start();
        });
      }

      if (running) return;
      running = true;
      ctx.setStatus("connecting");
      if (stopOnSignOut) {
        unsubscribeSignOut = client.auth.onSignedOut(() => {
          /*
           * A GUEST'S SESSION PROBE IS NOT A TRANSITION.
           *
           * `signOut` fires on every anonymous storefront load (the `/me` 401
           * fails the refresh). If this client never held a session, the socket
           * it already has is the anonymous one — which is exactly what a
           * signed-out storefront should have — so there is nothing to do.
           *
           * This is also what removes the guest-phase socket churn: the first
           * handshake on a guest page is credential-less and therefore
           * ACCEPTED as anonymous, and nothing afterwards tears it down.
           */
          if (client.audience === "storefront" && !hasHeldSession) return;

          hasHeldSession = false;

          if (client.audience !== "storefront") {
            api.stop("signed-out");
            return;
          }

          /*
           * DOWNGRADE, don't stop. Restarting re-handshakes with no storefront
           * cookie (logout cleared it), which the gateway accepts as anonymous
           * — so the catalogue stays live and only the private channel goes.
           */
          api.stop("signed-out");
          api.start();
        });
      }
      void Promise.resolve(transport.start(ctx)).catch(() => ctx.setStatus("error"));
    },

    stop(reason: StopReason = "manual") {
      /*
       * Which stops END this client, and which merely pause it.
       *
       * `unmount`/`manual` are the owner saying "you are done" — release the
       * signed-in subscription, or a login after the provider unmounted would
       * resurrect a socket nobody is listening to. This runs BEFORE the
       * `running` guard so a client already stopped by a sign-out is still
       * released when its provider unmounts.
       *
       * `signed-out`/`logout` KEEP it: being signed out is the one state a
       * sign-in has to be able to reverse, and that is the bug this closes.
       *
       * `reauthenticated` keeps it too — it is issued BY that subscription.
       *
       * React Strict Mode's mount → unmount → mount is safe either way:
       * `stop("unmount")` releases, and the second `start()` re-subscribes.
       */
      if (reason === "unmount" || reason === "manual") {
        unsubscribeSignedIn?.();
        unsubscribeSignedIn = undefined;
      }
      if (!running) return;
      running = false;
      unsubscribeSignOut?.();
      unsubscribeSignOut = undefined;
      void Promise.resolve(transport.stop()).catch(() => undefined);
      ctx.setStatus("closed");
    },

    on(event, handler) {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler as Handler);
      return () => {
        set?.delete(handler as Handler);
      };
    },

    onStatus(handler) {
      statusHandlers.add(handler);
      return () => {
        statusHandlers.delete(handler);
      };
    },

    onResync(handler) {
      resyncHandlers.add(handler);
      return () => {
        resyncHandlers.delete(handler);
      };
    },

    track(interest) {
      interestEntries.add(interest);
      notifyInterestChange();
      return () => {
        interestEntries.delete(interest);
        notifyInterestChange();
      };
    },

    resync() {
      ctx.resync("manual");
    },
  };

  return api;
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // A subscriber must never break the bus.
  }
}
