import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import { PRICING_INPUT_PROBLEMS } from './pricing-formula';

/**
 * Stable error codes of the monthly pricing API (docs/MONTHLY-PRICING.md §8),
 * each with the Persian sentence the admin console shows. A code never carries
 * a Rial figure or a rate in its body: an error response is not a place to
 * leak the numbers the refusal is about.
 */
export const PricingErrorCodes = {
  ...PRICING_INPUT_PROBLEMS,
  PRICING_FORBIDDEN: 'PRICING_FORBIDDEN',
  PRICING_PLAN_NOT_FOUND: 'PRICING_PLAN_NOT_FOUND',
  PRICING_COST_ENTRY_NOT_FOUND: 'PRICING_COST_ENTRY_NOT_FOUND',
  PRICING_ITEM_NOT_FOUND: 'PRICING_ITEM_NOT_FOUND',
  PRICING_RUN_NOT_FOUND: 'PRICING_RUN_NOT_FOUND',
  PRICING_PLAN_NOT_EDITABLE: 'PRICING_PLAN_NOT_EDITABLE',
  PRICING_PLAN_STATE_CONFLICT: 'PRICING_PLAN_STATE_CONFLICT',
  PRICING_PLAN_NOT_DELETABLE: 'PRICING_PLAN_NOT_DELETABLE',
  PRICING_INPUTS_INCOMPLETE: 'PRICING_INPUTS_INCOMPLETE',
  PRICING_NO_ELIGIBLE_VARIANTS: 'PRICING_NO_ELIGIBLE_VARIANTS',
  PRICING_NOTHING_TO_APPLY: 'PRICING_NOTHING_TO_APPLY',
  PRICING_APPLY_COUNT_MISMATCH: 'PRICING_APPLY_COUNT_MISMATCH',
  PRICING_PREVIEW_STALE: 'PRICING_PREVIEW_STALE',
  PRICING_ITEM_BLOCKED: 'PRICING_ITEM_BLOCKED',
  PRICING_ITEM_UNCHANGED: 'PRICING_ITEM_UNCHANGED',
  PRICING_OVERRIDE_INVALID: 'PRICING_OVERRIDE_INVALID',
  PRICING_OVERRIDE_BELOW_COST: 'PRICING_OVERRIDE_BELOW_COST',
  PRICING_AMOUNT_INVALID: 'PRICING_AMOUNT_INVALID',
  PRICING_RATE_INVALID: 'PRICING_RATE_INVALID',
  PRICING_BRANCH_NOT_FOUND: 'PRICING_BRANCH_NOT_FOUND',
  PRICING_REORDER_INVALID: 'PRICING_REORDER_INVALID',
  PRICING_COPY_SOURCE_NOT_FOUND: 'PRICING_COPY_SOURCE_NOT_FOUND',
  PRICING_RUN_ACTIVE: 'PRICING_RUN_ACTIVE',
  PRICING_IDEMPOTENCY_KEY_REQUIRED: 'PRICING_IDEMPOTENCY_KEY_REQUIRED',
  PRICING_IDEMPOTENCY_KEY_REUSED: 'PRICING_IDEMPOTENCY_KEY_REUSED',
  PRICING_LOCK_TIMEOUT: 'PRICING_LOCK_TIMEOUT',
  PRICING_RUN_ABANDONED: 'PRICING_RUN_ABANDONED',
  PRICING_RUN_FAILED: 'PRICING_RUN_FAILED',
} as const;
export type PricingErrorCode =
  (typeof PricingErrorCodes)[keyof typeof PricingErrorCodes];

