import type { ReconciliationCaseSummary } from "@kazhal/api-client";

import { isZeroRialString } from "@/lib/money";

/**
 * ===========================================================================
 * THE PLAIN-PERSIAN READING OF A CASE
 * ===========================================================================
 *
 * The queue's own vocabulary — case type, fulfilment state, payment state,
 * reconciliation state — is precise and is what an engineer needs. It is not
 * what a shop manager opens the page to find out. They need six answers:
 *
 *   1. What happened?
 *   2. Did we get the customer's money?
 *   3. Was stock taken?
 *   4. Can this order still be fulfilled?
 *   5. What should I do next?
 *   6. Is something needed in the payment provider's panel?
 *
 * This module derives all six from the SAME summary row the table renders, so
 * the sentence and the badges beside it cannot disagree. It is a pure function
 * of the row and has no opinions of its own: every branch below is a statement
 * about committed data.
 *
 * WHY DERIVED HERE AND NOT SENT BY THE SERVER. These are UI copy decisions —
 * wording, ordering, which of several true facts to lead with — and putting
 * them in the API would mean a copy change needs a deployment of the backend.
 * The FACTS they are derived from all come from the server.
 */

export type CaseSeverity = "urgent" | "review" | "external" | "resolved";

export const SEVERITY_LABEL: Record<CaseSeverity, string> = {
  urgent: "فوری",
  review: "نیازمند بررسی",
  external: "منتظر اقدام خارجی",
  resolved: "حل‌شده",
};

export const SEVERITY_TONE: Record<CaseSeverity, "danger" | "warning" | "info" | "success"> = {
  urgent: "danger",
  review: "warning",
  external: "info",
  resolved: "success",
};

export interface PlainCase {
  severity: CaseSeverity;
  /** 1. What happened — one sentence, no jargon. */
  whatHappened: string;
  /** 2. Did the customer's money arrive? */
  moneyReceived: "yes" | "no" | "partly" | "returned";
  moneyLabel: string;
  /** 3. Was stock consumed? */
  stockConsumed: "yes" | "no" | "unknown";
  stockLabel: string;
  /** 4. Can it still be fulfilled? */
  fulfillable: "yes" | "no" | "maybe";
  fulfillableLabel: string;
  /** 5. What the manager should do next. */
  nextStep: string;
  /** 6. Does this need an action in the provider's own panel? */
  needsGatewayAction: boolean;
}

