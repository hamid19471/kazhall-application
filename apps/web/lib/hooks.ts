"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  INITIAL_CLOCK_STATE,
  announceRemaining,
  foldClockSample,
  formatDuration,
  secondsRemaining,
  type ClockState,
} from "./reservation-clock";

/**
 * ===========================================================================
 * THE SERVER'S CLOCK, NOT THE DEVICE'S
 * ===========================================================================
 *
 * A basket reservation is a promise the SERVER made for four hours from the
 * instant IT recorded. Counting down to that instant with `Date.now()` trusts
 * the device's clock, and a device whose clock is five minutes fast shows a
 * customer losing five minutes they still have; one that is five minutes slow
 * shows time remaining on a hold the server has already released and then
 * "loses" the line without warning.
 *
 * Every successful API response carries the server's own `timeStamp`, so the
 * offset is measurable rather than assumed. `recordServerTime` is wired into
 * the API client once (see `components/providers.tsx`) and fires on every
 * successful call, so the offset stays fresh for as long as the tab is open.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE:
 *
 *  - The offset NEVER moves a deadline. It adjusts what "now" means, so a
 *    countdown can only ever become more accurate, never longer. Nothing in
 *    this file can extend a reservation, because nothing in this file knows
 *    how long a reservation is.
 *  - A single sample is not trusted. Network latency inflates every
 *    measurement, so the offset keeps the sample with the SMALLEST round trip
 *    seen — the closest thing the browser has to a latency-free reading — and
 *    ignores noisier ones.
 *  - An implausible offset is ignored entirely. Anything beyond
 *    {@link MAX_TRUSTED_SKEW_MS} is far more likely to be a broken response
 *    than a genuinely mis-set clock, and silently shifting a countdown by
 *    hours because one response was strange would be worse than the skew.
 */

let clockState: ClockState = INITIAL_CLOCK_STATE;
/** Notified when the offset actually changes, so live countdowns re-render. */
const offsetListeners = new Set<() => void>();

/**
 * Records one observation of the server's clock.
 *
 * The POLICY lives in `foldClockSample` — which sample to trust, how much
 * latency to attribute, what to reject — so it can be tested without a
 * network. This function is only the plumbing: keep the state, notify the
 * clocks. `requestStartedAtMs` is optional; without it the round trip is
 * unknown and no latency correction is applied.
 */
export function recordServerTime(
  serverTimeIso: string,
  receivedAtMs: number,
  requestStartedAtMs?: number,
): void {
  const next = foldClockSample(clockState, {
    serverTimeIso,
    receivedAtMs,
    ...(requestStartedAtMs === undefined ? {} : { roundTripMs: receivedAtMs - requestStartedAtMs }),
  });
  clockState = next.state;
  if (next.changed) for (const notify of offsetListeners) notify();
}

/** Test-only reset, so one page's samples cannot leak into the next. */
export function resetServerClock(): void {
  clockState = INITIAL_CLOCK_STATE;
  for (const notify of offsetListeners) notify();
}

/** The current best estimate of the server's clock, in epoch milliseconds. */
export function serverNow(): number {
  return Date.now() + clockState.offsetMs;
}

/** How far the device's clock is believed to be behind the server's. */
export function serverClockOffsetMs(): number {
  return clockState.offsetMs;
}

/**
 * A ticking "now", for countdowns.
 *
 * Modelled as an EXTERNAL STORE rather than `useState` + `useEffect`, because
 * the wall clock genuinely is external to React: subscribing to it is exactly
 * what `useSyncExternalStore` is for, and the alternative (setting state from
 * inside an effect on mount) causes the cascading re-render the React lint
 * rules now reject.
 *
 * The server snapshot is `null`. The server has no idea what time the browser
 * thinks it is, so rendering a countdown into the HTML would both guarantee a
 * hydration mismatch and bake a stale remaining-time into the markup. Callers
 * render a placeholder until this is non-null.
 *
 * ONE TIMER FOR THE WHOLE PAGE, per interval. The clock used to be built with
 * `useMemo` inside this hook, which gave every calling component its own
 * `setInterval`: a basket with eight lines, each with its own line countdown
 * and its own per-tranche countdowns, ran a dozen independent one-second
 * timers that fired at a dozen different moments — a dozen separate render
 * passes per second, and visibly unsynchronised digits. The registry below is
 * module-scoped and keyed by interval, so every countdown on the page shares
 * one timer, ticks on the same frame, and the timer stops the moment the last
 * subscriber unmounts.
 */
