"use client";

/**
 * Where `socket.io-client` is actually imported for this application.
 *
 * `packages/api-client` owns the transport LOGIC but cannot own the dependency:
 * it has no `package.json` of its own (both front-ends resolve it from source
 * through a tsconfig `paths` entry), and a package that cannot declare a
 * dependency must not import one. `@kazhal/web` can and does declare
 * `socket.io-client@4.8.3` — pinned to the exact version of the `socket.io`
 * server `@nestjs/platform-socket.io` runs — so the import belongs here.
 *
 * ## What this composes
 *
 * Socket.IO is the PRIMARY transport. Polling is kept, demoted to a recovery
 * fallback that only runs while the socket is down — see
 * `createFallbackTransport` for the exact state machine. The upshot for a
 * customer with a cart open: a till sale reaches their screen on the socket in
 * milliseconds, and if the socket is gone the 15-second poll still eventually
 * catches it. Neither path is trusted with a value; both only ever say
 * "refetch".
 *
 * ## Audience
 *
 * Nothing here names one. `createSocketIoTransport` reads `ctx.client.audience`
 * — the value the surrounding `ApiProvider` was constructed with, once, at its
 * composition root. The storefront tree says `storefront`, the admin tree says
 * `admin`, and neither can be reached by the other's cookie because the
 * handshake asks for one specific cookie by name.
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
export function createWebRealtimeTransport(): RealtimeTransport {
  return createFallbackTransport({
    primary: createSocketIoTransport(connect),
    fallback: createPollingTransport(),
  });
}