export function readCase(row: ReconciliationCaseSummary): PlainCase {
  const resolved = row.reconciliationResolvedAt !== null;
  const state = row.reconciliationState;
  const paid = row.orderStatus === "paid";
  const held = !isZeroRialString(row.money.confirmedHeld);
  const unapplied = !isZeroRialString(row.money.confirmedUnapplied);
  const refunded = !isZeroRialString(row.money.refundedTotal);
  const types = row.caseTypes;

  // --- money -------------------------------------------------------------
  const money: PlainCase["moneyReceived"] = refunded
    ? "returned"
    : held
      ? row.money.hasAmountDiscrepancy
        ? "partly"
        : "yes"
      : "no";
  const moneyLabel: Record<PlainCase["moneyReceived"], string> = {
    yes: "بله — پول مشتری دریافت شده است.",
    no: "نه — هیچ وجهی از مشتری دریافت نشده است.",
    partly: "بله، اما مبلغ دریافتی با مبلغ سفارش یکی نیست.",
    returned: "پول دریافت و بعد بازگردانده شده است.",
  };

  // --- stock -------------------------------------------------------------
  // `fulfillmentState` is the authority: `fulfilled` means the units really
  // left the shelf; `pending`/`awaiting_stock` mean they never did.
  const stock: PlainCase["stockConsumed"] =
    row.fulfillmentState === "fulfilled"
      ? "yes"
      : row.fulfillmentState === "pending" || row.fulfillmentState === "awaiting_stock"
        ? "no"
        : "unknown";
  const stockLabel: Record<PlainCase["stockConsumed"], string> = {
    yes: "بله — کالا از انبار کسر شده است.",
    no: "نه — کالا هنوز از انبار کسر نشده است.",
    unknown: "این سفارش کسر موجودی لازم ندارد.",
  };

  // --- fulfillable -------------------------------------------------------
  const fulfillable: PlainCase["fulfillable"] =
    row.fulfillmentState === "fulfilled"
      ? "yes"
      : row.fulfillmentState === "awaiting_stock"
        ? "maybe"
        : paid
          ? "maybe"
          : "no";
  const fulfillableLabel: Record<PlainCase["fulfillable"], string> = {
    yes: "کالا قبلاً تحویل داده شده یا آماده است.",
    no: "با وضعیت فعلی سفارش، تکمیل آن معنا ندارد.",
    maybe: "اگر موجودی کافی باشد، می‌توان دوباره تلاش کرد.",
  };

  // --- the narrative, severity, and what to do ---------------------------
  if (resolved) {
    return {
      severity: "resolved",
      whatHappened:
        state === "refund_confirmed"
          ? "بازپرداخت این سفارش در درگاه انجام شده و همان‌جا ثبت و تأیید شده است."
          : "این پرونده بررسی و بسته شده است و پولی جابه‌جا نشده.",
      moneyReceived: money,
      moneyLabel: moneyLabel[money],
      stockConsumed: stock,
      stockLabel: stockLabel[stock],
      fulfillable,
      fulfillableLabel: fulfillableLabel[fulfillable],
      nextStep: "کاری لازم نیست. فقط برای سابقه نگه داشته شده است.",
      needsGatewayAction: false,
    };
  }

  if (state === "refund_required") {
    return {
      severity: "external",
      whatHappened:
        "تصمیم گرفته شده که پول مشتری برگردد، اما بازپرداخت هنوز انجام یا تأیید نشده است.",
      moneyReceived: money,
      moneyLabel: moneyLabel[money],
      stockConsumed: stock,
      stockLabel: stockLabel[stock],
      fulfillable,
      fulfillableLabel: fulfillableLabel[fulfillable],
      nextStep:
        "بازپرداخت را در پنل درگاه پرداخت انجام دهید، سپس با شمارهٔ پیگیری درگاه، «تأیید بازپرداخت انجام‌شده» را در همین پرونده ثبت کنید.",
      needsGatewayAction: true,
    };
  }

  if (state === "backordered") {
    return {
      severity: "external",
      whatHappened:
        "پول مشتری دریافت شده و تصمیم گرفته شده که سفارش باز بماند تا موجودی برسد.",
      moneyReceived: money,
      moneyLabel: moneyLabel[money],
      stockConsumed: stock,
      stockLabel: stockLabel[stock],
      fulfillable: "maybe",
      fulfillableLabel: "به‌محض تأمین موجودی، «تلاش دوباره برای تکمیل موجودی» را بزنید.",
      nextStep:
        "کالا را تأمین کنید، موجودی را در بخش موجودی اصلاح کنید و بعد در همین پرونده تلاش دوباره را بزنید.",
      needsGatewayAction: false,
    };
  }

  if (types.includes("awaiting_stock")) {
    return {
      severity: "urgent",
      whatHappened:
        "مشتری پول را پرداخت کرده، اما موجودی کافی برای کسر از انبار وجود نداشته است.",
      moneyReceived: money,
      moneyLabel: moneyLabel[money],
      stockConsumed: "no",
      stockLabel: stockLabel.no,
      fulfillable: "maybe",
      fulfillableLabel: fulfillableLabel.maybe,
      nextStep:
        "اگر کالا موجود است، «تلاش دوباره برای تکمیل موجودی» را بزنید. اگر نیست، یا انتظار موجودی را ثبت کنید یا نیاز به بازپرداخت را.",
      needsGatewayAction: false,
    };
  }

  if (types.includes("fulfilment_incomplete")) {
    return {
      severity: "urgent",
      whatHappened:
        "مشتری پول را پرداخت کرده و سفارش «پرداخت‌شده» است، اما کالا هیچ‌گاه از انبار کسر نشده.",
      moneyReceived: money,
      moneyLabel: moneyLabel[money],
      stockConsumed: "no",
      stockLabel: stockLabel.no,
      fulfillable: "maybe",
      fulfillableLabel: fulfillableLabel.maybe,
      nextStep:
        "«تلاش دوباره برای تکمیل موجودی» را بزنید. اگر دوباره شکست خورد، علتش کمبود موجودی یا مغایرت مبلغ درگاه است و در جزئیات پرونده مشخص می‌شود.",
      needsGatewayAction: false,
    };
  }

  if (unapplied || types.includes("unapplied_receipt")) {
    return {
      severity: "urgent",
      whatHappened: row.money.hasAmountDiscrepancy
        ? "درگاه پرداخت وجهی را تأیید کرده که با مبلغ سفارش نمی‌خواند و به همین دلیل روی سفارش اعمال نشده است."
        : "درگاه پرداخت وجهی را تأیید کرده که روی این سفارش اعمال نشده است — مثلاً پرداخت تکراری یا پرداخت دیرهنگام.",
      moneyReceived: money,
      moneyLabel: moneyLabel[money],
      stockConsumed: stock,
      stockLabel: stockLabel[stock],
      fulfillable,
      fulfillableLabel: fulfillableLabel[fulfillable],
      nextStep:
        "مبالغ را در جزئیات پرونده با پنل درگاه مقایسه کنید. اگر پول اضافه دریافت شده، نیاز به بازپرداخت را ثبت کنید؛ اگر رسید تکراری بوده و پولی جابه‌جا نشده، پرونده را ببندید.",
      needsGatewayAction: true,
    };
  }

  return {
    severity: "review",
    whatHappened: "این سفارش نیاز به بررسی انسانی دارد.",
    moneyReceived: money,
    moneyLabel: moneyLabel[money],
    stockConsumed: stock,
    stockLabel: stockLabel[stock],
    fulfillable,
    fulfillableLabel: fulfillableLabel[fulfillable],
    nextStep: "جزئیات پرونده را باز کنید و مبالغ و وضعیت انبار را بررسی کنید.",
    needsGatewayAction: false,
  };
}
