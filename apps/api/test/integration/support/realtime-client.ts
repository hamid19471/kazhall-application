/**
 * ===========================================================================
 * THE REAL `socket.io-client`, AGAINST THE REAL GATEWAY
 * ===========================================================================
 *
 * `support/socket-client.ts` speaks the Engine.IO/Socket.IO wire protocol by
 * hand over `fetch`, and it was right to: when it was written,
 * `socket.io-client` was not a dependency of this workspace and was not in the
 * pnpm store, so importing it meant adding one.
 *
 * It is a dependency now — `socket.io-client@4.8.3`, pinned to the exact
 * version of the `socket.io` server `@nestjs/platform-socket.io` runs, declared
 * as a devDependency of `@kazhal/api`. The reason is the browser: both
 * front-ends now open a real socket through `createSocketIoTransport`, and a
 * test that reimplements the protocol proves the GATEWAY works while proving
 * nothing about the client the customer actually runs. The reconnect logic, the
 * transport upgrade, the acknowledgement of a server-initiated disconnect and
 * the event decoding are all `socket.io-client`'s code, and they are all on the
 * path this workstream is answerable for.
 *
 * So: this helper drives the same library the browser does, over a real socket,
 * against the real bound test server.
 *
 * ## No sleeps
 *
 * Every wait here is on an OBSERVABLE event with a bounded deadline. A test
 * that wants "the customer received a frame" awaits the frame; a test that
 * wants "nothing was received" awaits a bounded quiet period and asserts the
 * buffer is empty. There is no `setTimeout(resolve, 500)` standing in for a
 * causal relationship anywhere.
 *
 * ## Why frames are buffered from the moment of connection
 *
 * The interesting race is a frame arriving BEFORE the test gets around to
 * awaiting it — which is exactly what happens when a POS sale is fast. Every
 * frame is pushed onto a per-event queue as it lands, and `next()` drains that
 * queue before it waits. Without this the suite would be a coin flip that
 * usually lands green.
 *
 * ## Transports
 *
 * Defaults to `['websocket']`: deterministic, one connection, no upgrade step
 * to race. `polling` is exposed so a test can pin the long-polling path the
 * browser falls back to behind a proxy that will not upgrade.
 *
 * Cookies travel as `extraHeaders`, not `withCredentials`: there is no browser
 * cookie jar in Node, and the gateway reads the raw `Cookie:` header either way.
 */
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { io, type Socket } from 'socket.io-client';

/** Default bound for every wait in this helper. */
export const DEFAULT_DEADLINE_MS = 5_000;

export type TestAudience = 'storefront' | 'admin' | 'pos';

export interface RealtimeClientOptions {
  /** The BOUND test HTTP server; its real ephemeral port is read from it. */
  server: Server;
  /**
   * A `Cookie:` header value — normally `jar.header()`.
   *
   * OMIT IT ENTIRELY for an anonymous handshake. That is not the same as
   * passing an empty string: the gateway's whole anonymous security boundary is
   * the difference between "no credential was supplied" (a legitimate public
   * visitor) and "a credential was supplied and is bad" (a rejection), so a
   * test for the first must send no `Cookie:` header at all.
   */
  cookie?: string;
  /**
   * Which session opens the socket. Selects the cookie the gateway reads.
   *
   * Widened to `string` on purpose: the negative cases need to send an audience
   * the server does not recognise, and a union that excluded them would make
   * "the gateway refuses garbage" untestable.
   */
  audience: string;
  transports?: Array<'websocket' | 'polling'>;
  /** Override the handshake query entirely (for negative cases). */
  query?: Record<string, string>;
}