export const PricingMessages: Record<PricingErrorCode, string> = {
  PRICING_TARGET_REVENUE_NOT_POSITIVE:
    'فروش ماهانهٔ هدف باید بیشتر از صفر باشد؛ سهم هزینه‌ها بر اساس همین عدد محاسبه می‌شود.',
  PRICING_AMOUNT_NEGATIVE: 'هیچ مبلغی نمی‌تواند منفی باشد.',
  PRICING_AMOUNT_TOO_LARGE: 'مبلغ واردشده از سقف مجاز بیشتر است.',
  PRICING_TAX_RATE_OUT_OF_RANGE:
    'درصد مالیات باید از ۰ تا کمتر از ۱۰۰ و حداکثر با دو رقم اعشار باشد.',
  PRICING_PROFIT_MARGIN_OUT_OF_RANGE:
    'درصد سود هدف باید از ۰ تا کمتر از ۱۰۰ و حداکثر با دو رقم اعشار باشد.',
  PRICING_ROUNDING_STEP_INVALID:
    'گام گرد کردن باید عددی صحیح از ۱ تا ۱۰٬۰۰۰٬۰۰۰ ریال باشد.',
  PRICING_DENOMINATOR_NOT_POSITIVE:
    'جمع «سهم هزینه‌های ماهانه از فروش هدف»، «مالیات» و «سود هدف» به ۱۰۰٪ یا بیشتر رسیده است؛ ' +
    'در این حالت هیچ قیمتی نمی‌تواند همهٔ آن‌ها را پوشش دهد. فروش ماهانهٔ هدف را بیشتر کنید، ' +
    'هزینه‌های ماهانه را کم کنید، یا درصد سود یا مالیات را پایین بیاورید تا جمع این سه کمتر از ۱۰۰٪ شود.',
  PRICING_FORBIDDEN: 'این بخش فقط در اختیار مدیر کل سامانه است.',
  PRICING_PLAN_NOT_FOUND: 'این برنامهٔ قیمت‌گذاری پیدا نشد.',
  PRICING_COST_ENTRY_NOT_FOUND: 'این ردیف هزینه پیدا نشد.',
  PRICING_ITEM_NOT_FOUND: 'این ردیف پیش‌نمایش پیدا نشد.',
  PRICING_RUN_NOT_FOUND: 'این عملیات پیدا نشد.',
  PRICING_PLAN_NOT_EDITABLE:
    'این برنامه در وضعیت فعلی قابل ویرایش نیست. برنامهٔ تأییدشده را ابتدا از حالت تأیید خارج کنید؛ ' +
    'برنامهٔ اعمال‌شده یا بازگردانده‌شده هرگز ویرایش نمی‌شود.',
  PRICING_PLAN_STATE_CONFLICT:
    'وضعیت این برنامه اجازهٔ این کار را نمی‌دهد. صفحه را دوباره بارگذاری کنید.',
  PRICING_PLAN_NOT_DELETABLE:
    'فقط برنامه‌ای که هرگز اعمال نشده است حذف می‌شود؛ تاریخچهٔ برنامه‌های اعمال‌شده نگه داشته می‌شود.',
  PRICING_INPUTS_INCOMPLETE:
    'پیش از محاسبه، فروش ماهانهٔ هدف، درصد مالیات و درصد سود هدف را وارد کنید.',
  PRICING_NO_ELIGIBLE_VARIANTS:
    'هیچ گونهٔ فعالی با قیمت خرید کاملاً معلوم پیدا نشد؛ قیمتی برای پیشنهاد وجود ندارد. ' +
    'ابتدا قیمت خرید کالاها را از بخش «بهای تمام‌شده» ثبت کنید.',
  PRICING_NOTHING_TO_APPLY: 'هیچ ردیف انتخاب‌شده‌ای قیمت را تغییر نمی‌دهد.',
  PRICING_APPLY_COUNT_MISMATCH:
    'تعداد قیمت‌هایی که تغییر می‌کنند با تعدادی که تأیید کردید یکی نیست. صفحه را دوباره بارگذاری کنید و دوباره تأیید کنید.',
  PRICING_PREVIEW_STALE:
    'قیمت یا بهای خرید بعضی گونه‌ها پس از محاسبه تغییر کرده است. هیچ قیمتی تغییر نکرد؛ ' +
    'ردیف‌های قدیمی علامت خوردند. آن‌ها را کنار بگذارید یا دوباره محاسبه کنید.',
  PRICING_ITEM_BLOCKED:
    'این ردیف مسدود است و اعمال نمی‌شود؛ ابتدا داده‌های کالا را اصلاح و دوباره محاسبه کنید.',
  PRICING_ITEM_UNCHANGED:
    'قیمت پیشنهادی این ردیف با قیمت فعلی یکی است؛ برای انتخاب آن، قیمت دیگری وارد کنید.',
  PRICING_OVERRIDE_INVALID:
    'قیمت دستی باید عددی صحیح و بیشتر از صفر، حداکثر تا سقف قیمت کالا باشد.',
  PRICING_OVERRIDE_BELOW_COST:
    'قیمت دستی نمی‌تواند کمتر از میانگین قیمت خرید همین گونه باشد.',
  PRICING_AMOUNT_INVALID: 'مبلغ باید عددی صحیح به ریال و بدون اعشار باشد.',
  PRICING_RATE_INVALID:
    'درصد را به صورت عدد، حداکثر با دو رقم اعشار وارد کنید (مثلاً ۹ یا ۱۲٫۵).',
  PRICING_BRANCH_NOT_FOUND: 'این شعبه پیدا نشد.',
  PRICING_REORDER_INVALID:
    'ترتیب ارسال‌شده باید دقیقاً همهٔ ردیف‌های هزینهٔ این برنامه را شامل شود.',
  PRICING_COPY_SOURCE_NOT_FOUND: 'برنامهٔ مبدأ برای رونوشت پیدا نشد.',
  PRICING_RUN_ACTIVE:
    'یک عملیات دیگر روی همین برنامه در حال اجراست؛ تا پایان آن صبر کنید.',
  PRICING_IDEMPOTENCY_KEY_REQUIRED:
    'شناسهٔ یکتای درخواست (Idempotency-Key) ارسال نشده یا نامعتبر است؛ صفحه را دوباره بارگذاری کنید.',
  PRICING_IDEMPOTENCY_KEY_REUSED:
    'این درخواست قبلاً با محتوای دیگری ارسال شده است. صفحه را دوباره بارگذاری کنید.',
  PRICING_LOCK_TIMEOUT:
    'بعضی کالاها هم‌زمان در حال ویرایش یا فروش بودند و عملیات در زمان مقرر انجام نشد. هیچ قیمتی تغییر نکرد؛ دوباره تلاش کنید.',
  PRICING_RUN_ABANDONED:
    'عملیات نیمه‌کاره ماند (مثلاً سرور دوباره راه‌اندازی شد). هیچ قیمتی تغییر نکرد؛ دوباره تلاش کنید.',
  PRICING_RUN_FAILED: 'عملیات با خطا متوقف شد و هیچ تغییری ثبت نشد.',
};

function body(code: PricingErrorCode, extra?: Record<string, unknown>) {
  return { error: code, message: PricingMessages[code], ...(extra ?? {}) };
}

export const pricingError = {
  badRequest: (code: PricingErrorCode, extra?: Record<string, unknown>) =>
    new BadRequestException(body(code, extra)),
  conflict: (code: PricingErrorCode, extra?: Record<string, unknown>) =>
    new ConflictException(body(code, extra)),
  notFound: (code: PricingErrorCode) => new NotFoundException(body(code)),
  forbidden: () =>
    new ForbiddenException(body(PricingErrorCodes.PRICING_FORBIDDEN)),
};

/** A failure a run records on itself; the message is resolved from the code. */
export class PricingRunError extends Error {
  constructor(
    readonly code: PricingErrorCode,
    readonly result: Record<string, unknown> | null = null,
  ) {
    super(code);
  }
}