export function useNow(intervalMs = 1000): number | null {
  const clock = sharedClock(intervalMs);
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, () => null);
}

type Clock = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => number;
};

const clocks = new Map<number, Clock>();

function sharedClock(intervalMs: number): Clock {
  let clock = clocks.get(intervalMs);
  if (!clock) {
    clock = createClock(intervalMs);
    clocks.set(intervalMs, clock);
  }
  return clock;
}

/**
 * A shared ticking clock.
 *
 * `getSnapshot` MUST be referentially stable between ticks — returning a fresh
 * `Date.now()` on every call would make React believe the store changed on
 * every render and loop forever. So the value is cached and only replaced when
 * the interval fires.
 *
 * It reports the SERVER's now, so a device with a skewed clock counts down to
 * the right instant. A change in the measured offset also notifies, because a
 * countdown that is two minutes wrong should correct itself as soon as the
 * next response says so rather than at the next tick of a stale offset.
 */
function createClock(intervalMs: number): Clock {
  let now = serverNow();
  let timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();

  const tick = () => {
    now = serverNow();
    for (const notify of listeners) notify();
  };

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (timer === undefined) {
        now = serverNow();
        timer = setInterval(tick, intervalMs);
        offsetListeners.add(tick);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
          offsetListeners.delete(tick);
        }
      };
    },
    getSnapshot(): number {
      return now;
    },
  };
}

export interface Countdown {
  /** Whole seconds left, floored at 0. `null` before mount. */
  secondsLeft: number | null;
  expired: boolean;
  /** `HH:MM:SS`-ish Persian text, or `null` before mount. */
  text: string | null;
  /**
   * A COARSE description of the time left, which changes only when it becomes
   * worth telling somebody.
   *
   * A countdown in an `aria-live` region that updates every second is unusable
   * with a screen reader: it interrupts continuously and drowns out everything
   * else on the page. This string is stable between thresholds — above an hour
   * it changes once an hour, then at 30, 10, 5 and 1 minute, then at zero — so
   * a live region bound to it speaks five or six times over a four-hour hold
   * instead of fourteen thousand.
   *
   * `null` before mount, like the rest.
   */
  announcement: string | null;
  /** The deadline itself, for a `<time datetime>` attribute. `null` if unknown. */
  deadlineIso: string | null;
}

/**
 * Count down to a server-supplied instant.
 *
 * The instant is ALWAYS the server's `expiresAt`. A page refresh therefore
 * cannot extend a reservation: reloading re-reads the same absolute deadline
 * rather than restarting a local four-hour timer. Nothing here can move a
 * deadline — this hook is given one and reports on it.
 *
 * `onExpire` fires ONCE per deadline, at the moment the remaining time reaches
 * zero, and is how the basket reconciles with the server rather than leaving a
 * line on screen that the server has already released. It is not a retry loop:
 * a second crossing of the same deadline cannot happen, and a NEW deadline
 * arms it again because the deadline is what identifies the crossing.
 */
