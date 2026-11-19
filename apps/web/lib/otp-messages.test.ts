/**
 * Persian OTP messages. Inputs are the API's real error envelopes as parsed by
 * `@kazhal/api-client` (`code` = body.error, `retryAfterSeconds` = details,
 * `kind` from the status), pinned in
 * `apps/api/test/integration/otp-hardening.int-spec.ts`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  formatWait,
  OTP_INSTRUCTIONS,
  OTP_INVALID_MESSAGE,
  OTP_SENT_MESSAGE,
  otpSendErrorMessage,
  otpVerifyErrorMessage,
} from './otp-messages.ts';
import type { OtpMessage } from './otp-messages.ts';

const PERSIAN = /[؀-ۿ]/;
const LATIN_WORD = /[A-Za-z]{3,}/;

/** Customer-facing: Persian, and never the API's English or its codes. */
function assertCustomerFacing(
  message: OtpMessage | undefined,
): asserts message is OtpMessage {
  assert.ok(message, 'expected a message');
  for (const text of [message.title, message.body]) {
    assert.match(text, PERSIAN);
    // `۰۹xxxxxxxxx` is the one deliberate Latin run (a format hint).
    assert.doesNotMatch(text.replace('۰۹xxxxxxxxx', ''), LATIN_WORD, text);
  }
}

const sendErr = (
  status: number,
  code?: string,
  retryAfterSeconds?: number,
) => ({
  status,
  kind:
    status === 429
      ? 'rate_limited'
      : status >= 500
        ? 'server'
        : status === 400
          ? 'validation'
          : 'http',
  code,
  retryAfterSeconds,
  messages: ['English developer text that must not surface'],
});

// --------------------------------------------------------------- send-otp

test('OTP_DELIVERY_FAILED, retryAfterSeconds=0: says nothing was sent and resend is open now', () => {
  const message = otpSendErrorMessage(sendErr(503, 'OTP_DELIVERY_FAILED', 0));
  assertCustomerFacing(message);
  assert.equal(message.tone, 'danger');
  assert.match(message.body, /پیامکی برای شما ارسال نشد/);
  assert.doesNotMatch(message.body, /ثانیه|دقیقه/);
});

test('OTP_DELIVERY_FAILED with a server wait: names that wait', () => {
  const message = otpSendErrorMessage(sendErr(503, 'OTP_DELIVERY_FAILED', 42));
  assertCustomerFacing(message);
  assert.match(message.body, /پیامکی برای شما ارسال نشد/);
  assert.match(message.body, /۴۲ ثانیه/);
});

test('OTP_DELIVERY_UNCERTAIN: never claims sent or not-sent; says it may arrive; keeps the cooldown', () => {
  const message = otpSendErrorMessage(
    sendErr(503, 'OTP_DELIVERY_UNCERTAIN', 60),
  );
  assertCustomerFacing(message);
  assert.equal(message.tone, 'warning');
  assert.match(message.body, /ممکن است کد ورود با کمی تأخیر برسد/);
  assert.match(message.body, /۱ دقیقه/);
  assert.doesNotMatch(message.body, /ارسال شد|ارسال نشد/);
});

test('OTP_COOLDOWN: invites entering the existing code, with the server wait', () => {
  const message = otpSendErrorMessage(sendErr(429, 'OTP_COOLDOWN', 37));
  assertCustomerFacing(message);
  assert.equal(message.tone, 'info');
  assert.match(message.body, /۳۷ ثانیه/);
});

test('OTP_SEND_RATE_LIMITED: rounds long waits up to minutes', () => {
  const message = otpSendErrorMessage(
    sendErr(429, 'OTP_SEND_RATE_LIMITED', 1190),
  );
  assertCustomerFacing(message);
  assert.match(message.title, /بیش از حد مجاز/);
  assert.match(message.body, /۲۰ دقیقه/);
});

test('no server figure → no number is invented', () => {
  for (const code of [
    'OTP_DELIVERY_FAILED',
    'OTP_DELIVERY_UNCERTAIN',
    'OTP_COOLDOWN',
    'OTP_SEND_RATE_LIMITED',
  ]) {
    const message = otpSendErrorMessage(
      sendErr(
        code === 'OTP_COOLDOWN' || code === 'OTP_SEND_RATE_LIMITED' ? 429 : 503,
        code,
      ),
    );
    assertCustomerFacing(message);
    assert.doesNotMatch(message.body, /[۰-۹]/, code);
  }
});

