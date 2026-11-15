/**
 * ===========================================================================
 * A REAL socket.io CLIENT, BUILT FROM NODE BUILT-INS — no new dependency
 * ===========================================================================
 *
 * WHY THIS EXISTS. `auth-password-change.int-spec.ts` carried an `it.todo` for
 * the one property nothing exercised end to end: that changing a password
 * closes a websocket that was ALREADY OPEN. `realtime-auth.int-spec.ts` drives
 * `handleConnection` directly with a `FakeSocket`, which proves the handshake
 * LOGIC but never opens a connection, never goes through the socket.io server,
 * and cannot observe a disconnect the server initiates later.
 *
 * SUPERSEDED FOR NEW TESTS — see `support/realtime-client.ts`.
 *
 * When this was written `socket.io-client` was not a dependency of this
 * workspace and was not present anywhere in the pnpm store, so importing it
 * would have meant adding one. It is a devDependency now (`4.8.3`, matching the
 * server), because both front-ends open a real socket and a test that
 * reimplements the protocol proves nothing about the client the customer runs.
 *
 * This file is kept, unchanged in behaviour, because
 * `auth-password-change.int-spec.ts` is built on it and passes: rewriting a
 * green test to use a different client would risk the assertion it exists to
 * make for no gain. New realtime tests use the real client.
 *
 * The description below remains accurate about what THIS helper does: it speaks
 * socket.io's wire protocol over HTTP long-polling with the global `fetch` Node
 * has shipped since 18, directly against the REAL gateway on the REAL bound
 * test server.
 *
 * ---------------------------------------------------------------------------
 * THE PROTOCOL, in the two layers it actually has
 *
 * ENGINE.IO v4 frames a packet as `<type><payload>` and batches several into
 * one HTTP body separated by RECORD SEPARATOR (U+001E):
 *
 *   0  OPEN     the handshake; payload is JSON: { sid, pingInterval, ... }
 *   1  CLOSE    the server is ending the transport
 *   2  PING     the server's heartbeat; the client MUST answer
 *   3  PONG     the client's answer
 *   4  MESSAGE  the payload is a socket.io packet
 *
 * SOCKET.IO v5 then frames ITS packet inside a MESSAGE, so the two type bytes
 * appear together:
 *
 *   40  CONNECT        namespace joined; payload is { sid }
 *   41  DISCONNECT     the server closed the namespace connection
 *   42  EVENT          a normal emit
 *   44  CONNECT_ERROR  the namespace refused the connection
 *
 * THE PING MUST BE ANSWERED. If the client ignores `2`, the server closes the
 * socket on `pingTimeout` — and this helper exists to observe a close, so a
 * close it caused itself would be a false positive. `pump()` replies to every
 * ping, which is why a socket left open in a test stays open for the right
 * reason.
 *
 * WHY POLLING AND NOT WEBSOCKET. socket.io begins every connection on polling
 * and only upgrades if the client asks. Never asking keeps this client to one
 * transport and a few `fetch` calls, and changes nothing the gateway sees:
 * `handleConnection`, the cookie parsing, the `audience` query, the room joins
 * and `disconnect(true)` are all transport-agnostic.
 */
import { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/** Engine.io batches packets in one body, separated by U+001E. */
const RECORD_SEPARATOR = '\u001e';

export interface TestSocketOptions {
  /** The bound test HTTP server; its real port is read from it. */
  server: Server;
  /** A `Cookie:` header value — the same jar the HTTP tests use. */
  cookie: string;
  /**
   * Which application is connecting. The gateway REQUIRES it and refuses a
   * handshake that does not name a valid audience, so it has no default here.
   */
  audience: string;
}

export interface TestSocket {
  /** The socket.io namespace session id, once connected. */
  readonly namespaceSid: string | null;
  /** False once the server has closed the connection, for any reason. */
  isOpen(): boolean;
  /** Why it closed, for a failing assertion to print. */
  closeReason(): string | null;
  /**
   * Resolves as soon as the server closes the connection.
   *
   * REJECTS on the deadline rather than resolving false: a test that wanted a
   * disconnect and did not get one must fail with "still open after N ms", not
   * quietly continue. There is no sleep here — the long poll is already waiting
   * on the server, so the close is observed the moment it is sent.
   */
  waitForClose(deadlineMs: number): Promise<string>;
  /**
   * Asserts the connection is STILL open after one full server heartbeat.
   *
   * The honest inverse of `waitForClose`: "it did not close" is only meaningful
   * once the server has had an opportunity to close it, and the heartbeat is
   * the shortest interval in which the server definitely spoke.
   */
  stillOpenAfterHeartbeat(): Promise<void>;
  /** Ends the client side. Safe to call twice. */
  close(): Promise<void>;
}

interface OpenHandshake {
  sid: string;
  pingInterval: number;
  pingTimeout: number;
}

/**
 * Opens a real connection and returns once the namespace is joined — or once
 * the gateway has refused it, which is itself a valid outcome a caller may
 * assert on via `isOpen()`.
 */
export async function connectTestSocket(
  options: TestSocketOptions,
): Promise<TestSocket> {
  const { port } = options.server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const base =
    `${origin}/socket.io/?EIO=4&transport=polling` +
    `&audience=${encodeURIComponent(options.audience)}`;
  const headers = { cookie: options.cookie };

  // ---- 1. engine.io handshake -------------------------------------------
  const openResponse = await fetch(`${base}&t=${stamp()}`, {
    headers,
    signal: AbortSignal.timeout(5_000),
  });
  if (!openResponse.ok) {
    throw new Error(
      `engine.io handshake failed: ${openResponse.status} ${await openResponse.text()}`,
    );
  }
  const handshake = parseOpen(await openResponse.text());
  const session = `${base}&sid=${handshake.sid}`;

  // ---- 2. socket.io CONNECT to the default namespace ---------------------
  await post(session, headers, '40');

  // ---- 3. the long-poll pump ---------------------------------------------
  let open = true;
  let reason: string | null = null;
  let namespaceSid: string | null = null;
  let closeSignalled: ((why: string) => void) | null = null;
  const closed = new Promise<string>((resolve) => {
    closeSignalled = resolve;
  });

  const markClosed = (why: string): void => {
    if (!open) return;
    open = false;
    reason = why;
    closeSignalled?.(why);
  };

  const pump = async (): Promise<void> => {
    while (open) {
      let body: string;
      try {
        const response = await fetch(`${session}&t=${stamp()}`, {
          headers,
          // Comfortably longer than the server's heartbeat, so an ordinary
          // quiet period is never mistaken for a close.
          signal: AbortSignal.timeout(handshake.pingInterval + 10_000),
        });
        if (response.status === 400) {
          // "Session ID unknown" — the server already dropped the session.
          markClosed(
            `transport session dropped (400 ${await response.text()})`,
          );
          return;
        }
        body = await response.text();
      } catch (error) {
        markClosed(`poll failed: ${String(error)}`);
        return;
      }

      for (const packet of body.split(RECORD_SEPARATOR)) {
        if (packet === '') continue;
        const type = packet[0];

        if (type === '1') {
          markClosed('engine.io CLOSE');
          return;
        }
        if (type === '2') {
          // PING -> PONG. Unanswered, the server would close us on pingTimeout
          // and every close assertion would be a false positive.
          await post(session, headers, '3').catch(() => undefined);
          continue;
        }
        if (type !== '4') continue;

        const socketIoType = packet.slice(1, 2);
        if (socketIoType === '0') {
          const payload = packet.slice(2);
          namespaceSid = payload ? safeSid(payload) : null;
          continue;
        }
        if (socketIoType === '1') {
          markClosed('socket.io DISCONNECT');
          return;
        }
        if (socketIoType === '4') {
          markClosed(`socket.io CONNECT_ERROR ${packet.slice(2)}`);
          return;
        }
      }
    }
  };

  // Deliberately NOT awaited: the pump runs for the socket's lifetime. The
  // catch keeps an unobserved rejection out of the test runner.
  void pump().catch(() => undefined);

  // ---- 4. settle: connected, or refused ----------------------------------
  // The gateway decides in `handleConnection`, synchronously with the
  // namespace connect, so the very first poll carries either `40` or `41`.
  await Promise.race([
    closed,
    waitUntil(() => namespaceSid !== null, 5_000, 'namespace connect'),
  ]);

  return {
    get namespaceSid() {
      return namespaceSid;
    },
    isOpen: () => open,
    closeReason: () => reason,
    waitForClose: (deadlineMs: number) =>
      open
        ? Promise.race([
            closed,
            rejectAfter(
              deadlineMs,
              `socket was still open ${deadlineMs}ms after the sweep`,
            ),
          ])
        : Promise.resolve(reason ?? 'already closed'),
    stillOpenAfterHeartbeat: async () => {
      const settled = await Promise.race([
        closed.then((why) => `closed: ${why}`),
        // One heartbeat plus a small margin: by then the server has spoken at
        // least once, so "no close" is a statement about the server and not
        // about how fast this test ran.
        sleepResolve(handshake.pingInterval + 500, 'still open'),
      ]);
      if (settled !== 'still open') {
        throw new Error(`expected the socket to stay open, but it ${settled}`);
      }
    },
    close: async () => {
      if (!open) return;
      open = false;
      reason = 'closed by the test';
      closeSignalled?.(reason);
      await post(session, headers, '1').catch(() => undefined);
    },
  };
}

// ===========================================================================
// helpers
// ===========================================================================

/** engine.io wants a cache-buster; its value is never interpreted. */
function stamp(): string {
  return Math.random().toString(36).slice(2);
}

async function post(
  session: string,
  headers: Record<string, string>,
  payload: string,
): Promise<void> {
  await fetch(session, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'text/plain;charset=UTF-8' },
    body: payload,
    signal: AbortSignal.timeout(5_000),
  });
}

function parseOpen(body: string): OpenHandshake {
  const packet = body.split(RECORD_SEPARATOR)[0] ?? '';
  if (packet[0] !== '0') {
    throw new Error(
      `expected an engine.io OPEN packet, got ${JSON.stringify(body)}`,
    );
  }
  const parsed = JSON.parse(packet.slice(1)) as OpenHandshake;
  if (!parsed.sid) throw new Error('engine.io OPEN carried no sid');
  return parsed;
}

function safeSid(payload: string): string | null {
  try {
    return (JSON.parse(payload) as { sid?: string }).sid ?? null;
  } catch {
    return null;
  }
}

function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
}

function sleepResolve<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(value), ms);
    timer.unref?.();
  });
}

/** Polls a predicate until it holds or the deadline passes. */
async function waitUntil(
  predicate: () => boolean,
  deadlineMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleepResolve(10, undefined);
  }
}
