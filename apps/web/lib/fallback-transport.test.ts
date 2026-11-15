/**
 * `createFallbackTransport` — Socket.IO primary, polling only while it is down.
 *
 * Run by `pnpm --filter @kazhal/web test` (`node --test lib/*.test.ts`).
 *
 * Both transports here are fakes driven by hand, because the property under
 * test is the DECISION — when the poller runs, and in what order relative to
 * the socket's resync — not whether socket.io works. The real socket is
 * exercised end to end by
 * `apps/api/test/integration/realtime-pos-cart-sync.int-spec.ts`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createFallbackTransport } from "../../../packages/api-client/src/realtime/fallback.ts";
import type {
  RealtimeTransport,
  RealtimeTransportContext,
} from "../../../packages/api-client/src/realtime/client.ts";
import type {
  RealtimeStatus,
  ResyncReason,
} from "../../../packages/api-client/src/realtime/types.ts";

function after(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A transport that does nothing until the test tells it to. */
function fakeTransport(name: string) {
  let ctx: RealtimeTransportContext | undefined;
  const log: string[] = [];
  return {
    transport: {
      name,
      start(next: RealtimeTransportContext) {
        ctx = next;
        log.push("start");
      },
      stop() {
        ctx = undefined;
        log.push("stop");
      },
    } as RealtimeTransport,
    log,
    get running() {
      return ctx !== undefined;
    },
    setStatus(status: RealtimeStatus) {
      ctx?.setStatus(status);
    },
    resync(reason: ResyncReason) {
      ctx?.resync(reason);
    },
    emitAvailability(variantId: number) {
      ctx?.emit("availability:invalidated", {
        variantId,
        productId: 1,
        reason: "stock",
      });
    },
  };
}

function harness(graceMs: number) {
  const primary = fakeTransport("socket.io");
  const fallback = fakeTransport("polling");
  const statuses: RealtimeStatus[] = [];
  const resyncs: ResyncReason[] = [];
  const events: number[] = [];
  /** Interleaved trace of what the OUTER client saw, in order. */
  const trace: string[] = [];

  const composite = createFallbackTransport({
    primary: primary.transport,
    fallback: fallback.transport,
    graceMs,
  });

  const ctx: RealtimeTransportContext = {
    client: { audience: "storefront" } as RealtimeTransportContext["client"],
    emit: (_event, payload) => {
      events.push((payload as { variantId: number }).variantId);
      trace.push("emit");
    },
    setStatus: (status) => {
      statuses.push(status);
      trace.push(`status:${status}`);
    },
    resync: (reason) => {
      resyncs.push(reason);
      trace.push(`resync:${reason}`);
    },
    interests: () => ({
      cart: false,
      productIds: [],
      variantIds: [],
      customerOrderIds: [],
      staffOrderIds: [],
    }),
    onInterestChange: () => () => undefined,
  };

  return { composite, ctx, primary, fallback, statuses, resyncs, events, trace };
}

// ---------------------------------------------------------------------------

test("the composite names both transports so a status badge can say which is live", () => {
  const h = harness(10);
  assert.equal(h.composite.name, "socket.io+polling");
});

test("only the socket runs while it is connected", async () => {
  const h = harness(10);
  h.composite.start(h.ctx);
  assert.equal(h.primary.running, true);
  assert.equal(h.fallback.running, false, "a healthy socket must cost zero requests");

  h.primary.setStatus("open");
  await after(40);
  assert.equal(h.fallback.running, false, "still no poller once connected");
  h.composite.stop();
});

test("a blink shorter than the grace period does not start the poller", async () => {
  const h = harness(80);
  h.composite.start(h.ctx);
  h.primary.setStatus("open");

  h.primary.setStatus("reconnecting");
  await after(20);
  assert.equal(h.fallback.running, false, "too early — the socket may recover");

  h.primary.setStatus("open");
  await after(100);
  assert.equal(h.fallback.running, false, "it recovered; the poller was never needed");
  assert.deepEqual(h.fallback.log, []);
  h.composite.stop();
});

test("a real outage starts the poller once the grace period elapses", async () => {
  const h = harness(20);
  h.composite.start(h.ctx);
  h.primary.setStatus("open");

  h.primary.setStatus("reconnecting");
  await after(70);
  assert.equal(h.fallback.running, true);
  assert.deepEqual(h.fallback.log, ["start"], "started exactly once");
  h.composite.stop();
});

test("connect_error is an outage too", async () => {
  const h = harness(20);
  h.composite.start(h.ctx);
  h.primary.setStatus("error");
  await after(70);
  assert.equal(h.fallback.running, true);
  h.composite.stop();
});