export interface TestRealtimeClient {
  /** The underlying client, for assertions this helper does not wrap. */
  readonly socket: Socket;
  readonly id: string | undefined;
  readonly connected: boolean;
  /** Frames of `event` received so far and not yet consumed by `next`. */
  buffered(event: string): unknown[];
  /** Every frame of `event` received since connect, including consumed ones. */
  allReceived(event: string): unknown[];
  /**
   * The next frame of `event`. Resolves immediately from the buffer if one has
   * already arrived. Rejects on the deadline — a timeout is a FAILED
   * expectation, never a silently-skipped assertion.
   */
  next<T = unknown>(event: string, deadlineMs?: number): Promise<T>;
  /**
   * Assert that NOTHING arrives on `event` within `quietMs`. Resolves on
   * success; rejects naming the frame that did arrive.
   */
  expectSilence(event: string, quietMs: number): Promise<void>;
  /** Resolves with the disconnect reason. Rejects on the deadline. */
  waitForDisconnect(deadlineMs?: number): Promise<string>;
  /** Close the transport and remove every listener. Idempotent. */
  close(): Promise<void>;
}

function urlFor(server: Server): string {
  const address = server.address() as AddressInfo | null;
  if (!address || typeof address !== 'object') {
    throw new Error(
      'realtime test client needs a BOUND server — call bindTestServer(app) first',
    );
  }
  return `http://127.0.0.1:${address.port}`;
}

function build(options: RealtimeClientOptions): Socket {
  return io(urlFor(options.server), {
    path: '/socket.io',
    // Never multiplex: two clients in one test must be two sockets, with two
    // handshakes and two audiences. This is the same flag the browser
    // transport passes, and for the same reason.
    forceNew: true,
    transports: options.transports ?? ['websocket'],
    // No header at all when no cookie was given — see `cookie` above.
    ...(options.cookie === undefined
      ? {}
      : { extraHeaders: { Cookie: options.cookie } }),
    query: options.query ?? { audience: options.audience },
    // Tests assert on ONE handshake outcome. Silent retries would turn a
    // rejected handshake into a hang and a disconnect assertion into a race.
    reconnection: false,
    timeout: DEFAULT_DEADLINE_MS,
  });
}

/** Every event this gateway can emit, so the helper can record them all. */
const RECORDED_EVENTS = [
  'availability:invalidated',
  'pos:availability:invalidated',
  'stock:updated',
  'order.created',
  'order.status.updated',
  'order.awaiting_stock',
  'order.voided',
] as const;

function instrument(socket: Socket): TestRealtimeClient {
  const buffers = new Map<string, unknown[]>();
  const history = new Map<string, unknown[]>();
  const waiters = new Map<
    string,
    Array<{ resolve: (value: unknown) => void; timer: NodeJS.Timeout }>
  >();
  let disconnectReason: string | null = null;
  const disconnectWaiters: Array<{
    resolve: (reason: string) => void;
    timer: NodeJS.Timeout;
  }> = [];

  const push = (event: string, payload: unknown): void => {
    (history.get(event) ?? history.set(event, []).get(event)!).push(payload);
    const queue = waiters.get(event);
    const waiter = queue?.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(payload);
      return;
    }
    (buffers.get(event) ?? buffers.set(event, []).get(event)!).push(payload);
  };

  for (const event of RECORDED_EVENTS) {
    socket.on(event, (payload: unknown) => push(event, payload));
  }

  socket.on('disconnect', (reason: string) => {
    disconnectReason = reason;
    while (disconnectWaiters.length > 0) {
      const waiter = disconnectWaiters.shift()!;
      clearTimeout(waiter.timer);
      waiter.resolve(reason);
    }
  });

  return {
    socket,
    get id() {
      return socket.id;
    },
    get connected() {
      return socket.connected;
    },

    buffered: (event) => [...(buffers.get(event) ?? [])],
    allReceived: (event) => [...(history.get(event) ?? [])],

    next<T>(event: string, deadlineMs = DEFAULT_DEADLINE_MS): Promise<T> {
      const queue = buffers.get(event);
      if (queue && queue.length > 0) return Promise.resolve(queue.shift() as T);
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          const list = waiters.get(event) ?? [];
          const index = list.findIndex((w) => w.timer === timer);
          if (index >= 0) list.splice(index, 1);
          reject(
            new Error(
              `no "${event}" frame within ${deadlineMs}ms ` +
                `(socket ${socket.id ?? 'closed'}, connected=${socket.connected})`,
            ),
          );
        }, deadlineMs);
        timer.unref?.();
        const list = waiters.get(event) ?? waiters.set(event, []).get(event)!;
        list.push({ resolve: resolve as (value: unknown) => void, timer });
      });
    },

    expectSilence(event: string, quietMs: number): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const seen = buffers.get(event) ?? [];
          if (seen.length === 0) resolve();
          else
            reject(
              new Error(
                `expected no "${event}" frame in ${quietMs}ms but received ` +
                  `${seen.length}: ${JSON.stringify(seen)}`,
              ),
            );
        }, quietMs);
        timer.unref?.();
      });
    },

    waitForDisconnect(deadlineMs = DEFAULT_DEADLINE_MS): Promise<string> {
      if (disconnectReason !== null) return Promise.resolve(disconnectReason);
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `socket ${socket.id ?? '?'} was still connected after ${deadlineMs}ms`,
              ),
            ),
          deadlineMs,
        );
        timer.unref?.();
        disconnectWaiters.push({ resolve, timer });
      });
    },

    async close(): Promise<void> {
      for (const list of waiters.values()) {
        for (const waiter of list) clearTimeout(waiter.timer);
      }
      waiters.clear();
      for (const waiter of disconnectWaiters) clearTimeout(waiter.timer);
      disconnectWaiters.length = 0;
      socket.removeAllListeners();
      socket.disconnect();
      // `disconnect()` on an open socket closes the underlying transport
      // synchronously; `close()` on the manager releases the engine. Both are
      // needed for the process to have no open handles at the end of a run.
      socket.io.engine?.close();
      await Promise.resolve();
    },
  };
}

