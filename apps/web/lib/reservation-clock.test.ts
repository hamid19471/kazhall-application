/**
 * Tests for the reservation-clock arithmetic.
 *
 * RUN WITH `pnpm test` IN `apps/web`, which is `node --test lib/*.test.ts`.
 *
 * Node's built-in test runner and its built-in TypeScript type stripping, so
 * this adds NO dependency to a package that deliberately has none beyond
 * `next`, `react` and `react-dom`. That constraint is also why the module
 * under test has no React import: a hook would need a renderer, and a renderer
 * would need a dependency.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  INITIAL_CLOCK_STATE,
  MAX_TRUSTED_SKEW_MS,
  announceRemaining,
  announcedCeilingSeconds,
  earliestExpiry,
  foldClockSample,
  formatDuration,
  secondsRemaining,
} from "./reservation-clock.ts";

const T0 = Date.parse("2026-09-12T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// secondsRemaining — never negative, never guesses
// ---------------------------------------------------------------------------

test("counts down to the server deadline", () => {
  assert.equal(secondsRemaining(iso(T0 + 4 * 3600_000), T0), 4 * 3600);
  assert.equal(secondsRemaining(iso(T0 + 90_000), T0), 90);
});

test("floors at zero rather than going negative", () => {
  assert.equal(secondsRemaining(iso(T0 - 1), T0), 0);
  assert.equal(secondsRemaining(iso(T0 - 5 * 3600_000), T0), 0);
});

test("an unknown deadline is null, which is not zero", () => {
  // Zero would tell the customer they had just lost something. Null means the
  // server did not say, and the UI shows that instead.
  assert.equal(secondsRemaining(null, T0), null);
  assert.equal(secondsRemaining(undefined, T0), null);
  assert.equal(secondsRemaining("", T0), null);
  assert.equal(secondsRemaining("not-a-date", T0), null);
});

test("a page reload cannot extend a reservation", () => {
  // The whole anti-regression point: the remaining time is a function of the
  // SERVER's absolute instant and the current moment, with no state carried
  // across the reload. Re-deriving an hour later necessarily shows an hour
  // less, whatever the browser did in between.
  const deadline = iso(T0 + 4 * 3600_000);
  assert.equal(secondsRemaining(deadline, T0), 4 * 3600);
  assert.equal(secondsRemaining(deadline, T0 + 3600_000), 3 * 3600);
  assert.equal(secondsRemaining(deadline, T0 + 4 * 3600_000 + 1), 0);
});

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

test("formats Persian digits, zero-padded below the hour", () => {
  assert.equal(formatDuration(9045), "۲:۳۰:۴۵");
  assert.equal(formatDuration(90), "۰۱:۳۰");
  assert.equal(formatDuration(5), "۰۰:۰۵");
  assert.equal(formatDuration(0), "۰۰:۰۰");
});

test("never renders a negative duration", () => {
  assert.equal(formatDuration(-1), "۰۰:۰۰");
  assert.equal(formatDuration(-100000), "۰۰:۰۰");
});

// ---------------------------------------------------------------------------
// announceRemaining — stable between milestones
// ---------------------------------------------------------------------------

test("the spoken summary does not change every second", () => {
  /*
   * Sampled strictly INSIDE a band, not at its edge: 2:00:00 exactly is the
   * boundary where "about 2 hours" legitimately becomes "about 1 hour", and
   * asserting stability across a boundary would be asserting that the
   * announcement never changes at all.
   */
  const start = 2 * 3600 - 1; // one second into the "about 1 hour" band
  const first = announceRemaining(start);
  for (let s = start; s > start - 60; s -= 1) {
    assert.equal(announceRemaining(s), first);
  }
  // A full half hour inside the band is still one single announcement.
  assert.equal(announceRemaining(start - 1800), first);
});

test("the spoken summary changes only at milestones", () => {
  const seen = new Set<string>();
  // Sample every second of a four-hour hold and count DISTINCT announcements.
  for (let s = 4 * 3600; s >= 0; s -= 1) seen.add(announceRemaining(s));
  // 4h / 3h / 2h / 1h, then <1h, <30m, <10m, <5m, <1m, then expired.
  assert.equal(seen.size, 10);
});

test("never announces less time than actually remains", () => {
  /*
   * THE INVARIANT THAT MATTERS. An announcement that understates the time left
   * is not merely imprecise — it would make somebody abandon a basket they
   * still had time to check out. An earlier version read four minutes out as
   * "less than 1 minute"; this asserts it across every second of a four-hour
   * hold rather than at sampled points.
   */
  for (let s = 4 * 3600; s > 0; s -= 1) {
    assert.ok(
      announcedCeilingSeconds(s) >= s,
      `at ${s}s the announcement claimed a ceiling of ${announcedCeilingSeconds(s)}s`,
    );
  }
});

