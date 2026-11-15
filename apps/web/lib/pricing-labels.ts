/**
 * Persian labels for the monthly pricing screens (docs/MONTHLY-PRICING.md).
 *
 * Kept OUT of `labels.ts` on purpose: that module is shared with the
 * storefront and ships in its bundle, and nothing about pricing plans belongs
 * there. Only the admin pricing components import this file.
 */
import type { BadgeTone } from "@kazhal/ui";

function labelOf(map: Record<string, string>, value: string | null | undefined, fallback = "—"): string {
  if (value === null || value === undefined || value === "") return fallback;
  return map[value] ?? value;
}

const PRICING_PLAN_STATUS: Record<string, string> = {
  DRAFT: "پیش‌نویس",
  CALCULATING: "در حال محاسبه",
  READY_FOR_REVIEW: "آمادهٔ بررسی",
  APPROVED: "تأییدشده",
  APPLYING: "در حال اعمال",
  APPLIED: "اعمال‌شده",
  FAILED: "ناموفق",
  ROLLED_BACK: "بازگردانده‌شده",
};

export const pricingPlanStatusLabel = (v: string | null | undefined) => labelOf(PRICING_PLAN_STATUS, v);

export const pricingPlanStatusTone = (v: string | null | undefined): BadgeTone => {
  switch (v) {
    case "APPLIED":
      return "success";
    case "APPROVED":
    case "READY_FOR_REVIEW":
      return "primary";
    case "CALCULATING":
    case "APPLYING":
      return "info";
    case "FAILED":
      return "danger";
    case "ROLLED_BACK":
      return "warning";
    default:
      return "neutral";
  }
};

const PRICING_ITEM_STATUS: Record<string, string> = {
  READY: "آماده",
  UNCHANGED: "بدون تغییر",
  NEEDS_REVIEW: "نیازمند بررسی",
  BLOCKED: "مسدود",
};

export const pricingItemStatusLabel = (v: string | null | undefined) => labelOf(PRICING_ITEM_STATUS, v);

export const pricingItemStatusTone = (v: string | null | undefined): BadgeTone =>
  v === "READY" ? "success" : v === "NEEDS_REVIEW" ? "warning" : v === "BLOCKED" ? "danger" : "neutral";

/** Why a row is blocked (fix the data) or needs review (a person may approve it). */
const PRICING_REASON: Record<string, string> = {
  VARIANT_INACTIVE: "گونه غیرفعال است",
  PRODUCT_NOT_OFFERED: "کالا در هیچ کانالی عرضه نمی‌شود",
  COST_UNKNOWN: "قیمت خرید معلوم نیست",
  COST_PARTIALLY_UNKNOWN: "قیمت خرید بخشی از موجودی معلوم نیست",
  NO_COST_BASIS: "موجودی ارزش‌گذاری‌شده ندارد؛ میانگین قیمت خرید وجود ندارد",
  ZERO_COST_BASIS: "میانگین قیمت خرید صفر است",
  PRICE_OUT_OF_RANGE: "قیمت پیشنهادی از سقف مجاز بیشتر است",
  STALE: "پس از محاسبه تغییر کرده است",
  CURRENT_PRICE_MISSING: "قیمت فعلی ثبت نشده است",
  CURRENT_PRICE_ZERO: "قیمت فعلی صفر است",
  PRICE_DECREASE: "قیمت کاهش می‌یابد",
  LARGE_INCREASE: "افزایش بیش از حد مجاز بدون بررسی",
};

export const pricingReasonLabel = (v: string | null | undefined) => labelOf(PRICING_REASON, v);

const PRICING_STALE_REASON: Record<string, string> = {
  PRICE_CHANGED: "قیمت فعلی پس از محاسبه تغییر کرد",
  COST_CHANGED: "میانگین قیمت خرید پس از محاسبه تغییر کرد",
  COST_NOW_UNKNOWN: "قیمت خرید بخشی از موجودی اکنون معلوم نیست",
  NO_LONGER_SELLABLE: "گونه دیگر قابل فروش نیست",
  VARIANT_MISSING: "گونه دیگر وجود ندارد",
};

export const pricingStaleReasonLabel = (v: string | null | undefined) => labelOf(PRICING_STALE_REASON, v);

const PRICING_RUN_KIND: Record<string, string> = {
  calculate: "محاسبهٔ پیش‌نمایش",
  apply: "اعمال قیمت‌ها",
  rollback: "بازگردانی قیمت‌ها",
};

export const pricingRunKindLabel = (v: string | null | undefined) => labelOf(PRICING_RUN_KIND, v);

const PRICING_RUN_STATUS: Record<string, string> = {
  queued: "در صف",
  running: "در حال اجرا",
  succeeded: "انجام شد",
  failed: "ناموفق",
};

export const pricingRunStatusLabel = (v: string | null | undefined) => labelOf(PRICING_RUN_STATUS, v);

export const pricingRunStatusTone = (v: string | null | undefined): BadgeTone =>
  v === "succeeded" ? "success" : v === "failed" ? "danger" : "info";

const PRICING_RUN_PHASE: Record<string, string> = {
  starting: "شروع",
  evaluating: "ارزیابی گونه‌ها",
  locking: "قفل کردن ردیف‌ها",
  verifying: "بررسی تغییرات پس از محاسبه",
  writing: "ثبت قیمت‌های تازه",
  restoring: "بازگرداندن قیمت‌های قبلی",
  done: "پایان",
};

export const pricingRunPhaseLabel = (v: string | null | undefined) => labelOf(PRICING_RUN_PHASE, v);