/**
 * Connect and WAIT for the namespace to be joined.
 *
 * Rejects if the gateway refuses the handshake, so a test that expects a
 * working session never continues against a dead socket. Use
 * {@link attemptRealtime} for the cases where refusal is the expected outcome.
 */
export async function connectRealtime(
  options: RealtimeClientOptions,
  deadlineMs = DEFAULT_DEADLINE_MS,
): Promise<TestRealtimeClient> {
  const socket = build(options);
  const client = instrument(socket);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      void client.close();
      reject(
        new Error(
          `handshake for audience "${options.audience}" did not complete in ${deadlineMs}ms`,
        ),
      );
    }, deadlineMs);
    timer.unref?.();

    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error: Error) => {
      clearTimeout(timer);
      void client.close();
      reject(new Error(`handshake refused: ${error.message}`));
    });
  });

  return client;
}

export interface HandshakeAttempt {
  connected: boolean;
  /** The disconnect reason or the connect_error message. */
  reason: string | null;
  close(): Promise<void>;
}

/**
 * Connect WITHOUT asserting success, for the rejection cases.
 *
 * The gateway refuses by calling `disconnect(true)` AFTER the namespace has
 * been joined rather than by failing the handshake, so "refused" shows up as a
 * connect immediately followed by a server-side disconnect — not as a
 * `connect_error`. This resolves once either has settled, so a test can assert
 * which one happened instead of guessing.
 */
export async function attemptRealtime(
  options: RealtimeClientOptions,
  settleMs = 1_500,
): Promise<HandshakeAttempt> {
  const socket = build(options);
  const client = instrument(socket);

  const outcome = await new Promise<{
    connected: boolean;
    reason: string | null;
  }>((resolve) => {
    const timer = setTimeout(
      () => resolve({ connected: socket.connected, reason: null }),
      settleMs,
    );
    timer.unref?.();

    socket.once('connect_error', (error: Error) => {
      clearTimeout(timer);
      resolve({ connected: false, reason: error.message });
    });
    socket.once('disconnect', (reason: string) => {
      clearTimeout(timer);
      resolve({ connected: false, reason });
    });
  });

  return { ...outcome, close: () => client.close() };
}
