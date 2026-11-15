/**
 * The Socket.IO transport — the PRIMARY realtime path for every surface.
 *
 * ## Why the factory is still injected
 *
 * `socket.io-client@4.8.3` is now a real, declared dependency — of the two
 * applications that actually open a socket (`apps/web`, `apps/store`) and of
 * `apps/api` for its integration tests. It is deliberately NOT imported here.
 *
 * `packages/api-client` has no `package.json`: both front-ends resolve it from
 * source through a tsconfig `paths` entry. A package that cannot declare a
 * dependency must not import one, so the composition root — which can and does
 * declare it — passes `io` in:
 *
 * ```ts
 * import { io } from "socket.io-client";
 * import { createSocketIoTransport } from "@kazhal/api-client";
 *
 * const transport = createSocketIoTransport((url, opts) => io(url, opts));
 * ```
 *
 * ## What this transport encodes about the server
 *
 *  - default namespace `/` and default path `/socket.io`, same origin/port as
 *    the HTTP API
 *  - **cookie authentication on the handshake**, so `withCredentials: true` is
 *    mandatory and non-configurable here; there is no token option to pass
 *  - the server re-validates every 60 s and will disconnect an expired session,
 *    so reconnect is expected, not exceptional — and every (re)connect fires a
 *    `resync` so the UI refetches what it missed
 *  - the gateway is emit-only; this transport never sends a message
 *
 * ## Why `forceNew` is not optional
 *
 * `io(url)` MULTIPLEXES: called twice for the same origin and namespace it
 * hands back the SAME `Socket`, created by the first caller — with the first
 * caller's handshake query. The storefront and the admin console are one Next
 * origin (`:8001`) and one JS context, so navigating `/admin` → `/` unmounts
 * one `ApiProvider` and mounts another inside the same page. Multiplexed, the
 * second provider would silently inherit the first's `audience=admin`
 * handshake and join the admin rooms while believing it was the shop.
 *
 * `forceNew` gives every provider lifecycle its own Manager, its own handshake
 * and its own audience. It is the mechanical reason this transport can promise
 * "each transport selects only its own audience" rather than merely intending
 * to.
 */

import { resolveRealtimeUrl } from "../config";
import type { RealtimeTransport, RealtimeTransportContext } from "./client";
import {
  REALTIME_EVENTS,
  SOCKET_IO_NAMESPACE,
  SOCKET_IO_PATH,
  type RealtimeEventMap,
  type RealtimeEventName,
} from "./types";

/** The subset of a Socket.IO client instance this transport uses. */
export interface SocketLike {
  connected?: boolean;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  off?(event: string, handler?: (...args: unknown[]) => void): unknown;
  disconnect(): unknown;
  connect?(): unknown;
}

/** Handshake options this transport always passes. */
export interface SocketIoConnectOptions {
  /** Non-negotiable: the gateway authenticates via the handshake cookie. */
  withCredentials: true;
  path: string;
  /** Namespace is the default `/`; included for clarity. */
  namespace: string;
  /**
   * Non-negotiable: never multiplex. See the header — a shared Manager would
   * hand a second `ApiProvider` the FIRST provider's audience, and an audience
   * is the only thing standing between a storefront socket and a till's rooms.
   */
  forceNew: true;
  /**
   * Names WHICH session opens the socket.
   *
   * The browser sends every audience's cookie on the handshake, so the gateway
   * cannot infer the surface. This selects the cookie to read — it grants
   * nothing, because naming an audience you hold no cookie for yields no
   * session at all. It decides which rooms the socket may join: a storefront
   * connection never joins a till's branch room.
   */
  query: { audience: string };
  transports?: string[];
  /**
   * The gateway re-validates every 60 s and disconnects expired sessions, so
   * reconnecting is the normal case, not an error case. Left on, unbounded.
   */
  reconnection: true;
  reconnectionDelay: number;
  reconnectionDelayMax: number;
}

/** `(url, options) => io(url, options)` — supplied by the app. */
export type SocketIoFactory = (url: string, options: SocketIoConnectOptions) => SocketLike;

export interface SocketIoTransportOptions {
  /** Overrides `NEXT_PUBLIC_REALTIME_URL` / the API base URL. */
  url?: string;
  path?: string;
  transports?: string[];
  /** First reconnect backoff step. Default 500 ms. */
  reconnectionDelayMs?: number;
  /** Reconnect backoff ceiling. Default 5000 ms. */
  reconnectionDelayMaxMs?: number;
}

export function createSocketIoTransport(
  factory: SocketIoFactory,
  options: SocketIoTransportOptions = {},
): RealtimeTransport {
  let socket: SocketLike | undefined;
  let bound: Array<[string, (...args: unknown[]) => void]> = [];

  /** Unbind every listener this transport added, then close the socket. */
  const teardown = (): void => {
    if (!socket) return;
    for (const [event, handler] of bound) socket.off?.(event, handler);
    bound = [];
    socket.disconnect();
    socket = undefined;
  };

  return {
    name: "socket.io",

    start(ctx: RealtimeTransportContext) {
      // Defensive, for React Strict Mode's mount → unmount → mount: the client
      // pairs every `start` with a `stop`, but if a caller ever does not, the
      // consequence must be a REPLACED socket rather than a second live one.
      teardown();

      const url = resolveRealtimeUrl(options.url);
      ctx.setStatus("connecting");

      socket = factory(url, {
        withCredentials: true,
        path: options.path ?? SOCKET_IO_PATH,
        namespace: SOCKET_IO_NAMESPACE,
        forceNew: true,
        query: { audience: ctx.client.audience },
        reconnection: true,
        reconnectionDelay: options.reconnectionDelayMs ?? 500,
        reconnectionDelayMax: options.reconnectionDelayMaxMs ?? 5_000,
        ...(options.transports ? { transports: options.transports } : {}),
      });

      const bind = (event: string, handler: (...args: unknown[]) => void): void => {
        socket?.on(event, handler);
        bound.push([event, handler]);
      };

      let hasConnectedOnce = false;

      bind("connect", () => {
        ctx.setStatus("open");
        // Every (re)connect is a gap: refetch authoritative state.
        ctx.resync(hasConnectedOnce ? "reconnected" : "connected");
        hasConnectedOnce = true;
      });
      bind("disconnect", () => ctx.setStatus("reconnecting"));
      bind("connect_error", () => ctx.setStatus("error"));

      for (const event of REALTIME_EVENTS) {
        bind(event, (...args: unknown[]) => {
          const payload = args[0];
          if (payload === undefined || payload === null) return;
          ctx.emit(event as RealtimeEventName, payload as RealtimeEventMap[RealtimeEventName]);
        });
      }
    },

    stop() {
      teardown();
    },
  };
}