export function useCountdown(
  expiresAt: string | null | undefined,
  options: { intervalMs?: number; onExpire?: () => void } = {},
): Countdown {
  const { intervalMs = 1000, onExpire } = options;
  const now = useNow(intervalMs);

  // The deadline whose expiry has already been reported. Compared by VALUE, so
  // a re-render with the same `expiresAt` cannot fire twice and a genuinely new
  // tranche fires again.
  const firedFor = useRef<string | null>(null);

  /*
   * The latest `onExpire`, kept in a ref so the expiry effect below does not
   * re-run every time the parent passes a new inline closure — which it does
   * on every render, and which would re-arm the crossing check constantly.
   *
   * SYNCED IN AN EFFECT, NOT DURING RENDER. Assigning `ref.current` while
   * rendering is a React error (`react-hooks/refs` rejects it, correctly): a
   * render may be thrown away or replayed, and a ref written during one is a
   * side effect escaping a pure phase. Declared FIRST so it commits before the
   * expiry effect that reads it.
   */
  const onExpireRef = useRef(onExpire);
  useEffect(() => {
    onExpireRef.current = onExpire;
  });

  // The arithmetic lives in `reservation-clock.ts` — the same function the
  // tests exercise — rather than being restated here where nothing checks it.
  const secondsLeft = now === null ? null : secondsRemaining(expiresAt, now);
  const known = secondsLeft !== null;
  const expired = secondsLeft === 0;

  /*
   * Fired from an effect, not during render. Calling a parent's callback while
   * rendering is a React error, and this one triggers a refetch — the exact
   * shape of side effect that must be sequenced after the commit.
   */
  useEffect(() => {
    if (!expired || !expiresAt) return;
    if (firedFor.current === expiresAt) return;
    firedFor.current = expiresAt;
    onExpireRef.current?.();
  }, [expired, expiresAt]);

  return {
    secondsLeft,
    expired: known ? expired : false,
    text: secondsLeft === null ? null : formatDuration(secondsLeft),
    announcement: secondsLeft === null ? null : announceRemaining(secondsLeft),
    deadlineIso: known ? (expiresAt ?? null) : null,
  };
}




/**
 * A cooldown that counts down from a server-supplied `retryAfterSeconds`.
 *
 * Used for the OTP resend gate. The server is the authority: `start(seconds)`
 * is only ever called with a figure the API actually returned in
 * `details.retryAfterSeconds`, never with a number this app invented.
 */
export function useCooldown(): {
  remaining: number;
  active: boolean;
  start: (seconds: number) => void;
  clear: () => void;
} {
  const [until, setUntil] = useState<number | null>(null);
  const now = useNow(500);

  const start = useCallback((seconds: number) => {
    const safe = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 0;
    if (safe === 0) {
      setUntil(null);
      return;
    }
    setUntil(Date.now() + safe * 1000);
  }, []);

  const clear = useCallback(() => setUntil(null), []);

  const remaining =
    until === null || now === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000));

  return { remaining, active: remaining > 0, start, clear };
}

/**
 * A submit guard.
 *
 * Returns a `run` that refuses to start while a previous run is still in
 * flight. Every mutation in this app goes through it, so a double-click cannot
 * send a second request — which matters most on the routes where a second
 * request would be a second decision about somebody's money.
 */
export function useSubmit<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): {
  run: (...args: A) => Promise<R | undefined>;
  isPending: boolean;
} {
  const [isPending, setIsPending] = useState(false);
  // Read and written only from inside `run`, i.e. from an event handler —
  // never during render. It is the guard itself: `isPending` state lags by a
  // render and cannot stop the second half of a double-click.
  const inFlight = useRef(false);

  async function run(...args: A): Promise<R | undefined> {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setIsPending(true);
    try {
      return await fn(...args);
    } finally {
      inFlight.current = false;
      setIsPending(false);
    }
  }

  return { run, isPending };
}

/*
 * Re-exported so call sites keep importing from `@/lib/hooks`. The IMPLEMENTATION
 * lives in `reservation-clock.ts` because that module has no React import and
 * can therefore be tested by `node --test` without a renderer — which is the
 * only way to test anything in this package, since it has no test runner and
 * none may be added.
 */
export { announceRemaining, earliestExpiry, formatDuration, secondsRemaining } from "./reservation-clock";