test("zero says the hold ended, not that no time is left", () => {
  assert.match(announceRemaining(0), /به پایان رسید/);
});

// ---------------------------------------------------------------------------
// earliestExpiry — the first thing the customer can lose
// ---------------------------------------------------------------------------

test("follows the earliest tranche, not the line or the latest", () => {
  const later = iso(T0 + 4 * 3600_000);
  const sooner = iso(T0 + 1 * 3600_000);
  assert.equal(
    earliestExpiry({
      expiresAt: later,
      tranches: [{ expiresAt: later }, { expiresAt: sooner }],
    }),
    sooner,
  );
});

test("multiple tranches with different expiries each keep their own instant", () => {
  const a = iso(T0 + 3600_000);
  const b = iso(T0 + 2 * 3600_000);
  const c = iso(T0 + 3 * 3600_000);
  const line = { expiresAt: a, tranches: [{ expiresAt: c }, { expiresAt: b }, { expiresAt: a }] };
  assert.equal(earliestExpiry(line), a);
  // And each tranche's own remaining time is computed from its own deadline.
  assert.equal(secondsRemaining(b, T0), 2 * 3600);
  assert.equal(secondsRemaining(c, T0), 3 * 3600);
});

test("ignores malformed deadlines instead of letting NaN win", () => {
  const good = iso(T0 + 3600_000);
  assert.equal(
    earliestExpiry({ expiresAt: "nonsense", tranches: [{ expiresAt: good }] }),
    good,
  );
  assert.equal(earliestExpiry({ expiresAt: null, tranches: [{ expiresAt: "" }] }), null);
  assert.equal(earliestExpiry({ expiresAt: null, tranches: [] }), null);
});

// ---------------------------------------------------------------------------
// foldClockSample — correcting "now", never the deadline
// ---------------------------------------------------------------------------

test("measures an offset when the device clock is behind", () => {
  // Server says 10:00:30 at the instant the device thinks it is 10:00:00.
  const { state, changed } = foldClockSample(INITIAL_CLOCK_STATE, {
    serverTimeIso: iso(T0 + 30_000),
    receivedAtMs: T0,
    roundTripMs: 100,
  });
  assert.equal(changed, true);
  assert.equal(state.offsetMs, 30_050); // + half the round trip
  assert.equal(state.bestRoundTripMs, 100);
});

test("prefers the fastest exchange and discards slower samples", () => {
  const fast = foldClockSample(INITIAL_CLOCK_STATE, {
    serverTimeIso: iso(T0 + 30_000),
    receivedAtMs: T0,
    roundTripMs: 40,
  }).state;

  // A later, slower sample claiming a wildly different offset is ignored:
  // latency only ever inflates the apparent offset.
  const after = foldClockSample(fast, {
    serverTimeIso: iso(T0 + 90_000),
    receivedAtMs: T0,
    roundTripMs: 5_000,
  });
  assert.equal(after.changed, false);
  assert.equal(after.state.offsetMs, fast.offsetMs);
});

test("ignores an implausible offset outright", () => {
  const { state, changed } = foldClockSample(INITIAL_CLOCK_STATE, {
    serverTimeIso: iso(T0 + MAX_TRUSTED_SKEW_MS + 60_000),
    receivedAtMs: T0,
    roundTripMs: 10,
  });
  assert.equal(changed, false);
  assert.equal(state.offsetMs, 0);
});

test("ignores a malformed server timestamp", () => {
  const { state, changed } = foldClockSample(INITIAL_CLOCK_STATE, {
    serverTimeIso: "not-a-date",
    receivedAtMs: T0,
    roundTripMs: 10,
  });
  assert.equal(changed, false);
  assert.equal(state.offsetMs, 0);
});

test("a sub-second correction does not churn the page", () => {
  const { changed, state } = foldClockSample(INITIAL_CLOCK_STATE, {
    serverTimeIso: iso(T0 + 400),
    receivedAtMs: T0,
    roundTripMs: 20,
  });
  assert.equal(changed, false);
  assert.equal(state.offsetMs, 0);
  // ...but the better round-trip measurement is still kept.
  assert.equal(state.bestRoundTripMs, 20);
});

test("the offset moves what now means and never the deadline", () => {
  const deadline = iso(T0 + 3600_000);
  const { state } = foldClockSample(INITIAL_CLOCK_STATE, {
    serverTimeIso: iso(T0 + 600_000), // device is ten minutes slow
    receivedAtMs: T0,
    roundTripMs: 0,
  });
  const deviceView = secondsRemaining(deadline, T0);
  const correctedView = secondsRemaining(deadline, T0 + state.offsetMs);
  assert.equal(deviceView, 3600);
  assert.equal(correctedView, 3000);
  // Correction can only ever REDUCE the time shown, never grant more.
  assert.ok(correctedView! < deviceView!);
});
