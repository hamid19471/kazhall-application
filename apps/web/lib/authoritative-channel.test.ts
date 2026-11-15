/**
 * `createAuthoritativeChannel` — the coalescing and ordering rules that make a
 * pushed `availability:updated` safe to react to.
 *
 * Run by `pnpm --filter @kazhal/web test` (`node --test lib/*.test.ts`).
 *
 * The subject is imported by RELATIVE PATH with an explicit `.ts` extension:
 * `node --test` resolves real files and strips types, and there is no bundler
 * and no tsconfig `paths` in that path — the same convention
 * `reservation-clock.test.ts` already uses.
 *
 * Every case here drives time with resolvable deferreds rather than timers, so
 * there is no sleep anywhere and no ordering left to chance.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createAuthoritativeChannel,
  type AuthoritativeChannel,
} from "../../../packages/api-client/src/realtime/authoritative.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-queued microtask (and `.finally` chain) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/**
 * A channel with a rate floor and a controllable clock, matching how the
 * catalogue listing uses it.
 */
function throttledHarness(minIntervalMs: number) {
  const reads: Array<Deferred<string>> = [];
  const applied: string[] = [];
  let clock = 10_000;

  const channel = createAuthoritativeChannel<string>({
    read: () => {
      const d = deferred<string>();
      reads.push(d);
      return d.promise;
    },
    onResult: (value) => applied.push(value),
    minIntervalMs,
    now: () => clock,
  });

  return {
    channel,
    reads,
    applied,
    advance(ms: number) {
      clock += ms;
    },
  };
}

