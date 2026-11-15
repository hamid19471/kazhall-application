/**
 * ===========================================================================
 * THE RESERVATION CLOCK — the arithmetic, with no React in it
 * ===========================================================================
 *
 * Everything here is a pure function of its arguments. That is the point: the
 * rules a basket reservation countdown has to obey are exactly the rules that
 * are easy to get wrong and hard to see wrong in a browser —
 *
 *   · a deadline that has passed shows zero, never a negative duration;
 *   · a page reload re-derives the SAME remaining time, because the deadline
 *     is the server's absolute instant and nothing here can mint one;
 *   · a line with several tranches is governed by the EARLIEST of them, since
 *     that is the first thing the customer can lose;
 *   · a device clock that disagrees with the server is corrected, but only
 *     within a plausible bound and only ever by changing what "now" means.
 *
 * `apps/web` has no test runner and none may be added, so these live apart
 * from the hooks that use them and are exercised directly by Node's built-in
 * `node:test` — no dependency, no bundler, no DOM. See
 * `reservation-clock.test.ts`.
 */

/** Beyond this, a reported offset is treated as nonsense and ignored. */
export const MAX_TRUSTED_SKEW_MS = 12 * 60 * 60 * 1000;

/** Offsets smaller than this are not worth re-rendering every open countdown. */
export const OFFSET_UPDATE_THRESHOLD_MS = 1000;

export interface ClockSample {
  /** The server's own `timeStamp`, as it appeared in the envelope. */
  serverTimeIso: string;
  /** `Date.now()` when the body was parsed. */
  receivedAtMs: number;
  /** Round trip, when the caller measured it. */
  roundTripMs?: number;
}

export interface ClockState {
  offsetMs: number;
  /** The smallest round trip seen so far; the least latency-polluted sample. */
  bestRoundTripMs: number;
}

export const INITIAL_CLOCK_STATE: ClockState = {
  offsetMs: 0,
  bestRoundTripMs: Number.POSITIVE_INFINITY,
};

/**
 * Folds one observation of the server's clock into the current estimate.
 *
 * Returns the new state and whether it changed enough to be worth telling
 * anybody. Pure, so the whole sampling policy is testable without a network.
 *
 * THE POLICY, AND WHY EACH PART IS THERE:
 *
 *  - A sample with a WORSE round trip than the best seen is discarded. Latency
 *    only ever inflates the apparent offset, so the fastest exchange is the
 *    closest thing the browser has to a latency-free reading. Averaging
 *    instead would let one slow response drag the estimate for the rest of the
 *    session.
 *  - Half the round trip is attributed to the response leg. That is exact when
 *    the legs are symmetric and conservative when they are not; with no
 *    measurement at all the correction is zero rather than a guess.
 *  - An offset beyond {@link MAX_TRUSTED_SKEW_MS} is ignored outright. Twelve
 *    hours of genuine clock skew is vanishingly rarer than one malformed
 *    timestamp, and shifting every countdown on the page by hours because of a
 *    single strange response is worse than tolerating the skew.
 *  - Sub-second changes do not propagate. A countdown ticking in whole seconds
 *    cannot show them, and re-rendering every open countdown to display the
 *    same digits is pure waste.
 */
export function foldClockSample(
  state: ClockState,
  sample: ClockSample,
): { state: ClockState; changed: boolean } {
  const serverMs = Date.parse(sample.serverTimeIso);
  if (Number.isNaN(serverMs)) return { state, changed: false };

  const roundTripMs = sample.roundTripMs ?? Number.POSITIVE_INFINITY;
  if (roundTripMs > state.bestRoundTripMs) return { state, changed: false };

  const responseLegMs = Number.isFinite(roundTripMs) ? roundTripMs / 2 : 0;
  const offsetMs = serverMs + responseLegMs - sample.receivedAtMs;

  if (Math.abs(offsetMs) > MAX_TRUSTED_SKEW_MS) return { state, changed: false };

  const bestRoundTripMs = Number.isFinite(roundTripMs)
    ? roundTripMs
    : state.bestRoundTripMs;

  if (Math.abs(offsetMs - state.offsetMs) < OFFSET_UPDATE_THRESHOLD_MS) {
    // The offset itself is not worth publishing, but a better round-trip
    // measurement still is: it raises the bar for the next sample.
    return { state: { offsetMs: state.offsetMs, bestRoundTripMs }, changed: false };
  }

  return { state: { offsetMs, bestRoundTripMs }, changed: true };
}

/**
 * Whole seconds between `nowMs` and a server deadline, floored at zero.
 *
 * `null` when there is no usable deadline — which is NOT the same as zero. A
 * line whose expiry the server did not send has an unknown deadline, and
 * showing "00:00" for it would tell the customer they had lost something they
 * had not.
 */
