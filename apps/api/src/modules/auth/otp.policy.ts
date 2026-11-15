/**
 * ===========================================================================
 * OTP POLICY — the single place every OTP control reads its numbers from
 * ===========================================================================
 *
 * WHY THESE LIVE IN ONE FILE. The controls below only work as a set. The
 * guessing risk of a 6-digit code is `attempts_per_challenge *
 * challenges_per_window / 10^6`; the cooldown is what makes
 * `challenges_per_window` meaningful; the TTL is what stops a challenge being
 * ground down over days. Splitting them across the service, the DTO and the
 * controller is how one of them quietly drifts and the arithmetic stops
 * holding. Every number is stated here with the reasoning that picked it.
 *
 * WITH THE VALUES BELOW: 6 digits (10^6 codes), 5 wrong guesses per challenge,
 * 5 challenges per mobile per hour => at most 25 guesses/hour against one
 * number, i.e. a 1-in-40 000 chance of hitting a given code within an hour and
 * a hard ceiling of 600 guesses/day. The per-IP cap then stops one host
 * farming many numbers at once.
 *
 * NOT ENVIRONMENT VARIABLES, DELIBERATELY (for now). Promoting these to env
 * vars means adding them to `src/configs/env.validation.ts`, which is owned by
 * another workstream — an unvalidated `configService.get()` with a silent
 * fallback is exactly the pattern that file exists to abolish. Flagged in the
 * hand-off: if the owner wants them tunable per environment, they belong in
 * EnvironmentVariables with `@IsInt()`/`@Min()` bounds, and this module should
 * then read them through a provider rather than export bare constants.
 */

/** Digits in an issued code. 6 keeps the SMS readable; see the arithmetic above. */
export const OTP_CODE_LENGTH = 6;

/**
 * Lifetime of an issued code, in seconds.
 *
 * 120s preserves the previous behaviour exactly (the old Redis key used
 * `ttl = 120`), so no user-visible timing changes with this hardening. Short
 * enough that a code intercepted from a lock screen notification is usually
 * already dead; long enough for a slow SMS route.
 */
export const OTP_TTL_SECONDS = 120;

/**
 * Minimum gap between two `send-otp` calls for the SAME normalized mobile.
 *
 * 60s. This is the control that turns "send a code" from a free SMS-billing
 * and SMS-bombing primitive into a rate-limited one, and it is why the hourly
 * cap below is reachable but not instantly exhaustible.
 */
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

/**
 * Wrong codes tolerated per challenge before the challenge is dead.
 *
 * 5. A human mistypes once or twice; nobody needs five. Enforced with a single
 * conditional UPDATE (`WHERE attempts < "maxAttempts"`) so parallel guesses
 * cannot exceed it, and backed structurally by the CHECK constraint
 * `ck_otp_challenges_attempts`.
 */
export const OTP_MAX_VERIFY_ATTEMPTS = 5;

/** Window for the per-mobile send cap, in seconds. One hour. */
export const OTP_SEND_WINDOW_SECONDS = 3600;

/**
 * Sends allowed per normalized mobile per window.
 *
 * 5/hour. With the 60s cooldown a legitimate user who never receives the SMS
 * can still retry five times — enough to get through a flaky route, few enough
 * to bound both the guessing budget and the SMS bill for one number.
 */
export const OTP_MAX_SENDS_PER_MOBILE = 5;

/** Window for the per-IP send cap, in seconds. One hour. */
export const OTP_IP_WINDOW_SECONDS = 3600;

/**
 * Sends allowed per client IP per window.
 *
 * 20/hour. Deliberately looser than the per-mobile cap because a single IP is
 * a shared identity: a household, an office, or a carrier-grade NAT pool can
 * legitimately be many different customers. The per-mobile cap is the tight
 * control; this one exists so that one host cannot farm hundreds of DIFFERENT
 * numbers (which the per-mobile cap alone cannot see).
 */
export const OTP_MAX_SENDS_PER_IP = 20;

// ===========================================================================
// Mobile normalization — ONE function, used by the DTOs and the service
// ===========================================================================

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/**
 * Characters a human (or a copy-paste out of a right-to-left document) can leave
 * in a phone number and that carry no information. Anything that is neither a
 * digit nor in this set invalidates the WHOLE input rather than being stripped.
 */
const SEPARATORS = new Set([
  ' ',
  '\t',
  '-',
  '(',
  ')',
  '\u00a0', // non-breaking space
  '\u200e', // left-to-right mark
  '\u200f', // right-to-left mark
]);

/** The canonical form every OTP control is keyed by. */
export const NORMALIZED_MOBILE_PATTERN = /^09\d{9}$/;

/**
 * Canonicalizes an Iranian mobile number to `09XXXXXXXXX`, or returns `''`
 * when the input is not one.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. Cooldown, both rate limits, challenge
 * lookup and user creation are all keyed by the mobile number. If two spellings
 * of the same number produce two keys, every one of those controls is
 * bypassable by alternating spellings — request a code as `09121234567`, then
 * again as `+989121234567`, and the cooldown never fires. So normalization
 * happens exactly ONCE, here, and both the DTOs (via `@Transform`) and
 * `OtpService` route through this function. The service normalizes again
 * defensively; the function is idempotent, so that is free.
 *
 * ACCEPTED SPELLINGS (a strict superset of what the DTOs accepted before, so
 * no previously-valid request becomes invalid):
 *   09121234567      national, the canonical form
 *   9121234567       national without the trunk 0
 *   +989121234567    E.164
 *   00989121234567   international prefix
 *   989121234567     country code without either prefix
 * plus spaces, tabs, hyphens, brackets and non-breaking spaces anywhere, and
 * Persian (۰۹…) or Arabic-Indic (٠٩…) digits.
 *
 * ANY OTHER CHARACTER MAKES THE WHOLE INPUT INVALID — it is not silently
 * stripped. Dropping unknown characters would mean `09121234567<script>`
 * normalized to a valid number, i.e. the validator would stop being able to
 * reject junk.
 */
export function normalizeMobile(raw: unknown): string {
  if (typeof raw !== 'string') return '';

  let digits = '';
  let explicitPlus = false;

  for (const character of raw.trim()) {
    if (character === '+') {
      // Only meaningful as the very first character.
      if (digits.length > 0 || explicitPlus) return '';
      explicitPlus = true;
      continue;
    }
    if (SEPARATORS.has(character)) continue;

    if (character >= '0' && character <= '9') {
      digits += character;
      continue;
    }
    const persian = PERSIAN_DIGITS.indexOf(character);
    if (persian >= 0) {
      digits += String(persian);
      continue;
    }
    const arabic = ARABIC_DIGITS.indexOf(character);
    if (arabic >= 0) {
      digits += String(arabic);
      continue;
    }
    return '';
  }

  // Reduce every accepted spelling to the 10-digit national number.
  //
  // The `98` country code is only stripped from a 12-digit string, and a
  // national number is always 11 digits starting `09`, so the two can never be
  // confused by length.
  let national = digits;
  if (explicitPlus) {
    if (!national.startsWith('98')) return '';
    national = national.slice(2);
  } else if (national.startsWith('0098')) {
    national = national.slice(4);
  } else if (national.length === 12 && national.startsWith('98')) {
    national = national.slice(2);
  } else if (national.startsWith('0')) {
    national = national.slice(1);
  }

  if (!/^9\d{9}$/.test(national)) return '';
  return `0${national}`;
}