test("repeated down edges do not start a second poller", async () => {
  const h = harness(20);
  h.composite.start(h.ctx);
  h.primary.setStatus("reconnecting");
  h.primary.setStatus("error");
  h.primary.setStatus("reconnecting");
  await after(70);
  assert.deepEqual(h.fallback.log, ["start"]);
  h.composite.stop();
});

test("the poller is stopped BEFORE the reconnect resync reaches the UI", async () => {
  // This ordering is the whole "immediate refetch, then stop unnecessary
  // polling" rule. Reversed, the UI would refetch AND the poller would still
  // have a cycle in flight.
  const h = harness(20);
  h.composite.start(h.ctx);
  h.primary.setStatus("open");
  h.primary.setStatus("reconnecting");
  await after(70);
  assert.equal(h.fallback.running, true);

  // socket.io fires these synchronously, in this order, from `connect`.
  h.primary.setStatus("open");
  h.primary.resync("reconnected");

  assert.equal(h.fallback.running, false);
  assert.deepEqual(h.resyncs, ["reconnected"], "exactly one authoritative refetch");
  assert.ok(h.fallback.log.includes("stop"), "the poller was stopped");
  assert.ok(
    h.trace.lastIndexOf("status:open") < h.trace.indexOf("resync:reconnected"),
    "status:open (which stops the poller) must precede the resync",
  );
  h.composite.stop();
});

test("the poller's FIRST-cycle resync is swallowed; a recovery resync is forwarded", async () => {
  const h = harness(0);
  h.composite.start(h.ctx);
  h.primary.setStatus("reconnecting");
  await after(30);
  assert.equal(h.fallback.running, true);

  // The poller treats its first clean cycle as "connected". As a fallback it
  // is not a connection — the UI already has state and the cycle itself just
  // refreshed it.
  h.fallback.resync("connected");
  assert.deepEqual(h.resyncs, [], "no redundant full refetch on top of the poll");

  // A later gap really is a gap.
  h.fallback.resync("poll-recovered");
  assert.deepEqual(h.resyncs, ["poll-recovered"]);
  h.composite.stop();
});

test("the composite owns status: the poller cannot report open while the socket is down", async () => {
  const h = harness(0);
  h.composite.start(h.ctx);
  h.primary.setStatus("reconnecting");
  await after(30);

  h.fallback.setStatus("open");
  assert.equal(
    h.statuses.includes("open"),
    false,
    "a running poller is not a connected socket",
  );
  h.composite.stop();
});

test("frames from whichever transport is live reach the client", async () => {
  const h = harness(0);
  h.composite.start(h.ctx);
  h.primary.setStatus("open");
  h.primary.emitAvailability(11);

  h.primary.setStatus("reconnecting");
  await after(30);
  h.fallback.emitAvailability(22);

  assert.deepEqual(h.events, [11, 22]);
  h.composite.stop();
});

test("stop tears down both transports and cancels a pending grace timer", async () => {
  const h = harness(60);
  h.composite.start(h.ctx);
  h.primary.setStatus("reconnecting"); // arms the grace timer
  h.composite.stop();

  await after(140);
  assert.deepEqual(h.primary.log, ["start", "stop"]);
  assert.deepEqual(h.fallback.log, [], "the poller must not start after teardown");
});

test("stop also stops a poller that was already running", async () => {
  const h = harness(0);
  h.composite.start(h.ctx);
  h.primary.setStatus("reconnecting");
  await after(30);
  assert.equal(h.fallback.running, true);

  h.composite.stop();
  assert.deepEqual(h.fallback.log, ["start", "stop"]);
  assert.deepEqual(h.primary.log, ["start", "stop"]);
});

test("a restart after stop is clean (React Strict Mode remount)", async () => {
  const h = harness(20);
  h.composite.start(h.ctx);
  h.composite.stop();
  h.composite.start(h.ctx);

  assert.deepEqual(h.primary.log, ["start", "stop", "start"]);
  assert.equal(h.primary.running, true, "exactly one live primary, not two");

  h.primary.setStatus("reconnecting");
  await after(70);
  assert.equal(h.fallback.running, true, "the grace timer works again after a restart");
  h.composite.stop();
});

test("the grace timer does not hold the process open", () => {
  // Unref'd: `node --test` exiting at the end of this file is the assertion.
  const h = harness(3_600_000);
  h.composite.start(h.ctx);
  h.primary.setStatus("reconnecting");
  assert.equal(h.fallback.running, false);
  h.composite.stop();
});
