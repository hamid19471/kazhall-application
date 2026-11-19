/**
 * `sendOtpFailureAction` — the sign-in screen's reaction to a failed send.
 *
 * Shapes are the API's real error envelopes as parsed by `@kazhal/api-client`
 * (`code` from `body.error`, `retryAfterSeconds` from `details`), pinned in
 * `apps/api/test/integration/otp-hardening.int-spec.ts`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { sendOtpFailureAction } from "./otp-send-errors.ts";

test("OTP_DELIVERY_FAILED with retryAfterSeconds=0: no countdown, stays on the mobile step", () => {
  assert.deepEqual(
    sendOtpFailureAction({ status: 503, code: "OTP_DELIVERY_FAILED", retryAfterSeconds: 0 }),
    { cooldownSeconds: 0, showCodeStep: false },
  );
});

test("OTP_DELIVERY_FAILED with a non-zero figure (challenge not released): honours the server's wait", () => {
  assert.deepEqual(
    sendOtpFailureAction({ status: 503, code: "OTP_DELIVERY_FAILED", retryAfterSeconds: 42 }),
    { cooldownSeconds: 42, showCodeStep: false },
  );
});

test("OTP_DELIVERY_UNCERTAIN: server cooldown preserved, moves to the code step", () => {
  assert.deepEqual(
    sendOtpFailureAction({ status: 503, code: "OTP_DELIVERY_UNCERTAIN", retryAfterSeconds: 60 }),
    { cooldownSeconds: 60, showCodeStep: true },
  );
});

test("OTP_COOLDOWN: server figure, moves to the code step (unchanged behaviour)", () => {
  assert.deepEqual(
    sendOtpFailureAction({ status: 429, code: "OTP_COOLDOWN", retryAfterSeconds: 37 }),
    { cooldownSeconds: 37, showCodeStep: true },
  );
});

test("OTP_SEND_RATE_LIMITED: server figure, stays put (unchanged behaviour)", () => {
  assert.deepEqual(
    sendOtpFailureAction({ status: 429, code: "OTP_SEND_RATE_LIMITED", retryAfterSeconds: 1200 }),
    { cooldownSeconds: 1200, showCodeStep: false },
  );
});

test("never invents a wait: a missing or invalid figure leaves the countdown alone", () => {
  for (const retryAfterSeconds of [undefined, Number.NaN, -5]) {
    assert.equal(
      sendOtpFailureAction({ status: 503, code: "OTP_DELIVERY_UNCERTAIN", retryAfterSeconds })
        .cooldownSeconds,
      undefined,
    );
    assert.equal(
      sendOtpFailureAction({ status: 429, code: "OTP_COOLDOWN", retryAfterSeconds }).cooldownSeconds,
      undefined,
    );
  }
});

test("any other failure (a bare 503, a 500, a network error) changes neither countdown nor step", () => {
  for (const error of [
    { status: 503 },
    { status: 503, code: "SOMETHING_ELSE", retryAfterSeconds: 10 },
    { status: 500, retryAfterSeconds: 10 },
    { status: 0 },
    { status: 400, code: "Bad Request" },
  ]) {
    assert.deepEqual(sendOtpFailureAction(error), { cooldownSeconds: undefined, showCodeStep: false });
  }
});
