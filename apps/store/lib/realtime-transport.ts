"use client";

/**
 * Where `socket.io-client` is actually imported for the till.
 *
 * `packages/api-client` owns the transport LOGIC but cannot own the dependency:
 * it has no `package.json` of its own (both front-ends resolve it from source
 * through a tsconfig `paths` entry), and a package that cannot declare a
 * dependency must not import one. `@kazhal/store` can and does declare
 * `socket.io-client@4.8.3` — pinned to the exact version of the `socket.io`
 * server `@nestjs/platform-socket.io` runs — so the import belongs here.
 *
 * ## What this composes
 *
 * Socket.IO is the PRIMARY transport. Polling is kept, demoted to a recovery
 * fallback that only runs while the socket is down — see
 * `createFallbackTransport` for the exact state machine. For a till this is the
 * difference between a cashier seeing an admin's stock correction the moment it
 * commits and seeing it up to fifteen seconds later; the till still never sells
 * from the number on screen, because `POST /orders/pos` re-checks under a lock
 * and answers 409.
 *
 * ## Audience
 *
 * Nothing here names one. `createSocketIoTransport` reads `ctx.client.audience`
 * — `pos`, fixed once by `StoreProviders`. That is what puts this socket in
 * `branch:<id>` and lets it receive the staff-only `stock:updated`. A browser
 * signed into the shop and the till at the same time holds two unrelated
 * sockets, each having asked for its own cookie by name.
 */

import { io } from "socket.io-client";

import {
  createFallbackTransport,
  createPollingTransport,
  createSocketIoTransport,
  type RealtimeTransport,
  type SocketIoConnectOptions,
  type SocketLike,
} from "@kazhal/api-client";

/**
 * Adapts `io` to the narrow `SocketLike` the transport declares.
 *
 * `namespace` is stripped out of the options and folded into the URL, because
 * socket.io-client takes the namespace as the URL's path and would treat an
 * unknown `namespace` key as dead weight.
 */
function connect(url: string, options: SocketIoConnectOptions): SocketLike {
  const { namespace, transports, ...managerOptions } = options;
  return io(`${url}${namespace}`, {
    ...managerOptions,
    ...(transports ? { transports: transports as ("polling" | "websocket")[] } : {}),
  }) as unknown as SocketLike;
}

/**
 * One transport per `ApiProvider` lifecycle. Call it once, in a `useMemo` with
 * no dependencies — `forceNew` gives each call its own Manager, so calling it
 * twice would genuinely open two sockets.
 */
export function createPosRealtimeTransport(): RealtimeTransport {
  return createFallbackTransport({
    primary: createSocketIoTransport(connect),
    fallback: createPollingTransport(),
  });
}
