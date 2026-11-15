import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { MAX_RIAL } from 'src/common/money/rial';

/**
 * Stable, machine-readable error codes for purchase-cost accounting
 * (docs/PURCHASE-COST-ACCOUNTING.md §11). They travel in the envelope's
 * `error` field, which is the only non-message key `GlobalExceptionFilter`
 * keeps at the top level.
 */
export const CostingErrorCodes = Object.freeze({
  PURCHASE_COST_REQUIRED: 'PURCHASE_COST_REQUIRED',
  PURCHASE_COST_INVALID: 'PURCHASE_COST_INVALID',
  PURCHASE_COST_OUT_OF_RANGE: 'PURCHASE_COST_OUT_OF_RANGE',
  PURCHASE_COST_FORBIDDEN: 'PURCHASE_COST_FORBIDDEN',
  PURCHASE_COST_NOT_UPDATABLE: 'PURCHASE_COST_NOT_UPDATABLE',
  INITIAL_STOCK_REQUIRES_PURCHASE_COST: 'INITIAL_STOCK_REQUIRES_PURCHASE_COST',
  INVENTORY_COST_UNVALUED: 'INVENTORY_COST_UNVALUED',
  INVENTORY_ALREADY_VALUED: 'INVENTORY_ALREADY_VALUED',
  INVENTORY_VALUATION_STALE: 'INVENTORY_VALUATION_STALE',
  STOCK_INCREASE_REQUIRES_RECEIPT: 'STOCK_INCREASE_REQUIRES_RECEIPT',
  STOCK_RECEIPT_IDEMPOTENCY_CONFLICT: 'STOCK_RECEIPT_IDEMPOTENCY_CONFLICT',
  ORDER_HAS_LINE_ADJUSTMENTS: 'ORDER_HAS_LINE_ADJUSTMENTS',
  ORDER_NOT_ADJUSTABLE: 'ORDER_NOT_ADJUSTABLE',
  ORDER_LINE_NOT_FULFILLED: 'ORDER_LINE_NOT_FULFILLED',
  ADJUSTMENT_EXCEEDS_LINE: 'ADJUSTMENT_EXCEEDS_LINE',
  COST_ALLOCATION_INVARIANT_VIOLATION: 'COST_ALLOCATION_INVARIANT_VIOLATION',
});

export type CostingErrorCode =
  (typeof CostingErrorCodes)[keyof typeof CostingErrorCodes];

/** Persian messages. Never contain a cost figure (they reach logs and clients). */
export const CostingMessages = Object.freeze({
  PURCHASE_COST_REQUIRED: 'قیمت خرید هر واحد الزامی است.',
  PURCHASE_COST_INVALID: 'قیمت خرید باید عدد صحیح ریال و بدون اعشار باشد.',
  PURCHASE_COST_OUT_OF_RANGE: `قیمت خرید باید بین ۰ و ${MAX_RIAL} ریال باشد و ارزش موجودی از سقف مجاز فراتر نرود.`,
  PURCHASE_COST_FORBIDDEN:
    'فقط مدیر کل می‌تواند قیمت خرید را ثبت یا مشاهده کند.',
  PURCHASE_COST_NOT_UPDATABLE:
    'قیمت خرید گونهٔ موجود از ویرایش محصول تغییر نمی‌کند؛ از بخش «قیمت خرید و ارزش موجودی» استفاده کنید.',
  INITIAL_STOCK_REQUIRES_PURCHASE_COST:
    'برای ثبت موجودی اولیه، قیمت خرید هر واحد را وارد کنید.',
  INVENTORY_COST_UNVALUED: 'بخشی از موجودی این گونه هنوز ارزش‌گذاری نشده است.',
  INVENTORY_ALREADY_VALUED: 'موجودی این گونه قبلاً ارزش‌گذاری شده است.',
  INVENTORY_VALUATION_STALE:
    'تعداد موجودی ارزش‌گذاری‌نشده تغییر کرده است؛ صفحه را تازه کنید و دوباره بررسی کنید.',
  STOCK_INCREASE_REQUIRES_RECEIPT:
    'افزایش موجودی فقط از طریق «ثبت ورود کالا» یا «اصلاح موجودی» با قیمت خرید ممکن است.',
  STOCK_RECEIPT_IDEMPOTENCY_CONFLICT:
    'این کلید تکرار قبلاً برای درخواست دیگری استفاده شده است.',
  ORDER_HAS_LINE_ADJUSTMENTS:
    'این سفارش برگشت یا بازپرداخت جزئی دارد؛ باقی اقلام را از بخش برگشت اقلام ثبت کنید.',
  ORDER_NOT_ADJUSTABLE:
    'برای این سفارش امکان ثبت برگشت یا بازپرداخت وجود ندارد.',
  ORDER_LINE_NOT_FULFILLED:
    'این قلم هنوز از انبار خارج نشده است؛ سفارش را لغو کنید.',
  ADJUSTMENT_EXCEEDS_LINE:
    'تعداد درخواستی از مقدار باقی‌ماندهٔ این قلم بیشتر است.',
  COST_ALLOCATION_INVARIANT_VIOLATION:
    'خطای داخلی در محاسبهٔ بهای تمام‌شده. عملیات انجام نشد.',
});

function body(code: CostingErrorCode, extra?: Record<string, unknown>) {
  return {
    error: code,
    message: CostingMessages[code as keyof typeof CostingMessages],
    ...(extra ?? {}),
  };
}

export const costingError = {
  badRequest: (code: CostingErrorCode, extra?: Record<string, unknown>) =>
    new BadRequestException(body(code, extra)),
  conflict: (code: CostingErrorCode, extra?: Record<string, unknown>) =>
    new ConflictException(body(code, extra)),
  forbidden: (code: CostingErrorCode, extra?: Record<string, unknown>) =>
    new ForbiddenException(body(code, extra)),
  invariant: (detail: string) =>
    new InternalServerErrorException({
      ...body(CostingErrorCodes.COST_ALLOCATION_INVARIANT_VIOLATION),
      // The detail names ids and quantities only, never a Rial figure.
      detail,
    }),
};
