/**
 * Persian, customer-facing text for every OTP outcome on the sign-in screen.
 *
 * The API's messages are English and meant for developers; its machine-
 * readable `error` codes (`OTP_COOLDOWN`, `OTP_DELIVERY_FAILED`, …) are the
 * contract. This module maps those CODES — never the English text — to what a
 * customer reads, so the API is untouched and a reworded server message can
 * never change the UI.
 *
 * Accuracy rules this text keeps:
 *
 *  - Nothing says an SMS was sent unless the server answered success.
 *    `OTP_DELIVERY_FAILED` says plainly that NO message was sent;
 *    `OTP_DELIVERY_UNCERTAIN` says it is not confirmed and may still arrive.
 *  - Every wait comes from the server's `retryAfterSeconds`. With no figure,
 *    the text names no number.
 *  - A failed verification never says WHICH failure it was (wrong digits,
 *    expired, used, too many tries): the server answers all of them with one
 *    identical `OTP_INVALID` on purpose, and the text must not undo that.
 *
 * Pure (no React), so `node --test` pins every case.
 */

export type OtpMessageTone = 'danger' | 'warning' | 'info';

export type OtpMessage = {
  tone: OtpMessageTone;
  title: string;
  body: string;
};

/** The subset of `ApiError` this module reads. */
type ErrorShape = {
  status?: unknown;
  kind?: unknown;
  code?: unknown;
  retryAfterSeconds?: unknown;
};

const NUMBER = new Intl.NumberFormat('fa-IR');

/** `45` → "۴۵ ثانیه", `90` → "۲ دقیقه", `3600` → "۶۰ دقیقه". */
export function formatWait(seconds: number): string {
  const whole = Math.max(1, Math.ceil(seconds));
  if (whole < 60) return `${NUMBER.format(whole)} ثانیه`;
  return `${NUMBER.format(Math.ceil(whole / 60))} دقیقه`;
}

function read(error: unknown): {
  status: number | undefined;
  kind: string | undefined;
  code: string | undefined;
  wait: number | undefined;
} {
  const shape = (error && typeof error === 'object' ? error : {}) as ErrorShape;
  const wait =
    typeof shape.retryAfterSeconds === 'number' &&
    Number.isFinite(shape.retryAfterSeconds) &&
    shape.retryAfterSeconds >= 0
      ? shape.retryAfterSeconds
      : undefined;
  return {
    status: typeof shape.status === 'number' ? shape.status : undefined,
    kind: typeof shape.kind === 'string' ? shape.kind : undefined,
    code: typeof shape.code === 'string' ? shape.code : undefined,
    wait,
  };
}

/** True for a failure where the request may never have reached the server. */
function isConnectionFailure(
  kind: string | undefined,
  status: number | undefined,
): boolean {
  return kind === 'network' || kind === 'timeout' || status === 0;
}

const CONNECTION: OtpMessage = {
  tone: 'danger',
  title: 'ارتباط برقرار نشد',
  body: 'ارتباط با فروشگاه برقرار نشد. اتصال اینترنت خود را بررسی کنید و دوباره تلاش کنید.',
};

const UNAVAILABLE: OtpMessage = {
  tone: 'danger',
  title: 'ورود موقتاً در دسترس نیست',
  body: 'لطفاً چند لحظهٔ دیگر دوباره تلاش کنید.',
};

const GENERIC: OtpMessage = {
  tone: 'danger',
  title: 'مشکلی پیش آمد',
  body: 'لطفاً دوباره تلاش کنید.',
};

/**
 * Standing instructions under the form. Static truths about the code only —
 * nothing here says a message was or will be sent.
 */
export const OTP_INSTRUCTIONS: readonly string[] = [
  'کد ورود ۶ رقمی است و با پیامک به شمارهٔ موبایل شما فرستاده می‌شود.',
  'هر کد فقط یک بار و برای مدت کوتاهی قابل استفاده است.',
  'اگر پیامکی نرسید، پس از پایان زمان انتظار کد تازه درخواست کنید.',
  'این کد را در اختیار هیچ‌کس قرار ندهید.',
];

/** Shown after a SUCCESSFUL send — the only place "sent" is said. */
export const OTP_SENT_MESSAGE: OtpMessage = {
  tone: 'info',
  title: 'کد ورود ارسال شد',
  body: 'پیامک کد ورود برای این شماره ارسال شد. رسیدن آن ممکن است چند لحظه طول بکشد.',
};

