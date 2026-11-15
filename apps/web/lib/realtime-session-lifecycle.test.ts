/**
 * The realtime client's SESSION lifecycle, and the socket COUNT through every
 * transition.
 *
 * Run by `pnpm --filter @kazhal/web test` (`node --test lib/*.test.ts`).
 *
 * ## The two bugs these tests pin
 *
 * **1. `stopOnSignOut` was a one-way door.** The storefront probes the session
 * on every load with `GET /auth/storefront/me`; for a guest that 401s, the 401
 * goes through the refresh coordinator, the refresh has no cookie to rotate and
 * fails, and `signOut("refresh-failed")` fires. So merely LOOKING at the shop
 * as a guest stopped the realtime client — and `markSignedIn()` only cleared a
 * boolean, telling nobody. Because the storefront signs in with
 * `router.replace` the provider is never remounted, so nothing called `start()`
 * again: a customer ended up with a live session, an open basket and no socket
 * at all until a hard reload.
 *
 * **2. Stopping was the wrong reaction for the storefront in the first place.**
 * The catalogue is public. With the gateway's anonymous mode, a
 * credential-less handshake is ACCEPTED as a public socket, so a signed-out
 * shopper should keep seeing variants sell out. The reaction to a storefront
 * sign-out is therefore a DOWNGRADE, not a stop — and a guest's session probe,
 * which is not a transition at all, must do nothing.
 *
 * A till is the opposite: every frame it receives is staff data, there is no
 * anonymous mode for it, so `pos` still stops outright. Both rules are asserted
 * here, side by side, because the difference between them is the feature.
 *
 * The transport is a fake because the property under test is the DECISION —
 * when the client is running and how many sockets that implies — not whether
 * socket.io connects. The real socket is exercised end to end by
 * `apps/api/test/integration/realtime-anonymous.int-spec.ts` and
 * `realtime-pos-cart-sync.int-spec.ts`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { AuthCoordinator } from "../../../packages/api-client/src/auth-coordinator.ts";
import { createRealtimeClient } from "../../../packages/api-client/src/realtime/client.ts";
import type {
  RealtimeTransport,
  RealtimeTransportContext,
} from "../../../packages/api-client/src/realtime/client.ts";
import type { ApiClient } from "../../../packages/api-client/src/http.ts";

/** Counts lifecycle calls so "one socket" can be asserted as a number. */
function fakeTransport() {
  const log: string[] = [];
  let ctx: RealtimeTransportContext | undefined;
  const transport: RealtimeTransport = {
    name: "fake",
    start(next) {
      ctx = next;
      log.push("start");
    },
    stop() {
      log.push("stop");
    },
  };
  return {
    transport,
    log,
    /** Pretend the socket came up, so `status` reaches "open". */
    open(): void {
      ctx?.setStatus("open");
    },
    starts: () => log.filter((entry) => entry === "start").length,
    stops: () => log.filter((entry) => entry === "stop").length,
  };
}

/**
 * The realtime client touches exactly two things on the API client: the auth
 * coordinator it subscribes to, and `audience`, which it only ever hands to a
 * transport. A real `createKazhalApi` would open a `fetch` pipeline this test
 * has no use for.
 */
function fakeApiClient(
  auth: AuthCoordinator,
  audience: "storefront" | "pos" | "admin" = "storefront",
): ApiClient {
  return { auth, audience } as unknown as ApiClient;
}

/** A coordinator whose refresh always fails — i.e. an anonymous visitor. */
function anonymousCoordinator(): AuthCoordinator {
  return new AuthCoordinator({ refresh: () => Promise.resolve(false) });
}

// ---------------------------------------------------------------------------
// The regression itself
// ---------------------------------------------------------------------------

test("a guest session probe leaves the ANONYMOUS storefront socket alone", async () => {
  const auth = anonymousCoordinator();
  const fake = fakeTransport();
  const realtime = createRealtimeClient({
    client: fakeApiClient(auth),
    transport: fake.transport,
  });

  /*
   * THE BEHAVIOUR CHANGED WITH ANONYMOUS MODE, and this is the case that
   * changed most.
   *
   * Previously the guest probe's `signOut` STOPPED the client, which is what
   * left a guest with no realtime at all. The socket a guest already has is
   * credential-less and therefore the correct one: the gateway accepts it as
   * anonymous and it receives public availability invalidations. So the probe
   * must change nothing — no teardown, no rebuild, no churn per page view.
   */
  realtime.start();
  assert.equal(realtime.status, "connecting");

  assert.equal(await auth.ensureFresh(auth.generation), false);

  assert.deepEqual(fake.log, ["start"], "the anonymous socket must survive");
  assert.notEqual(realtime.status, "closed");
});