test('network and timeout failures (status 0) get the connection message', () => {
  for (const error of [
    { status: 0, kind: 'network' },
    { status: 0, kind: 'timeout' },
    new TypeError('Failed to fetch'),
  ]) {
    const message = otpSendErrorMessage(error);
    assertCustomerFacing(message);
    // A bare TypeError has no status/kind: generic, still Persian.
    if (!(error instanceof TypeError))
      assert.match(message.title, /ارتباط برقرار نشد/);
  }
});

test("a 400 on send is about the mobile number; other 5xx are 'temporarily unavailable'", () => {
  assert.match(
    otpSendErrorMessage(sendErr(400, 'Bad Request'))?.title ?? '',
    /شمارهٔ موبایل/,
  );
  assertCustomerFacing(otpSendErrorMessage(sendErr(400, 'Bad Request')));
  assert.match(
    otpSendErrorMessage(sendErr(500))?.title ?? '',
    /موقتاً در دسترس نیست/,
  );
  assert.match(
    otpSendErrorMessage(sendErr(503))?.title ?? '',
    /موقتاً در دسترس نیست/,
  );
});

test('no error → no message', () => {
  assert.equal(otpSendErrorMessage(undefined), undefined);
  assert.equal(otpVerifyErrorMessage(undefined), undefined);
});

// ------------------------------------------------------------- verify-otp

test('OTP_INVALID covers wrong AND expired codes with one message that does not say which', () => {
  const message = otpVerifyErrorMessage({
    status: 401,
    kind: 'unauthorized',
    code: 'OTP_INVALID',
  });
  assert.equal(message, OTP_INVALID_MESSAGE);
  assertCustomerFacing(message);
  assert.match(message.body, /درست نیست یا مهلت استفاده از آن تمام شده است/);
  assert.match(message.body, /کد تازه درخواست کنید/);
});

test('a 401 that is not OTP_INVALID (e.g. deactivated account) is not called a wrong code', () => {
  const message = otpVerifyErrorMessage({
    status: 401,
    kind: 'unauthorized',
    code: 'Unauthorized',
  });
  assertCustomerFacing(message);
  assert.notEqual(message, OTP_INVALID_MESSAGE);
  assert.match(message.body, /پشتیبانی/);
});

test('verify: network failure, validation and server errors', () => {
  assert.match(
    otpVerifyErrorMessage({ status: 0, kind: 'network' })?.title ?? '',
    /ارتباط برقرار نشد/,
  );
  assert.match(
    otpVerifyErrorMessage({ status: 400, kind: 'validation' })?.title ?? '',
    /کامل نیست/,
  );
  assert.match(
    otpVerifyErrorMessage({ status: 500, kind: 'server' })?.title ?? '',
    /موقتاً/,
  );
  for (const error of [
    { status: 0, kind: 'network' },
    { status: 400, kind: 'validation' },
    { status: 500, kind: 'server' },
  ]) {
    assertCustomerFacing(otpVerifyErrorMessage(error));
  }
});

// ------------------------------------------------------- standing text

test("the outdated 'SMS is not set up' warning is gone and nothing standing claims a send", () => {
  for (const line of OTP_INSTRUCTIONS) {
    assert.match(line, PERSIAN);
    assert.doesNotMatch(line, /راه‌اندازی نشده|ارسال شد|پشتیبانی/);
  }
  assert.ok(OTP_INSTRUCTIONS.some((line) => /۶ رقمی/.test(line)));
});

test("'sent' is said only by the success message", () => {
  assertCustomerFacing(OTP_SENT_MESSAGE);
  assert.match(OTP_SENT_MESSAGE.body, /ارسال شد/);
});

test('formatWait', () => {
  assert.equal(formatWait(1), '۱ ثانیه');
  assert.equal(formatWait(59.2), '۱ دقیقه');
  assert.equal(formatWait(45), '۴۵ ثانیه');
  assert.equal(formatWait(90), '۲ دقیقه');
  assert.equal(formatWait(3600), '۶۰ دقیقه');
  assert.equal(formatWait(0), '۱ ثانیه');
});

// ------------------------------------------------ the sign-in view itself

test('sign-in view: outdated warning removed, OTP outcomes rendered only via otp-messages', () => {
  const source = readFileSync(
    new URL('../components/auth/sign-in-view.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /ارسال پیامک روی این فروشگاه هنوز راه‌اندازی نشده است/,
  );
  assert.doesNotMatch(source, /درخواست کد ورود برای این شماره ثبت شد/);
  // OTP errors are no longer shown through FormError (which prints the API's
  // English `message`); FormError remains only in the review-password door.
  assert.doesNotMatch(source, /<FormError error=\{(sendError|verifyError)\}/);
  assert.match(source, /otpSendErrorMessage\(sendError\)/);
  assert.match(source, /otpVerifyErrorMessage\(verifyError\)/);
  assert.match(source, /OTP_SENT_MESSAGE/);
});
