/**
 * One authoritative refetch channel, with the two guarantees a pushed event
 * needs and a plain `refetch()` does not give you.
 *
 * `availability:updated` is ADVISORY. It says "something about this variant
 * changed", never what it changed to, so the only correct reaction is to read
 * the authoritative endpoint again. That reaction has two failure modes, and
 * this module exists to close both.
 *
 * ## 1. The burst
 *
 * A single till sale emits one `availability:updated` per consumed variant. A
 * basket holding three of them receives three frames in the same tick. Add the
 * socket's reconnect `resync` and a `visibilitychange` landing in the same
 * moment and a naive `refetch()` per signal issues five `GET /cart` calls for
 * one event.
 *
 * The rule here is **one in flight, at most one trailing**. Signals that arrive
 * while a read is in flight collapse into a single follow-up read, which is
 * issued once the first settles — never a queue, never a per-signal request.
 * The follow-up is not optional: the in-flight read may have been issued before
 * the change committed, so exactly one more is the minimum that is still
 * correct.
 *
 * ## 2. The overtake
 *
 * Two reads in flight can settle in the wrong order and paint stale state over
 * fresh state. Because this channel keeps only one read in flight, that cannot
 * happen between its own reads — but a cart MUTATION (`POST /cart/items`) runs
 * outside it and can settle late.
 *
 * So every read and every externally-claimed authoritative call takes a ticket
 * from one monotonic counter, and {@link AuthoritativeChannel.commit} applies a
 * result only if its ticket is newer than the last one applied. An older
 * response is dropped, loudly (it increments `metrics.dropped`) rather than
 * silently.
 *
 * A duplicated or out-of-order EVENT is therefore harmless by construction: it
 * can only ever cause one more authoritative read, and a read can only ever
 * move the rendered state forward.
 *
 * This module is deliberately framework-free and side-effect-free so it can be
 * tested directly under `node --test`.
 */

export interface AuthoritativeChannelOptions<T> {
  /** Reads the authoritative state. Must honour `signal`. */
  read: (signal: AbortSignal) => Promise<T>;
  /** Called with a result that WON the ordering check. */
  onResult: (value: T) => void;
  /** Called for a failure of a read that would otherwise have been applied. */
  onError?: (error: unknown) => void;
  /**
   * Treated as "not a failure and not a result" — an aborted read is a read we
   * replaced on purpose. Defaults to matching `ApiError.kind === "aborted"` and
   * `DOMException` `AbortError`.
   */
  isAborted?: (error: unknown) => boolean;
  /**
   * Floor on how often a read may START. Default `0` — no floor.
   *
   * The basket wants no floor: its trigger is already narrow (an event naming a
   * variant this basket holds), so every signal deserves a read, immediately.
   *
   * A CATALOGUE LISTING is the opposite case. `availability:updated` is a
   * global broadcast covering every variant in the shop, and a listing page
   * cannot tell which of them it is showing — `GET /products` returns a
   * product-level `inStock`, not variant ids. Un-floored, a busy shop would
   * turn one listing into a continuous refetch loop running as fast as the
   * server answers.
   *
   * The floor applies to the START of a read, not to the signal: a signal
   * arriving inside the window is not dropped, it is deferred to the window's
   * edge and folded in with every other signal that arrives before then.
   */
  minIntervalMs?: number;
  /** Injectable clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface AuthoritativeMetrics {
  /** Tickets handed out — reads plus external claims. */
  issued: number;
  /** Reads actually started. */
  started: number;
  /** Signals folded into an existing in-flight or trailing read. */
  coalesced: number;
  /** Results applied to the UI. */
  applied: number;
  /** Results discarded because a newer one had already been applied. */
  dropped: number;
}

export interface AuthoritativeChannel<T> {
  /** Ask for authoritative state. Coalesces; never queues. */
  refresh(): void;
  /**
   * Reserve a ticket for an authoritative response produced OUTSIDE this
   * channel (a mutation whose response is the new state).
   */
  claim(): number;
  /** Apply `value` iff `ticket` is newer than the last applied. Returns whether it won. */
  commit(ticket: number, value: T): boolean;
  /**
   * Bracket a mutation. The returned function MUST be called when the mutation
   * settles, success or failure: it issues the one trailing read that proves
   * the final rendered state came from the newest authoritative response.
   */
  beginMutation(): () => void;
  /** True while a read is in flight. */
  readonly busy: boolean;
  /**
   * Abort any in-flight read and forget any trailing one.
   *
   * NOT a latch: a later {@link AuthoritativeChannel.refresh} starts cleanly.
   * Results from before the stop can never be applied afterwards.
   */
  stop(): void;
  readonly metrics: Readonly<AuthoritativeMetrics>;
}