test("signing in UPGRADES the anonymous socket to an authenticated one", () => {
  const auth = anonymousCoordinator();
  const fake = fakeTransport();
  const realtime = createRealtimeClient({
    client: fakeApiClient(auth, "storefront"),
    transport: fake.transport,
  });

  realtime.start();
  auth.signOut("refresh-failed"); // the guest probe — a no-op now
  auth.markSignedIn();

  // Exactly one replacement: the new handshake carries the session cookie and
  // joins the user room on top of the public one.
  assert.deepEqual(fake.log, ["start", "stop", "start"]);
  assert.equal(realtime.status, "connecting");
});

test("logging out DOWNGRADES to anonymous rather than stopping", () => {
  const auth = anonymousCoordinator();
  const fake = fakeTransport();
  const realtime = createRealtimeClient({
    client: fakeApiClient(auth, "storefront"),
    transport: fake.transport,
  });

  realtime.start();
  auth.markSignedIn();
  fake.open();
  auth.signOut("logout");

  // One more stop/start pair: the credential-less handshake the gateway accepts
  // as anonymous. The catalogue keeps working; only the private channel goes.
  assert.deepEqual(fake.log, ["start", "stop", "start", "stop", "start"]);
  assert.notEqual(realtime.status, "closed");
});

test("a POS client STOPS on sign-out — there is no anonymous till", () => {
  const auth = anonymousCoordinator();
  const fake = fakeTransport();
  const realtime = createRealtimeClient({
    client: fakeApiClient(auth, "pos"),
    transport: fake.transport,
  });

  realtime.start();
  auth.signOut("refresh-failed");

  assert.deepEqual(fake.log, ["start", "stop"]);
  assert.equal(realtime.status, "closed");
});

test("one login produces exactly one transport start", () => {
  const auth = anonymousCoordinator();
  const fake = fakeTransport();
  const realtime = createRealtimeClient({
    client: fakeApiClient(auth),
    transport: fake.transport,
  });

  realtime.start();
  auth.signOut("refresh-failed");
  auth.markSignedIn();

  assert.deepEqual(fake.log, ["start", "stop", "start"]);
});

test("a second login while running replaces the socket rather than adding one", () => {
  const auth = anonymousCoordinator();
  const fake = fakeTransport();
  const realtime = createRealtimeClient({
    client: fakeApiClient(auth),
    transport: fake.transport,
  });

  realtime.start();
  fake.open();
  assert.equal(realtime.status, "open");

  // A login while a socket is already open: the cookie authenticating that
  // socket has just been replaced, so it must be re-handshaked.
  auth.markSignedIn();

  assert.deepEqual(fake.log, ["start", "stop", "start"]);
  assert.equal(realtime.status, "connecting");
});

test("repeated logins do not stack listeners (one login, one restart)", () => {
  const auth = anonymousCoordinator();
  const fake = fakeTransport();
  const realtime = createRealtimeClient({
    client: fakeApiClient(auth),
    transport: fake.transport,
  });

  realtime.start();
  auth.signOut("refresh-failed");
  auth.markSignedIn();
  auth.markSignedIn();
  auth.markSignedIn();

  // 1 initial + 3 restarts. If `start()` re-subscribed every time, the third
  // login would fan out geometrically instead.
  assert.equal(fake.starts(), 4);
  assert.equal(fake.stops(), 3);
});

// ---------------------------------------------------------------------------
// ...without resurrecting an unmounted provider
// ---------------------------------------------------------------------------

test("a login after unmount does NOT open a socket", () => {
  const auth = anonymousCoordinator();
  const fake = fakeTransport();
  const realtime = createRealtimeClient({
    client: fakeApiClient(auth),
    transport: fake.transport,
  });

  realtime.start();
  realtime.stop("unmount");
  auth.markSignedIn();

  assert.deepEqual(fake.log, ["start", "stop"], "nothing may start after unmount");
  assert.equal(realtime.status, "closed");
});

test("a login after unmount does NOT open a socket even if the client was already signed out", () => {
  const auth = anonymousCoordinator();
  const fake = fakeTransport();
  const realtime = createRealtimeClient({
    client: fakeApiClient(auth),
    transport: fake.transport,
  });

  realtime.start();
  auth.signOut("refresh-failed"); // stops it
  realtime.stop("unmount"); // running is already false — must still release
  auth.markSignedIn();

  assert.deepEqual(fake.log, ["start", "stop"]);
});

test("React Strict Mode's mount, unmount, mount keeps the sign-in revival working", () => {
  const auth = anonymousCoordinator();
  const fake = fakeTransport();
  const realtime = createRealtimeClient({
    client: fakeApiClient(auth),
    transport: fake.transport,
  });

  // Strict Mode drives the SAME memoized client through a throwaway cycle.
  realtime.start();
  realtime.stop("unmount");
  realtime.start();

  auth.signOut("refresh-failed");
  auth.markSignedIn();

  assert.equal(fake.starts(), 3, "the surviving mount must still revive on sign-in");
  assert.equal(realtime.status, "connecting");
});

// ---------------------------------------------------------------------------
// What must NOT count as a transition
// ---------------------------------------------------------------------------