/** Wait for a real (short) timer to elapse — the floor uses `setTimeout`. */
function afterTimer(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Harness {
  channel: AuthoritativeChannel<string>;
  /** One deferred per started read, in start order. */
  reads: Array<Deferred<string>>;
  /** Abort signals handed to each read, in start order. */
  signals: AbortSignal[];
  applied: string[];
  errors: unknown[];
}

function harness(): Harness {
  const reads: Array<Deferred<string>> = [];
  const signals: AbortSignal[] = [];
  const applied: string[] = [];
  const errors: unknown[] = [];

  const channel = createAuthoritativeChannel<string>({
    read: (signal) => {
      signals.push(signal);
      const d = deferred<string>();
      reads.push(d);
      return d.promise;
    },
    onResult: (value) => applied.push(value),
    onError: (error) => errors.push(error),
  });

  return { channel, reads, signals, applied, errors };
}

// ---------------------------------------------------------------------------
// Coalescing: one in flight, at most one trailing
// ---------------------------------------------------------------------------

test("a burst of signals while idle starts exactly one read", async () => {
  const h = harness();
  h.channel.refresh();
  assert.equal(h.reads.length, 1);
});

test("a burst arriving during a read collapses into ONE trailing read", async () => {
  const h = harness();

  h.channel.refresh(); // starts read 0
  // Five more variants in the same till sale, plus a reconnect resync, plus a
  // visibility change. Seven signals.
  for (let i = 0; i < 6; i += 1) h.channel.refresh();

  assert.equal(h.reads.length, 1, "nothing else may start while one is in flight");

  h.reads[0]!.resolve("first");
  await settle();

  assert.equal(h.reads.length, 2, "exactly one trailing read, not six");
  h.reads[1]!.resolve("second");
  await settle();

  assert.deepEqual(h.applied, ["first", "second"]);
  assert.equal(h.channel.metrics.started, 2);
  assert.equal(h.channel.metrics.coalesced, 5, "6 signals during flight: 1 armed the trailing, 5 folded");
});

test("the trailing read is not skipped even when the in-flight read succeeded", async () => {
  // The in-flight read may have been ISSUED before the change committed, so a
  // successful response is not evidence that it saw the change.
  const h = harness();
  h.channel.refresh();
  h.channel.refresh();
  h.reads[0]!.resolve("stale-but-ok");
  await settle();
  assert.equal(h.reads.length, 2);
});

test("signals after everything settled start a fresh read", async () => {
  const h = harness();
  h.channel.refresh();
  h.reads[0]!.resolve("a");
  await settle();
  h.channel.refresh();
  assert.equal(h.reads.length, 2);
});

// ---------------------------------------------------------------------------
// Ordering: an older response can never overwrite a newer one
// ---------------------------------------------------------------------------

test("an out-of-order external commit cannot overwrite a newer applied result", async () => {
  const h = harness();

  // A mutation claims its ticket first...
  const mutationTicket = h.channel.claim();

  // ...then a POS event triggers a read, which starts and finishes first.
  h.channel.refresh();
  h.reads[0]!.resolve("from-event");
  await settle();
  assert.deepEqual(h.applied, ["from-event"]);

  // The slow mutation response finally lands. It is OLDER. It must be dropped.
  const won = h.channel.commit(mutationTicket, "from-stale-mutation");
  assert.equal(won, false);
  assert.deepEqual(h.applied, ["from-event"], "stale response must not repaint");
  assert.equal(h.channel.metrics.dropped, 1);
});

test("a newer external commit does win", async () => {
  const h = harness();
  h.channel.refresh();
  h.reads[0]!.resolve("old");
  await settle();

  const ticket = h.channel.claim();
  assert.equal(h.channel.commit(ticket, "new"), true);
  assert.deepEqual(h.applied, ["old", "new"]);
});

test("the same ticket cannot be committed twice", async () => {
  const h = harness();
  const ticket = h.channel.claim();
  assert.equal(h.channel.commit(ticket, "once"), true);
  assert.equal(h.channel.commit(ticket, "twice"), false);
  assert.deepEqual(h.applied, ["once"]);
});

test("a trailing read outranks the read it followed", async () => {
  // Tickets are taken at START, so the trailing read's ticket is strictly
  // higher — which is the whole reason a late first response cannot win.
  const h = harness();
  h.channel.refresh();
  h.channel.refresh();
  h.reads[0]!.resolve("first");
  await settle();
  h.reads[1]!.resolve("second");
  await settle();
  assert.deepEqual(h.applied, ["first", "second"]);
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

test("a mutation always ends in an authoritative read, even when it fails", async () => {
  const h = harness();
  const end = h.channel.beginMutation();
  assert.equal(h.reads.length, 0, "the bracket itself must not fetch");
  end();
  assert.equal(h.reads.length, 1);
});

test("ending a mutation twice does not double-fetch", async () => {
  const h = harness();
  const end = h.channel.beginMutation();
  end();
  end();
  assert.equal(h.reads.length, 1);
});

test("a POS event during a mutation still yields a read issued after the mutation", async () => {
  const h = harness();

  const end = h.channel.beginMutation(); // POST /cart/items in flight
  h.channel.refresh(); // availability:updated arrives — read 0 starts now
  assert.equal(h.reads.length, 1);

  h.reads[0]!.resolve("possibly-mid-mutation");
  await settle();

  end(); // the mutation settles
  assert.equal(h.reads.length, 2, "the post-mutation read is the one that decides");
  h.reads[1]!.resolve("final");
  await settle();
  assert.deepEqual(h.applied, ["possibly-mid-mutation", "final"]);
});

test("busy reports both in-flight reads and in-flight mutations", async () => {
  const h = harness();
  assert.equal(h.channel.busy, false);
  const end = h.channel.beginMutation();
  assert.equal(h.channel.busy, true);
  end();
  assert.equal(h.channel.busy, true, "the trailing read is in flight");
  h.reads[0]!.resolve("x");
  await settle();
  assert.equal(h.channel.busy, false);
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

test("a failed read does not advance the ordering watermark", async () => {
  const h = harness();
  h.channel.refresh();
  h.reads[0]!.reject(new Error("network"));
  await settle();
  assert.equal(h.errors.length, 1);

  // A ticket claimed BEFORE the failure must still be able to win, because the
  // failed read never carried any state.
  const ticket = h.channel.claim();
  assert.equal(h.channel.commit(ticket, "recovered"), true);
  assert.deepEqual(h.applied, ["recovered"]);
});

test("an aborted read is neither a result nor an error", async () => {
  const h = harness();
  h.channel.refresh();
  h.reads[0]!.reject({ kind: "aborted" });
  await settle();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.applied, []);
});

// ---------------------------------------------------------------------------
// Teardown / Strict Mode
// ---------------------------------------------------------------------------

test("stop aborts the in-flight read and discards its result", async () => {
  const h = harness();
  h.channel.refresh();
  h.channel.stop();
  assert.equal(h.signals[0]!.aborted, true);
  h.reads[0]!.resolve("after-teardown");
  await settle();
  assert.deepEqual(h.applied, [], "a result from before the stop must never land");
});

test("stop cancels a pending trailing read", async () => {
  const h = harness();
  h.channel.refresh();
  h.channel.refresh(); // arms the trailing read
  h.channel.stop();
  h.reads[0]!.resolve("x");
  await settle();
  assert.equal(h.reads.length, 1, "the trailing read must not start after teardown");
});

test("the channel is reusable after stop (React Strict Mode remount)", async () => {
  const h = harness();
  h.channel.refresh();
  h.channel.stop(); // Strict Mode effect cleanup
  h.channel.refresh(); // Strict Mode second mount
  assert.equal(h.reads.length, 2);
  h.reads[1]!.resolve("second-mount");
  await settle();
  assert.deepEqual(h.applied, ["second-mount"]);
});

test("a result from the previous generation cannot beat the new one", async () => {
  const h = harness();
  h.channel.refresh();
  h.channel.stop();
  h.channel.refresh();
  h.reads[1]!.resolve("new");
  await settle();
  h.reads[0]!.resolve("old-generation");
  await settle();
  assert.deepEqual(h.applied, ["new"]);
});

// ---------------------------------------------------------------------------
// Duplicate / out-of-order EVENTS
// ---------------------------------------------------------------------------

test("a duplicated event is indistinguishable from one event", async () => {
  const h = harness();
  // The same frame delivered twice (socket redelivery, or socket + poller
  // fallback both noticing the same change).
  h.channel.refresh();
  h.channel.refresh();
  h.reads[0]!.resolve("v1");
  await settle();
  h.reads[1]!.resolve("v1");
  await settle();
  assert.equal(h.reads.length, 2, "at most one trailing read, whatever the duplication");
  assert.deepEqual(h.applied, ["v1", "v1"]);
});

test("event, reconnect resync and visibility change together cause no request storm", async () => {
  const h = harness();
  h.channel.refresh(); // availability:updated
  h.channel.refresh(); // socket reconnect resync
  h.channel.refresh(); // tab became visible
  assert.equal(h.reads.length, 1);
  h.reads[0]!.resolve("a");
  await settle();
  assert.equal(h.reads.length, 2, "three signals, two requests total");
  h.reads[1]!.resolve("b");
  await settle();
  assert.equal(h.reads.length, 2);
});

// ---------------------------------------------------------------------------
// The rate floor (catalogue listings, driven by the GLOBAL broadcast)
// ---------------------------------------------------------------------------

test("the first signal is not delayed by the floor", async () => {
  const h = throttledHarness(50);
  h.channel.refresh();
  assert.equal(h.reads.length, 1, "a floor must never cost latency on an idle channel");
});

test("signals inside the window are deferred to its edge, not dropped", async () => {
  const h = throttledHarness(50);
  h.channel.refresh();
  h.reads[0]!.resolve("first");
  await settle();

  // Ten more global-broadcast frames land 10 ms later, well inside the window.
  h.advance(10);
  for (let i = 0; i < 10; i += 1) h.channel.refresh();
  assert.equal(h.reads.length, 1, "still inside the floor window");

  await afterTimer(70);
  assert.equal(h.reads.length, 2, "exactly one read at the edge, not ten");
  h.reads[1]!.resolve("second");
  await settle();
  assert.deepEqual(h.applied, ["first", "second"]);
});

test("a signal after the window has passed starts immediately", async () => {
  const h = throttledHarness(50);
  h.channel.refresh();
  h.reads[0]!.resolve("a");
  await settle();

  h.advance(80); // past the floor
  h.channel.refresh();
  assert.equal(h.reads.length, 2);
});

test("stop cancels a read deferred by the floor", async () => {
  const h = throttledHarness(50);
  h.channel.refresh();
  h.reads[0]!.resolve("a");
  await settle();

  h.advance(5);
  h.channel.refresh(); // deferred
  h.channel.stop();

  await afterTimer(70);
  assert.equal(h.reads.length, 1, "a deferred read must not fire after teardown");
});

test("a floored channel still leaves no timer holding the process open", async () => {
  // The deferred timer is unref'd, so `node --test` exiting cleanly at the end
  // of this file is itself the assertion. Arm one and do not wait for it.
  const h = throttledHarness(30_000);
  h.channel.refresh();
  h.reads[0]!.resolve("a");
  await settle();
  h.advance(1);
  h.channel.refresh();
  h.channel.stop();
  assert.equal(h.reads.length, 1);
});