function defaultIsAborted(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { kind?: unknown; name?: unknown };
  return candidate.kind === "aborted" || candidate.name === "AbortError";
}

export function createAuthoritativeChannel<T>(
  options: AuthoritativeChannelOptions<T>,
): AuthoritativeChannel<T> {
  const isAborted = options.isAborted ?? defaultIsAborted;
  const minIntervalMs = options.minIntervalMs ?? 0;
  const now = options.now ?? Date.now;

  let ticketCounter = 0;
  let lastApplied = 0;
  let inFlight: AbortController | undefined;
  let trailing = false;
  let mutationsInFlight = 0;
  /**
   * Bumped by {@link stop}. A read carries the generation it started in and is
   * discarded wholesale if that generation has ended.
   *
   * This is a counter and not a `stopped` boolean on purpose. React Strict Mode
   * mounts an effect, tears it down and mounts it again against the SAME
   * memoized channel, so a latch would leave the second mount holding a channel
   * that silently refuses to fetch — a blank cart in development only, which is
   * exactly the kind of bug that gets "fixed" by deleting the cleanup.
   */
  let generation = 0;
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  let deferTimer: ReturnType<typeof setTimeout> | undefined;

  const metrics: AuthoritativeMetrics = {
    issued: 0,
    started: 0,
    coalesced: 0,
    applied: 0,
    dropped: 0,
  };

  const nextTicket = (): number => {
    metrics.issued += 1;
    ticketCounter += 1;
    return ticketCounter;
  };

  const apply = (ticket: number, value: T): boolean => {
    // `>` not `>=`: a ticket is used once, and equality would mean the same
    // read was committed twice.
    if (ticket <= lastApplied) {
      metrics.dropped += 1;
      return false;
    }
    lastApplied = ticket;
    metrics.applied += 1;
    options.onResult(value);
    return true;
  };

  const start = (): void => {
    lastStartedAt = now();
    const controller = new AbortController();
    const gen = generation;
    inFlight = controller;
    // The ticket is taken when the read STARTS, not when it was requested, so a
    // trailing read always outranks the one it follows.
    const ticket = nextTicket();
    metrics.started += 1;

    options
      .read(controller.signal)
      .then((value) => {
        if (gen !== generation || controller.signal.aborted) return;
        apply(ticket, value);
      })
      .catch((error: unknown) => {
        if (gen !== generation || controller.signal.aborted) return;
        if (isAborted(error)) return;
        // A failed read must NOT advance `lastApplied`: the state it would have
        // carried never existed, so a later-issued read must still be free to
        // win, and an earlier one that is still in flight must still be able to.
        options.onError?.(error);
      })
      .finally(() => {
        if (inFlight === controller) inFlight = undefined;
        if (gen !== generation) return;
        if (trailing) {
          trailing = false;
          // The trailing read respects the floor too, so a fast server cannot
          // turn "at most one trailing read" into a treadmill.
          startOrDefer();
        }
      });
  };

  /** Start now if the floor allows it, otherwise at the edge of the window. */
  const startOrDefer = (): void => {
    if (deferTimer !== undefined) return;
    const wait = minIntervalMs <= 0 ? 0 : minIntervalMs - (now() - lastStartedAt);
    if (wait <= 0) {
      start();
      return;
    }
    const gen = generation;
    deferTimer = setTimeout(() => {
      deferTimer = undefined;
      if (gen !== generation) return;
      start();
    }, wait);
    (deferTimer as unknown as { unref?: () => void }).unref?.();
  };

  const refresh = (): void => {
    if (inFlight) {
      // Already reading. Fold into the SINGLE trailing read; never queue.
      if (trailing) metrics.coalesced += 1;
      else trailing = true;
      return;
    }
    if (deferTimer !== undefined) {
      // Already waiting out the floor; this signal joins that pending read.
      metrics.coalesced += 1;
      return;
    }
    startOrDefer();
  };

  return {
    refresh,

    claim: nextTicket,

    commit(ticket, value) {
      return apply(ticket, value);
    },

    beginMutation() {
      mutationsInFlight += 1;
      let settled = false;
      return () => {
        if (settled) return;
        settled = true;
        mutationsInFlight -= 1;
        // Unconditional: whatever the mutation did or failed to do, the state
        // that renders must come from an authoritative read issued AFTER it.
        refresh();
      };
    },

    get busy() {
      return inFlight !== undefined || mutationsInFlight > 0;
    },

    stop() {
      generation += 1;
      trailing = false;
      if (deferTimer !== undefined) clearTimeout(deferTimer);
      deferTimer = undefined;
      inFlight?.abort();
      inFlight = undefined;
    },

    metrics,
  };
}