export function secondsRemaining(
  expiresAtIso: string | null | undefined,
  nowMs: number,
): number | null {
  if (!expiresAtIso) return null;
  const deadline = Date.parse(expiresAtIso);
  if (Number.isNaN(deadline)) return null;
  return Math.max(0, Math.floor((deadline - nowMs) / 1000));
}

const TWO_DIGIT_FA = new Intl.NumberFormat("fa-IR", {
  minimumIntegerDigits: 2,
  useGrouping: false,
});
const PLAIN_FA = new Intl.NumberFormat("fa-IR");

/**
 * `9045` → `"۲:۳۰:۴۵"`.
 *
 * Seconds are kept even above an hour: dropping them would round a deadline
 * the customer is watching, and "۲:۳۰ مانده" that sits unchanged for a minute
 * reads as a frozen page.
 */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const mm = TWO_DIGIT_FA.format(minutes);
  const ss = TWO_DIGIT_FA.format(seconds);
  if (hours > 0) return `${PLAIN_FA.format(hours)}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}

/**
 * The coarse, threshold-based wording an `aria-live` region announces.
 *
 * THRESHOLDS, NOT A FORMATTED DURATION. A live region re-announces whenever
 * its text changes, so binding one to a per-second countdown means a screen
 * reader interrupting once a second for four hours — the page becomes
 * unusable. This string is identical between milestones, so across a whole
 * four-hour hold it changes five or six times: once per hour, then at 30, 10,
 * 5 and 1 minute, then at zero.
 */
export function announceRemaining(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s === 0) return "مهلت نگهداری این کالا در سبد به پایان رسید.";

  const minutes = Math.floor(s / 60);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `حدود ${PLAIN_FA.format(hours)} ساعت تا پایان نگهداری این کالا در سبد.`;
  }

  /*
   * THE THRESHOLD NAMED IS THE ONE NOT YET PASSED.
   *
   * An earlier version announced the milestone the remaining time had fallen
   * BELOW, so four minutes left was read out as "less than 1 minute" — an
   * announcement that is not merely imprecise but FALSE, and false in the
   * direction that would make somebody abandon a basket they still had time
   * to check out. `reservation-clock.test.ts` asserts the invariant directly:
   * the sentence must never claim less time than actually remains.
   */
  if (minutes >= 30) return "کمتر از یک ساعت تا پایان نگهداری این کالا در سبد.";
  if (minutes >= 10) return `کمتر از ${PLAIN_FA.format(30)} دقیقه تا پایان نگهداری این کالا در سبد.`;
  if (minutes >= 5) return `کمتر از ${PLAIN_FA.format(10)} دقیقه تا پایان نگهداری این کالا در سبد.`;
  if (minutes >= 1) return `کمتر از ${PLAIN_FA.format(5)} دقیقه تا پایان نگهداری این کالا در سبد.`;
  return "کمتر از یک دقیقه تا پایان نگهداری این کالا در سبد.";
}

/**
 * The ceiling, in seconds, that {@link announceRemaining} claims at `seconds`.
 *
 * Exists so the truthfulness invariant can be asserted mechanically rather
 * than by reading the sentences.
 */
export function announcedCeilingSeconds(totalSeconds: number): number {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s === 0) return 0;
  const minutes = Math.floor(s / 60);
  if (minutes >= 60) return (Math.floor(minutes / 60) + 1) * 3600;
  if (minutes >= 30) return 3600;
  if (minutes >= 10) return 30 * 60;
  if (minutes >= 5) return 10 * 60;
  if (minutes >= 1) return 5 * 60;
  return 60;
}

/** The shape `earliestExpiry` needs: a line's own deadline plus its tranches. */
export interface ExpiringLine {
  expiresAt: string | null;
  tranches: Array<{ expiresAt: string | null }>;
}

/**
 * The instant a line first starts losing units.
 *
 * A quantity increase opens a NEW four-hour window, so one line can hold two
 * units until 14:00 and one more until 16:30. The line-level countdown follows
 * the EARLIEST of those, because that is the first thing the customer can
 * lose — following the latest would show time remaining while units were
 * already being released.
 *
 * Malformed or empty values are ignored rather than parsed into `NaN` and then
 * compared, which is how a single bad string would otherwise win every
 * comparison and silently become "the earliest".
 */
export function earliestExpiry(line: ExpiringLine): string | null {
  let best: string | null = null;
  let bestMs = Number.POSITIVE_INFINITY;

  const candidates = [line.expiresAt, ...line.tranches.map((t) => t.expiresAt)];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate === "") continue;
    const ms = Date.parse(candidate);
    if (Number.isNaN(ms)) continue;
    if (ms < bestMs) {
      bestMs = ms;
      best = candidate;
    }
  }
  return best;
}