test("an ordinary successful refresh is not a sign-in and does not churn the socket", async () => {
  const auth = new AuthCoordinator({ refresh: () => Promise.resolve(true) });
  const fake = fakeTransport();
  const realtime = createRealtimeClient({
    client: fakeApiClient(auth),
    transport: fake.transport,
  });

  realtime.start();
  fake.open();

  // A 401 on a live session, refreshed successfully: the session was never
  // lost, so tearing the socket down would be pure churn every 15 minutes.
  assert.equal(await auth.ensureFresh(auth.generation), true);

  assert.deepEqual(fake.log, ["start"]);
  assert.equal(realtime.status, "open");
});

test("a refresh that REVIVES a signed-out session does restart the client", async () => {
  let succeed = false;
  const auth = new AuthCoordinator({ refresh: () => Promise.resolve(succeed) });
  const fake = fakeTransport();
  const realtime = createRealtimeClient({
    // `pos`: the sign-out stops outright there, so "did the revival restart
    // it?" is observable without the storefront's downgrade in the way.
    client: fakeApiClient(auth, "pos"),
    transport: fake.transport,
  });

  realtime.start();
  assert.equal(await auth.ensureFresh(auth.generation), false);
  assert.equal(realtime.status, "closed");

  // The cookie came back (another tab refreshed, say) and a forced refresh
  // now succeeds. That IS a transition.
  succeed = true;
  assert.equal(await auth.runRefresh(), true);

  assert.equal(fake.starts(), 2);
  assert.equal(realtime.status, "connecting");
});

test("opting out with restartOnSignIn:false leaves the old one-way behaviour", () => {
  const auth = anonymousCoordinator();
  const fake = fakeTransport();
  const realtime = createRealtimeClient({
    // `pos`, so the sign-out still stops rather than downgrading — the opt-out
    // under test is the SIGN-IN half.
    client: fakeApiClient(auth, "pos"),
    transport: fake.transport,
    restartOnSignIn: false,
  });

  realtime.start();
  auth.signOut("refresh-failed");
  auth.markSignedIn();

  assert.deepEqual(fake.log, ["start", "stop"]);
  assert.equal(realtime.status, "closed");
});

test("signed-out transitions still fire exactly once", () => {
  const auth = anonymousCoordinator();
  const fake = fakeTransport();
  const realtime = createRealtimeClient({
    client: fakeApiClient(auth, "pos"),
    transport: fake.transport,
  });

  realtime.start();
  auth.signOut("refresh-failed");
  auth.signOut("logout");
  auth.signOut("session-invalidated");

  assert.equal(fake.stops(), 1, "signOut is latched until a sign-in clears it");
});

test("the sign-out subscription is re-armed by the restart", () => {
  const auth = anonymousCoordinator();
  const fake = fakeTransport();
  const realtime = createRealtimeClient({
    client: fakeApiClient(auth, "pos"),
    transport: fake.transport,
  });

  realtime.start();
  auth.signOut("refresh-failed");
  auth.markSignedIn();

  // Signing out a SECOND time must still stop the revived client — otherwise
  // a customer keeps a socket after logging out.
  auth.signOut("logout");

  assert.equal(realtime.status, "closed");
  assert.deepEqual(fake.log, ["start", "stop", "start", "stop"]);
});

// ---------------------------------------------------------------------------
// Connection counting — exactly one live socket through every transition
// ---------------------------------------------------------------------------

test("every storefront transition leaves exactly ONE live socket", () => {
  const auth = anonymousCoordinator();
  const fake = fakeTransport();
  const realtime = createRealtimeClient({
    client: fakeApiClient(auth, "storefront"),
    transport: fake.transport,
  });

  /*
   * The invariant: guest -> signed in -> signed out -> signed in again must
   * never accumulate sockets. `starts - stops` is the live count, and it must
   * be 1 after every single step.
   */
  const live = () => fake.starts() - fake.stops();

  realtime.start();
  assert.equal(live(), 1, "guest");

  auth.signOut("refresh-failed"); // guest probe: no-op
  assert.equal(live(), 1, "after the guest session probe");

  auth.markSignedIn();
  assert.equal(live(), 1, "after signing in");

  auth.signOut("logout");
  assert.equal(live(), 1, "after logging out (downgraded to anonymous)");

  auth.markSignedIn();
  assert.equal(live(), 1, "after signing in again");

  realtime.stop("unmount");
  assert.equal(live(), 0, "after unmount");
});

test("a POS client never holds a socket while signed out", () => {
  const auth = anonymousCoordinator();
  const fake = fakeTransport();
  const realtime = createRealtimeClient({
    client: fakeApiClient(auth, "pos"),
    transport: fake.transport,
  });
  const live = () => fake.starts() - fake.stops();

  realtime.start();
  assert.equal(live(), 1);

  auth.signOut("refresh-failed");
  assert.equal(live(), 0, "no anonymous till socket");

  auth.markSignedIn();
  assert.equal(live(), 1, "and exactly one again after signing in");

  realtime.stop("unmount");
  assert.equal(live(), 0);
});
