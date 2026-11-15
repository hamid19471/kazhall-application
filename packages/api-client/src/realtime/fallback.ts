/**
 * Socket.IO primary, polling fallback — composed through the EXISTING
 * `RealtimeTransport` seam rather than beside it.
 *
 * This is not a second realtime abstraction. It is one more implementation of
 * `RealtimeTransport` whose job is to run two other `RealtimeTransport`s and
 * decide which of them the client is currently listening to. `createRealtimeClient`
 * cannot tell the difference, and neither can a subscriber.
 *
 * ## The state machine, stated exactly
 *
 * | condition                        | what runs                    | what the UI sees          |
 * |----------------------------------|------------------------------|---------------------------|
 * | socket connected                 | socket only                  | `open`, event-driven      |
 * | socket down < `graceMs`          | socket only (reconnecting)   | `reconnecting`, no polling |
 * | socket down ≥ `graceMs`          | socket + **bounded polling** | `reconnecting`, polled     |
 * | socket reconnects                | socket only again            | `open` + ONE `resync`      |
 *
 * ### Why a grace period rather than polling the moment the socket blinks
 *
 * A socket.io reconnect after a dropped frame or a server restart usually
 * completes in well under a second. Starting an HTTP poller on every blink
 * would spend a request on a gap the socket was about to close by itself, and
 * `createPollingTransport` polls IMMEDIATELY on start. `graceMs` buys exactly
 * the interval in which "disconnected" and "about to be connected again" are
 * the same thing.
 *
 * ### Why the fallback is stopped BEFORE the reconnect resync fires
 *
 * `createSocketIoTransport` calls `setStatus("open")` and then `resync(...)` from
 * inside the same `connect` handler, synchronously and in that order. This
 * transport tears the poller down on the `setStatus("open")` edge, so by the time
 * the `resync` reaches the UI the poller is already gone: the UI issues ONE
 * authoritative refetch, not one plus whatever cycle the poller had in flight.
 * That is the "immediate authoritative refetch, then stop unnecessary fallback
 * polling" rule, in the only order that actually produces one request.
 *
 * ### Why the fallback's own `resync` is suppressed on its first cycle
 *
 * `createPollingTransport` fires `resync("connected")` after its first clean
 * cycle, because as a PRIMARY transport that first cycle is its connection. As
 * a FALLBACK it is not: the UI already has state, and the poller was started
 * precisely because the socket went away — an extra `resync` here would be a
 * second full refetch on top of the poll that just ran. Its later
 * `resync("poll-recovered")` frames are forwarded, because those really do mark
 * a gap.
 */

import type { RealtimeTransport, RealtimeTransportContext } from "./client";
import type { RealtimeStatus } from "./types";

export interface FallbackTransportOptions {
  /** The transport that should normally carry traffic. */
  primary: RealtimeTransport;
  /**
   * Started only while `primary` is down. REQUIRED, and deliberately not
   * defaulted to `createPollingTransport()`.
   *
   * Defaulting it would mean importing `./polling` at runtime, and that turns
   * this module — which is otherwise pure decision logic over two injected
   * objects — into something with a dependency graph. It also hides the most
   * important line at the composition root: which transport actually pays for
   * the outage. Each app names it; see `lib/realtime-transport.ts`.
   */
  fallback: RealtimeTransport;
  /**
   * How long `primary` may be down before the fallback starts. Default 2000 ms.
   * `0` starts it on the first failed edge.
   */
  graceMs?: number;
}

/** Statuses that mean "the primary is not carrying traffic right now". */
function isDown(status: RealtimeStatus): boolean {
  return status === "reconnecting" || status === "error";
}

export function createFallbackTransport(options: FallbackTransportOptions): RealtimeTransport {
  const { primary, fallback } = options;
  const graceMs = options.graceMs ?? 2_000;

  let ctx: RealtimeTransportContext | undefined;
  let stopped = true;
  let fallbackRunning = false;
  let fallbackFirstResyncSeen = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const clearGrace = (): void => {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    graceTimer = undefined;
  };

  const startFallback = (): void => {
    if (stopped || fallbackRunning || !ctx) return;
    fallbackRunning = true;
    fallbackFirstResyncSeen = false;
    void Promise.resolve(fallback.start(fallbackContext(ctx))).catch(() => undefined);
  };

  const stopFallback = (): void => {
    if (!fallbackRunning) return;
    fallbackRunning = false;
    void Promise.resolve(fallback.stop()).catch(() => undefined);
  };

  /**
   * The poller sees a REAL context for everything it needs to do its job —
   * `client`, `interests`, `onInterestChange`, `emit` — and a muted one for the
   * two signals that would otherwise fight the socket for control of the UI.
   */
  const fallbackContext = (outer: RealtimeTransportContext): RealtimeTransportContext => ({
    client: outer.client,
    emit: (event, payload) => outer.emit(event, payload),
    interests: outer.interests,
    onInterestChange: outer.onInterestChange,
    // The composite owns `status`. A poller that has just started while the
    // socket is retrying must not report `open`.
    setStatus: () => undefined,
    resync: (reason) => {
      if (!fallbackFirstResyncSeen) {
        fallbackFirstResyncSeen = true;
        // "connected" here means "the poller completed a cycle", not "a gap
        // just closed". Swallow it; the cycle itself already refreshed state.
        if (reason === "connected") return;
      }
      outer.resync(reason);
    },
  });

  const primaryContext = (outer: RealtimeTransportContext): RealtimeTransportContext => ({
    client: outer.client,
    emit: (event, payload) => outer.emit(event, payload),
    interests: outer.interests,
    onInterestChange: outer.onInterestChange,
    resync: (reason) => outer.resync(reason),
    setStatus: (status) => {
      if (stopped) return;
      if (status === "open") {
        // Order matters: tear the poller down FIRST, so the `resync` the socket
        // is about to fire is the only refetch the UI performs.
        clearGrace();
        stopFallback();
      } else if (isDown(status)) {
        if (!fallbackRunning && graceTimer === undefined) {
          graceTimer = setTimeout(() => {
            graceTimer = undefined;
            startFallback();
          }, graceMs);
          // Never hold a Node process open for a fallback timer.
          (graceTimer as unknown as { unref?: () => void }).unref?.();
        }
      }
      outer.setStatus(status);
    },
  });

  return {
    name: `${primary.name}+${fallback.name}`,

    start(nextCtx) {
      ctx = nextCtx;
      stopped = false;
      fallbackRunning = false;
      clearGrace();
      void Promise.resolve(primary.start(primaryContext(nextCtx))).catch(() =>
        nextCtx.setStatus("error"),
      );
    },

    stop() {
      stopped = true;
      clearGrace();
      stopFallback();
      ctx = undefined;
      return Promise.resolve(primary.stop()).catch(() => undefined) as unknown as void;
    },
  };
}
