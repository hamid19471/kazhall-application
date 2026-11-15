/**
 * Persian sentences and stable codes for product-image upload refusals.
 *
 * PERSIAN, on purpose — and here that is load-bearing rather than a courtesy.
 * `FormError` in the Admin console renders `error.messages` VERBATIM; it does
 * no code-to-Persian lookup of its own. So whatever the API puts in `message`
 * is literally the sentence a store manager reads while holding a photo they
 * cannot upload. An English SDK string in that slot is a support call.
 *
 * WHAT EACH SENTENCE HAS TO DO. A refusal is useful only if the reader can act
 * on it, so each one names the fix rather than the fault:
 *
 *   - the caller's own mistakes (wrong format, too big, broken file) say what
 *     to send instead;
 *   - the operator's mistakes (storage unreachable, bucket absent) say plainly
 *     that this is not the user's fault and who to tell, because a manager who
 *     believes they broke it will retry the same file for ten minutes.
 *
 * THE CODES, NOT THE SENTENCES, ARE THE CONTRACT. `GlobalExceptionFilter`
 * promotes a payload's string `error` to the top level of the envelope, so
 *
 *   new PayloadTooLargeException({ error: ProductImageErrorCodes.IMAGE_TOO_LARGE, … })
 *
 * yields `{ statusCode: 413, message, error: 'IMAGE_TOO_LARGE', details }`.
 * Clients branch on `error`; the sentence may be reworded at any time.
 */

/**
 * The size limit is interpolated rather than hard-coded into the sentence,
 * because `PRODUCT_IMAGE_MAX_BYTES` is configurable and a message that says
 * "5 مگابایت" while the server enforces 2 is worse than no number at all.
 */
export const ProductImageMessages = {
  FILE_REQUIRED: 'فایلی ارسال نشد. یک تصویر انتخاب کنید.',

  TYPE_UNSUPPORTED:
    'قالب این فایل پشتیبانی نمی‌شود. فقط تصویرهای JPEG، PNG و WebP پذیرفته می‌شوند.',

  /**
   * Said separately from TYPE_UNSUPPORTED because the fix is different: the
   * file IS an image of an accepted kind, but its bytes are incomplete — an
   * interrupted copy, a failed export, a file still being written.
   */
  MALFORMED:
    'این فایل تصویر سالم نیست یا ناقص ارسال شده است. دوباره انتخاب و ارسال کنید.',

  /** Interpolates the configured maximum, in megabytes. */
  tooLarge: (maxBytes: number): string =>
    `حجم این تصویر بیش از حد مجاز است. حداکثر اندازه ${formatMegabytesFa(maxBytes)} مگابایت است.`,

  /**
   * Deliberately says «با پشتیبانی فنی تماس بگیرید» and NOT «دوباره تلاش کنید».
   * Storage being unreachable or unconfigured is not fixed by retrying, and
   * inviting a retry turns one operator's failed upload into twenty.
   */
  STORAGE_UNAVAILABLE:
    'سرویس ذخیره‌سازی تصویر در دسترس نیست. این ایراد از سمت سامانه است؛ لطفاً با پشتیبانی فنی تماس بگیرید.',

  /**
   * Split out from STORAGE_UNAVAILABLE even though the user's action is the
   * same, because the OPERATOR's action is not: a missing bucket is a
   * provisioning step nobody ran, and saying so turns a mystery into a
   * one-line fix.
   */
  STORAGE_BUCKET_MISSING:
    'فضای ذخیره‌سازی تصویرها هنوز آماده نشده است. این ایراد از سمت سامانه است؛ لطفاً با پشتیبانی فنی تماس بگیرید.',
} as const;

/** Persian-digit megabytes, at most one decimal, without a trailing `.0`. */
function formatMegabytesFa(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  const rounded = Math.round(mb * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return text.replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
}

/**
 * Stable machine-readable codes for image upload.
 *
 * The 4xx codes describe something the CALLER can fix. The 503s describe
 * something only an operator can fix, and are deliberately not 500: a 500 says
 * "the server broke", which sends the reader to the wrong place and is also
 * what the generic «خطای بحرانی» screen already said before this change.
 */
export const ProductImageErrorCodes = {
  /** 400 — no `file` part in the multipart body, or an empty one. */
  IMAGE_FILE_REQUIRED: 'IMAGE_FILE_REQUIRED',
  /** 415 — the bytes are a format this project does not accept (SVG, GIF, PDF…). */
  IMAGE_TYPE_UNSUPPORTED: 'IMAGE_TYPE_UNSUPPORTED',
  /** 413 — larger than `PRODUCT_IMAGE_MAX_BYTES`. */
  IMAGE_TOO_LARGE: 'IMAGE_TOO_LARGE',
  /** 400 — claims an accepted format but the bytes do not hold up. */
  IMAGE_MALFORMED: 'IMAGE_MALFORMED',

  /**
   * 503 — the storage subsystem is not usable: not configured, unreachable,
   * refusing the credentials, or failing for any reason the caller cannot
   * influence.
   */
  IMAGE_STORAGE_UNAVAILABLE: 'IMAGE_STORAGE_UNAVAILABLE',
  /** 503 — storage answered, and the configured bucket does not exist. */
  IMAGE_STORAGE_BUCKET_MISSING: 'IMAGE_STORAGE_BUCKET_MISSING',
} as const;

export type ProductImageErrorCode =
  (typeof ProductImageErrorCodes)[keyof typeof ProductImageErrorCodes];