/** For a failed `POST /auth/storefront/send-otp`. `undefined` → no message. */
export function otpSendErrorMessage(error: unknown): OtpMessage | undefined {
  if (error === undefined || error === null) return undefined;
  const { status, kind, code, wait } = read(error);

  if (code === 'OTP_DELIVERY_FAILED') {
    return {
      tone: 'danger',
      title: 'ارسال کد ورود انجام نشد',
      body:
        wait !== undefined && wait > 0
          ? `پیامکی برای شما ارسال نشد. لطفاً ${formatWait(wait)} دیگر دوباره درخواست کنید.`
          : 'پیامکی برای شما ارسال نشد. لطفاً دوباره درخواست کنید.',
    };
  }

  if (code === 'OTP_DELIVERY_UNCERTAIN') {
    return {
      tone: 'warning',
      title: 'ارسال پیامک هنوز تأیید نشده است',
      body:
        wait !== undefined && wait > 0
          ? `ممکن است کد ورود با کمی تأخیر برسد. اگر پیامک رسید، کد را همین‌جا وارد کنید؛ وگرنه ${formatWait(wait)} دیگر کد تازه درخواست کنید.`
          : 'ممکن است کد ورود با کمی تأخیر برسد. اگر پیامک رسید، کد را همین‌جا وارد کنید؛ وگرنه کمی بعد کد تازه درخواست کنید.',
    };
  }

  if (code === 'OTP_COOLDOWN') {
    return {
      tone: 'info',
      title: 'کد ورود به‌تازگی درخواست شده است',
      body:
        wait !== undefined && wait > 0
          ? `اگر کد را دریافت کرده‌اید، آن را وارد کنید. درخواست کد تازه ${formatWait(wait)} دیگر ممکن است.`
          : 'اگر کد را دریافت کرده‌اید، آن را وارد کنید.',
    };
  }

  if (code === 'OTP_SEND_RATE_LIMITED' || status === 429) {
    return {
      tone: 'danger',
      title: 'تعداد درخواست‌های کد ورود بیش از حد مجاز است',
      body:
        wait !== undefined && wait > 0
          ? `لطفاً ${formatWait(wait)} دیگر دوباره تلاش کنید.`
          : 'لطفاً کمی بعد دوباره تلاش کنید.',
    };
  }

  if (isConnectionFailure(kind, status)) return CONNECTION;
  if (kind === 'validation' || status === 400) {
    return {
      tone: 'danger',
      title: 'شمارهٔ موبایل معتبر نیست',
      body: 'شمارهٔ موبایل را به شکل ۰۹xxxxxxxxx وارد کنید.',
    };
  }
  if (typeof status === 'number' && status >= 500) return UNAVAILABLE;
  return GENERIC;
}

/** For a failed `POST /auth/storefront/verify-otp`. `undefined` → no message. */
export function otpVerifyErrorMessage(error: unknown): OtpMessage | undefined {
  if (error === undefined || error === null) return undefined;
  const { status, kind, code } = read(error);

  // ONE message for wrong, expired, already-used and exhausted codes — the
  // server deliberately does not say which, and neither does this.
  if (code === 'OTP_INVALID') return OTP_INVALID_MESSAGE;

  // A 401 that is NOT `OTP_INVALID` is only reachable with a correct code
  // (e.g. a deactivated account). Telling that customer "wrong code" would
  // send them round the resend loop for ever.
  if (status === 401) {
    return {
      tone: 'danger',
      title: 'ورود با این حساب ممکن نیست',
      body: 'لطفاً با پشتیبانی فروشگاه تماس بگیرید.',
    };
  }

  if (isConnectionFailure(kind, status)) return CONNECTION;
  if (kind === 'validation' || status === 400) {
    return {
      tone: 'danger',
      title: 'کد ورود کامل نیست',
      body: 'کد ورود را کامل و فقط با رقم وارد کنید.',
    };
  }
  if (typeof status === 'number' && status >= 500) return UNAVAILABLE;
  return GENERIC;
}

/** Wrong, expired, used or exhausted — deliberately indistinguishable. */
export const OTP_INVALID_MESSAGE: OtpMessage = {
  tone: 'danger',
  title: 'کد پذیرفته نشد',
  body: 'کد واردشده درست نیست یا مهلت استفاده از آن تمام شده است. اگر کد معتبری در دست ندارید، یک کد تازه درخواست کنید.',
};
