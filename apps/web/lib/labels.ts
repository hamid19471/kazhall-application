/**
 * Persian labels for every server enum the UI renders.
 *
 * ONE RULE governs this file: **never promise more than the server said.**
 * `paid` is not "delivered". `refund_required` is not "refunded". A fulfilment
 * state of `pending` is not "on its way". Where the honest Persian is longer
 * than the pretty Persian, the honest one wins.
 *
 * Every lookup falls back to the raw wire value rather than to a blank or to a
 * guess: an unknown status must be visible as an unknown status.
 */

import type { BadgeTone } from "@kazhal/ui";

function labelOf(map: Record<string, string>, value: string | null | undefined, fallback = "—"): string {
  if (value === null || value === undefined || value === "") return fallback;
  return map[value] ?? value;
}

// ---------------------------------------------------------------------------
// Orders — the MONEY state
// ---------------------------------------------------------------------------

const ORDER_STATUS: Record<string, string> = {
  pending: "در انتظار پرداخت",
  paid: "پرداخت‌شده",
  processing: "در حال آماده‌سازی",
  shipped: "ارسال‌شده",
  delivered: "تحویل‌شده",
  canceled: "لغو‌شده",
  failed: "ناموفق",
  refunded: "بازپرداخت‌شده",
};

const ORDER_STATUS_TONE: Record<string, BadgeTone> = {
  pending: "warning",
  paid: "success",
  processing: "info",
  shipped: "info",
  delivered: "success",
  canceled: "neutral",
  failed: "danger",
  refunded: "neutral",
};

export const orderStatusLabel = (v: string | null | undefined) => labelOf(ORDER_STATUS, v);
export const orderStatusTone = (v: string | null | undefined): BadgeTone =>
  (v && ORDER_STATUS_TONE[v]) || "neutral";

// ---------------------------------------------------------------------------
// Orders — the GOODS state, tracked independently of the money
// ---------------------------------------------------------------------------

const FULFILLMENT_STATE: Record<string, string> = {
  not_required: "بدون نیاز به آماده‌سازی",
  pending: "هنوز آماده‌سازی نشده",
  fulfilled: "از انبار کسر شد",
  awaiting_stock: "در انتظار موجودی",
  failed: "آماده‌سازی ناموفق",
};

export const fulfillmentStateLabel = (v: string | null | undefined) =>
  labelOf(FULFILLMENT_STATE, v);

export const fulfillmentStateTone = (v: string | null | undefined): BadgeTone => {
  switch (v) {
    case "fulfilled":
      return "success";
    case "awaiting_stock":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
};

// ---------------------------------------------------------------------------
// The customer-safe review state
//
// This is the ONLY thing a customer is told about a reconciliation case, and it
// is deliberately tiny. It never says "fulfilled" about goods that have not
// moved and never says "refunded" about money that has not gone back.
// ---------------------------------------------------------------------------

export const REVIEW_STATE_MESSAGE: Record<string, string> = {
  under_review: "پرداخت شما دریافت شد؛ سفارش در حال بررسی است.",
  refund_in_progress: "بازپرداخت هماهنگ شده و در حال انجام است.",
};

export const REVIEW_STATE_DETAIL: Record<string, string> = {
  under_review:
    "مبلغ پرداختی شما ثبت شده است. این سفارش برای بررسی دستی علامت خورده و همکاران ما در حال رسیدگی هستند. تا پایان بررسی، وضعیت ارسال تغییری نمی‌کند.",
  refund_in_progress:
    "بازگرداندن وجه هماهنگ شده و در حال انجام است. تا زمانی که بازپرداخت به‌طور قطعی تأیید نشود، این سفارش «بازپرداخت‌شده» اعلام نمی‌شود.",
};

export const reviewStateLabel = (v: string | null | undefined) =>
  v ? (REVIEW_STATE_MESSAGE[v] ?? v) : "";

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

const PAYMENT_STATUS: Record<string, string> = {
  pending: "در انتظار پاسخ درگاه",
  success: "تأییدشده و اعمال‌شده",
  failed: "ناموفق",
  refunded: "بازپرداخت‌شده",
  confirmed_unapplied: "تأییدشده اما اعمال‌نشده",
};

export const paymentStatusLabel = (v: string | null | undefined) => labelOf(PAYMENT_STATUS, v);

export const paymentStatusTone = (v: string | null | undefined): BadgeTone => {
  switch (v) {
    case "success":
      return "success";
    case "confirmed_unapplied":
      return "warning";
    case "failed":
      return "danger";
    case "refunded":
      return "info";
    default:
      return "neutral";
  }
};

const PAYMENT_METHOD: Record<string, string> = {
  cash: "نقدی",
  card_terminal: "کارتخوان",
  online_gateway: "درگاه اینترنتی",
  other: "سایر",
};

export const paymentMethodLabel = (v: string | null | undefined) => labelOf(PAYMENT_METHOD, v);

const RECONCILIATION_REASON: Record<string, string> = {
  duplicate_confirmed: "رسید تکراری؛ پرداخت دیگری قبلاً سفارش را تسویه کرده بود",
  order_not_payable: "سفارش در زمان تأیید پرداخت، قابل پرداخت نبود",
  late_confirmation_unapplied: "تأیید دیرهنگام؛ روی سفارش اعمال نشد",
  late_confirmation_applied: "تأیید دیرهنگام؛ روی سفارش اعمال شد (اطلاع‌رسانی)",
  amount_mismatch: "مبلغ اعلامی درگاه با مبلغ درخواستی برابر نیست",
  amount_missing: "درگاه هیچ مبلغی اعلام نکرد",
  amount_invalid: "مبلغ اعلامی درگاه معتبر نیست",
};

export const paymentReconciliationReasonLabel = (v: string | null | undefined) =>
  labelOf(RECONCILIATION_REASON, v, "");

// ---------------------------------------------------------------------------
// Basket change notices
//
// The API never names a staff member, a branch or another customer here, and
// these labels must not try to enrich it.
// ---------------------------------------------------------------------------

/**
 * Why a basket line changed without the customer asking.
 *
 * THE FIRST THREE ARE WHAT THE SERVER ACTUALLY EMITS. `InventoryService`
 * suppresses the reasons the CUSTOMER caused — `basket_item_removed`,
 * `quantity_reduced`, `converted_to_order` — because they already know, so a
 * notice would be noise. The rest are here defensively: they exist in
 * `ReservationReleaseReason`, they are order-reservation reasons rather than
 * basket ones today, and if one ever did reach a basket line the customer
 * should read a sentence rather than the generic fallback.
 *
 * PRIVACY. Every sentence says WHAT happened and never WHO. There is no
 * cashier, no branch, no other customer and no basket identity in any of them —
 * the API deliberately does not send those, and the wording must not invent
 * them. "در فروش حضوری" names a channel, not a shop.
 */
const CART_CHANGE_REASON: Record<string, string> = {
  sold_in_store: "این کالا در فروش حضوری به مشتری دیگری رسید و از سبد شما کم شد.",
  reservation_expired: "مهلت چهار‌ساعتهٔ نگهداری این کالا در سبد به پایان رسید.",
  /*
   * DERIVED by the server from the variant's current state, so it can appear
   * on a line nothing has happened to. The sentence says the item cannot be
   * ordered and asks for it to be taken out of the basket — it must NOT say
   * the line was removed (it is still there, with its units still held) and
   * must NOT suggest trying again later, because `POST /orders` refuses the
   * basket until the line is gone.
   */
  not_sellable: "این کالا دیگر برای فروش موجود نیست و ثبت سفارش آن ممکن نیست؛ برای ادامه، آن را از سبد بردارید.",
  /*
   * WITHDRAWN FROM THE WEBSITE — deliberately NOT the `not_sellable` sentence.
   *
   * The SKU may be perfectly active and selling briskly over the counter; what
   * changed is only that this channel no longer offers it. So the copy says
   * «در وب‌سایت عرضه نمی‌شود» and must NOT claim the item is deactivated,
   * discontinued or out of stock — all three would be false. Like
   * `not_sellable` it blocks the order until the line is gone, so it asks for
   * removal and does not invite a later retry; and like every other basket
   * sentence it names no shop, branch or member of staff.
   */
  channel_unavailable:
    "این کالا دیگر در وب‌سایت عرضه نمی‌شود و ثبت سفارش آن ممکن نیست؛ برای ادامه، آن را از سبد بردارید.",
  stock_not_counted: "موجودی این کالا در آخرین شمارش تأیید نشد.",
  quantity_reduced: "تعداد این کالا در سبد شما کم شد.",
  basket_item_removed: "این کالا از سبد شما برداشته شد.",
  converted_to_order: "این کالا به سفارش شما تبدیل شد.",
  order_cancelled: "سفارش مربوط به این کالا لغو شد و نگهداری آن پایان یافت.",
  payment_failed: "پرداخت این سفارش انجام نشد و نگهداری این کالا پایان یافت.",
  fulfilled: "این کالا از انبار کسر و برای شما آماده شد.",
};

export const cartChangeReasonLabel = (v: string | null | undefined) =>
  labelOf(CART_CHANGE_REASON, v, "سبد شما تغییر کرد.");

/**
 * Is there Persian copy for this reason / change kind?
 *
 * `labelOf` returns the RAW CODE for a value it does not know (its fallback
 * covers only null / undefined / ""), so a caller that has a better fallback of
 * its own — the checkout notice list, which can print the server's sentence —
 * has to be able to ask first rather than test for the code coming back out.
 */
export const hasCartChangeReasonLabel = (v: string | null | undefined): boolean =>
  typeof v === "string" && v !== "" && v in CART_CHANGE_REASON;

// ---------------------------------------------------------------------------
// Reconciliation queue (admin)
// ---------------------------------------------------------------------------

export const CASE_TYPE_LABEL: Record<string, string> = {
  unapplied_receipt: "رسید اعمال‌نشده",
  fulfilment_incomplete: "آماده‌سازی انجام‌نشده",
  awaiting_stock: "در انتظار موجودی",
  operator_open: "تصمیم باز اپراتور",
};

export const CASE_TYPE_DESCRIPTION: Record<string, string> = {
  unapplied_receipt:
    "درگاه پولی را تأیید کرده که روی سفارش اعمال نشده و هنوز کسی آن را نبسته است.",
  fulfilment_incomplete: "سفارش پرداخت شده اما کالا هنوز از انبار کسر نشده است.",
  awaiting_stock: "سفارش پرداخت شده اما موجودی برای کسر وجود نداشته است.",
  operator_open: "تصمیمی روی این پرونده ثبت شده و هنوز بسته نشده است.",
};

export const RECONCILIATION_STATE_LABEL: Record<string, string> = {
  open: "باز (بدون تصمیم)",
  refund_required: "نیازمند بازپرداخت — هنوز پرداخت نشده",
  refund_confirmed: "بازپرداخت تأییدشده",
  backordered: "در انتظار موجودی (تصمیم اپراتور)",
  resolved: "بسته‌شده بدون جابه‌جایی پول",
};

export const reconciliationStateLabel = (v: string | null | undefined) =>
  v === null || v === undefined ? "بررسی‌نشده" : (RECONCILIATION_STATE_LABEL[v] ?? v);

export const reconciliationStateTone = (v: string | null | undefined): BadgeTone => {
  switch (v) {
    case "refund_required":
      return "danger";
    case "refund_confirmed":
    case "resolved":
      return "success";
    case "backordered":
      return "warning";
    case "open":
      return "info";
    default:
      return "neutral";
  }
};

export const ACTION_LABEL: Record<string, string> = {
  retry_fulfilment: "تلاش دوباره برای تکمیل موجودی",
  mark_refund_required: "ثبت نیاز به بازپرداخت",
  confirm_external_refund: "تأیید بازپرداخت انجام‌شده در درگاه",
  mark_backorder: "ثبت یادداشت پیگیری (در انتظار موجودی)",
  resolve_no_action: "بستن پرونده بدون جابه‌جایی وجه",
};

export const RESOLUTION_TYPE_LABEL: Record<string, string> = {
  no_discrepancy: "مغایرتی وجود نداشت",
  settled_externally: "خارج از این سامانه تسویه شد",
  customer_agreed: "با مشتری هماهنگ شد و اقدامی لازم نیست",
  gateway_duplicate: "رسید تکراری درگاه؛ پولی جابه‌جا نشده",
};

/**
 * WHAT A PERSON DID, in Persian.
 *
 * Two different catalogues share this map on purpose, because one screen shows
 * both and neither namespace can collide with the other:
 *
 *  - the RECONCILIATION operator actions (`payment_actions.action`), the five
 *    bare verbs at the top, rendered by the reconciliation case timeline;
 *  - the ADMINISTRATIVE audit codes (`admin_audit_log.action`, the dotted
 *    `noun.verb` form catalogued in `audit.actions.ts`), rendered by the audit
 *    trail.
 *
 * EVERY dotted code the API will accept as an `?action=` filter is listed here.
 * A missing one is not cosmetic: the audit screen builds its action filter from
 * this catalogue, so an unlisted code becomes a row an operator cannot filter
 * for and a raw English string in a Persian table. The codes are written into
 * rows that outlive the code that wrote them, so they are added and retired —
 * never renamed.
 *
 * The wording never promises more than the act did. `user.password.reset` is an
 * administrator setting a TEMPORARY password, not the user changing their own;
 * `role.permissions.changed` is the grant list being rewritten, which is not
 * the same as the role being edited.
 */
const AUDIT_ACTION_LABEL: Record<string, string> = {
  // reconciliation operator actions (`payment_actions`)
  retry_fulfilment: "تلاش دوباره برای آماده‌سازی",
  mark_refund_required: "ثبت تعهد بازپرداخت",
  confirm_external_refund: "تأیید بازپرداخت انجام‌شده",
  mark_backorder: "ثبت انتظار موجودی",
  resolve_no_action: "بستن پرونده بدون اقدام مالی",

  // access control
  "role.created": "ایجاد نقش",
  "role.updated": "ویرایش نقش",
  "role.activated": "فعال‌کردن نقش",
  "role.deactivated": "غیرفعال‌کردن نقش",
  "role.deleted": "حذف نقش",
  "role.permissions.changed": "تغییر دسترسی‌های نقش",
  "user.roles.changed": "تغییر نقش‌های کاربر",

  // users
  "user.created": "ایجاد کاربر",
  "user.updated": "ویرایش کاربر",
  "user.activated": "فعال‌کردن کاربر",
  "user.deactivated": "غیرفعال‌کردن کاربر",
  "user.branch.changed": "تغییر شعبهٔ کاربر",
  "user.password.reset": "تعیین گذرواژهٔ موقت برای کاربر",
  "user.password.changed": "تغییر گذرواژه توسط خود کاربر",
  "user.sessions.revoked": "قطع نشست‌های کاربر",

  // branches
  "branch.created": "ایجاد شعبه",
  "branch.updated": "ویرایش شعبه",
  "branch.activated": "فعال‌کردن شعبه",
  "branch.deactivated": "غیرفعال‌کردن شعبه",

  // catalogue
  "category.created": "ایجاد دسته‌بندی",
  "category.updated": "ویرایش دسته‌بندی",
  "category.deleted": "حذف دسته‌بندی",
  "attribute.created": "ایجاد ویژگی",
  "attribute.updated": "ویرایش ویژگی",
  "attribute.deleted": "حذف ویژگی",
  "attribute.value.created": "ایجاد مقدار ویژگی",
  "attribute.value.updated": "ویرایش مقدار ویژگی",
  "attribute.value.deleted": "حذف مقدار ویژگی",
  "product.created": "ایجاد کالا",
  "product.updated": "ویرایش کالا",
  "variant.activated": "فعال‌کردن گونهٔ کالا",
  "variant.deactivated": "غیرفعال‌کردن گونهٔ کالا",

  // inventory
  "stock.adjusted": "اصلاح موجودی انبار",

  // orders
  "order.status.changed": "تغییر وضعیت سفارش",
  "order.voided": "ابطال سفارش",
  "order.returned": "ثبت مرجوعی سفارش",

  // reconciliation
  "reconciliation.action": "اقدام روی پروندهٔ مغایرت پرداخت",

  // monthly pricing plans — the rows carry ids and counts only, never an amount
  "pricing.plan.created": "ایجاد برنامهٔ قیمت‌گذاری ماهانه",
  "pricing.plan.updated": "ویرایش برنامهٔ قیمت‌گذاری ماهانه",
  "pricing.plan.deleted": "حذف برنامهٔ قیمت‌گذاری ماهانه",
  "pricing.plan.calculated": "محاسبهٔ پیش‌نمایش قیمت‌ها",
  "pricing.plan.approved": "تأیید برنامهٔ قیمت‌گذاری",
  "pricing.plan.applied": "اعمال قیمت‌های برنامه",
  "pricing.plan.rolled_back": "بازگردانی قیمت‌های برنامه",
};

export const auditActionLabel = (v: string | null | undefined) => labelOf(AUDIT_ACTION_LABEL, v);

/**
 * The dotted audit codes only, grouped for the audit screen's action filter.
 *
 * Derived from the map above rather than written out twice, so a code added
 * there appears in the filter automatically. The five bare reconciliation verbs
 * are excluded by the dot test: `GET /admin/audit?action=` rejects anything
 * outside `AUDIT_ACTION_CODES`, so offering them would build a 400 into the UI.
 */
export const AUDIT_ACTION_GROUPS: ReadonlyArray<{
  titleFa: string;
  prefixes: readonly string[];
}> = [
  { titleFa: "سفارش‌ها", prefixes: ["order."] },
  { titleFa: "مغایرت پرداخت", prefixes: ["reconciliation."] },
  { titleFa: "موجودی", prefixes: ["stock."] },
  { titleFa: "کاتالوگ", prefixes: ["product.", "variant.", "category.", "attribute."] },
  { titleFa: "کاربران", prefixes: ["user."] },
  { titleFa: "شعبه‌ها", prefixes: ["branch."] },
  { titleFa: "نقش‌ها و دسترسی‌ها", prefixes: ["role."] },
  { titleFa: "قیمت‌گذاری ماهانه", prefixes: ["pricing."] },
];

export const AUDIT_ACTION_CODES: readonly string[] = Object.keys(
  AUDIT_ACTION_LABEL,
).filter((code) => code.includes("."));

/** Kinds of subject an audit row can point at (`admin_audit_log.targetType`). */
const AUDIT_TARGET_TYPE: Record<string, string> = {
  user: "کاربر",
  role: "نقش",
  branch: "شعبه",
  category: "دسته‌بندی",
  attribute: "ویژگی",
  attribute_value: "مقدار ویژگی",
  product: "کالا",
  variant: "گونهٔ کالا",
  order: "سفارش",
  pricing_plan: "برنامهٔ قیمت‌گذاری",
};

export const auditTargetTypeLabel = (v: string | null | undefined) =>
  labelOf(AUDIT_TARGET_TYPE, v);

export const AUDIT_TARGET_TYPES = Object.keys(AUDIT_TARGET_TYPE);

// ---------------------------------------------------------------------------
// Channels and roles
// ---------------------------------------------------------------------------

const CHANNEL: Record<string, string> = { online: "اینترنتی", pos: "حضوری" };
export const channelLabel = (v: string | null | undefined) => labelOf(CHANNEL, v);

export const ROLE_LABEL: Record<string, string> = {
  super_admin: "مدیر کل",
  sale: "فروشندهٔ حضوری",
  site: "مشتری",
};

// ---------------------------------------------------------------------------
// Checkout conflicts
//
// Branch on the CODE, never on the human message — but the copy shown to the
// customer must say what actually has to happen next, not restate the code.
// ---------------------------------------------------------------------------

export interface ConflictCopy {
  title: string;
  body: string;
  /** What the UI must do next. */
  next: "requote" | "reduce" | "retry" | "refresh_cart" | "none";
}

export const CHECKOUT_CONFLICTS: Record<string, ConflictCopy> = {
  checkout_quote_required: {
    title: "برای ثبت سفارش به تأیید قیمت نیاز است",
    body: "قیمت و موجودی را یک بار دیگر می‌گیریم تا پیش از پرداخت، آن‌چه را تأیید می‌کنید ببینید.",
    next: "requote",
  },
  checkout_quote_invalid: {
    title: "تأیید قیمت معتبر نیست",
    body: "برگهٔ تأیید قیمت پذیرفته نشد. یک برگهٔ تازه می‌گیریم.",
    next: "requote",
  },
  checkout_quote_stale: {
    title: "تأیید قیمت منقضی شده است",
    body: "از زمان تأیید شما مدتی گذشته است. قیمت‌ها را دوباره می‌گیریم تا تصمیم شما روی عددهای امروز باشد.",
    next: "requote",
  },
  checkout_contents_changed: {
    title: "سبد شما تغییر کرده است",
    body: "محتویات سبد از زمان تأیید عوض شده است. سبد تازه را ببینید و دوباره تأیید کنید.",
    next: "requote",
  },
  checkout_retry_required: {
    title: "ثبت سفارش کامل نشد",
    body: "سفارش ثبت نشد و هیچ پولی کم نشده است. با همان درخواست دوباره تلاش کنید.",
    next: "retry",
  },
  INSUFFICIENT_STOCK: {
    title: "موجودی کافی نیست",
    body: "تعداد درخواستی شما از موجودی قابل رزرو بیشتر است. تعداد را کم کنید و دوباره تلاش کنید.",
    next: "reduce",
  },
  /*
   * A SKU in the basket was deactivated. The order is atomic, so the whole
   * basket is refused until the line is gone — and no requote or retry can
   * help, which is why `next` is neither of those: re-quoting would hand back
   * the same refusal and "try again" would be a dead end. The customer is told
   * to take the line out, which is the only thing that resolves it.
   */
  VARIANT_INACTIVE: {
    title: "یکی از کالاهای سبد دیگر برای فروش موجود نیست",
    body: "سفارشی ثبت نشد و هیچ پولی کم نشده است. این کالا از فروش خارج شده و تا وقتی در سبد بماند، ثبت سفارش ممکن نیست؛ آن را از سبد بردارید و دوباره تأیید کنید.",
    next: "refresh_cart",
  },
  IDEMPOTENCY_KEY_REUSED: {
    title: "این درخواست با محتوای دیگری قبلاً ثبت شده",
    body: "برای ثبت سفارش تازه، سبد را دوباره تأیید کنید.",
    next: "requote",
  },
  IDEMPOTENCY_REQUEST_IN_PROGRESS: {
    title: "همین درخواست در حال ثبت است",
    body: "چند لحظه صبر کنید؛ سفارش شما در حال ثبت است و دوباره فرستادن آن سفارش دومی نمی‌سازد.",
    next: "retry",
  },
  IDEMPOTENCY_KEY_REQUIRED: {
    title: "درخواست ناقص بود",
    body: "دوباره تلاش کنید.",
    next: "retry",
  },
  IDEMPOTENCY_KEY_INVALID: {
    title: "درخواست ناقص بود",
    body: "دوباره تلاش کنید.",
    next: "retry",
  },
};

// ---------------------------------------------------------------------------
// Payment verification outcomes
// ---------------------------------------------------------------------------

export type VerifyOutcome =
  | "paid"
  | "paid_unapplied"
  | "under_review"
  | "rejected"
  | "not_found"
  | "unknown";

export const VERIFY_COPY: Record<VerifyOutcome, { title: string; body: string; tone: BadgeTone }> = {
  paid: {
    title: "پرداخت شما تأیید شد",
    body: "مبلغ دریافت و روی سفارش شما اعمال شد.",
    tone: "success",
  },
  paid_unapplied: {
    title: "پرداخت شما دریافت شد، اما هنوز روی سفارش اعمال نشده است",
    body:
      "درگاه پرداخت شما را تأیید کرده است. این پرداخت هنوز سفارش را تسویه نکرده و برای بررسی دستی " +
      "ثبت شده است. پولی دوباره از شما کم نمی‌شود و سفارش بدون تعیین تکلیف رها نخواهد شد.",
    tone: "warning",
  },
  under_review: {
    title: "پرداخت شما دریافت شد؛ سفارش در حال بررسی است",
    body:
      "مبلغ ثبت شده است، ولی به‌طور خودکار قابل تسویه نبود. همکاران ما در حال بررسی هستند و نتیجه " +
      "در همین صفحهٔ سفارش نمایش داده می‌شود.",
    tone: "warning",
  },
  rejected: {
    title: "پرداخت انجام نشد",
    body: "درگاه پرداخت این تراکنش را تأیید نکرد. مبلغی از شما کم نشده است. می‌توانید دوباره تلاش کنید.",
    tone: "danger",
  },
  not_found: {
    title: "این تراکنش پیدا نشد",
    body:
      "شناسهٔ پرداختی که برگشت داده شد، برای حساب شما قابل بررسی نیست. اگر مبلغی از حساب شما کم شده، " +
      "با پشتیبانی تماس بگیرید و شمارهٔ سفارش را اعلام کنید.",
    tone: "neutral",
  },
  unknown: {
    title: "وضعیت پرداخت هنوز مشخص نیست",
    body:
      "پاسخ قطعی از درگاه گرفته نشد. تا زمانی که نتیجه روشن نشود، سفارش شما «پرداخت‌شده» اعلام " +
      "نمی‌شود. کمی بعد دوباره بررسی کنید.",
    tone: "neutral",
  },
};

// ---------------------------------------------------------------------------
// Accounts, surfaces and cashiers (admin)
//
// A SESSION AUDIENCE and a SURFACE are the same three values seen from two
// angles: `sessionsByAudience` counts open sessions per audience, while
// `canAccess` says which surfaces the account's roles let it open at all. The
// audience wording is longer because it appears in prose ("۲ نشست در پنل
// مدیریت"); the surface wording is short because it appears in table badges.
// ---------------------------------------------------------------------------

const SESSION_AUDIENCE: Record<string, string> = {
  storefront: "فروشگاه اینترنتی",
  admin: "پنل مدیریت",
  pos: "صندوق فروشگاه",
};

export const audienceLabel = (v: string | null | undefined) => labelOf(SESSION_AUDIENCE, v);

const ACCOUNT_SURFACE: Record<string, string> = {
  storefront: "فروشگاه",
  admin: "پنل مدیریت",
  pos: "صندوق",
};

export const surfaceLabel = (v: string | null | undefined) => labelOf(ACCOUNT_SURFACE, v);

/** The order surfaces are listed in, so every screen shows them the same way. */
export const ACCOUNT_SURFACES = ["storefront", "admin", "pos"] as const;

/**
 * Why a cashier cannot ring up a sale right now.
 *
 * These come from `GET /admin/cashiers`, which evaluates exactly the predicates
 * `POST /orders/pos` will evaluate at the till. The wording therefore describes
 * the CAUSE, not the symptom — "شعبه ندارد" is actionable, "نمی‌تواند بفروشد"
 * is not.
 */
const CASHIER_BLOCKED_REASON: Record<string, string> = {
  account_deactivated: "حساب غیرفعال است",
  no_branch: "شعبه ندارد",
  branch_inactive: "شعبهٔ او غیرفعال است",
  password_change_required: "باید گذرواژه را تغییر دهد",
};

export const cashierBlockedReasonLabel = (v: string | null | undefined) =>
  labelOf(CASHIER_BLOCKED_REASON, v, "");

// ---------------------------------------------------------------------------
// Machine-readable refusals from the people and branch routes
//
// Branch on `error.code` — the canonical read is `body.error ?? details.code`,
// which `ApiError.code` already performs. The server's own message is English,
// so these are the Persian the operator actually reads; `body` says what to DO,
// because a refusal the operator cannot act on is just a dead end.
// ---------------------------------------------------------------------------

export interface CodedFailure {
  title: string;
  body: string;
}

export const ACCOUNT_FAILURES: Record<string, CodedFailure> = {
  LAST_SUPER_ADMIN: {
    title: "این تغییر آخرین مدیر سامانه را از دست می‌دهد",
    body:
      "سامانه بدون دست‌کم یک حساب فعال که بتواند وارد شود و دسترسی‌ها را اداره کند رها نمی‌شود. " +
      "نخست به حساب دیگری نقش مدیر کل بدهید و آن حساب را فعال کنید، سپس این تغییر را انجام دهید.",
  },
  PERMISSION_ESCALATION: {
    title: "نمی‌توانید اختیاری بدهید که خودتان ندارید",
    body:
      "نقش‌هایی که انتخاب کرده‌اید دسترسی‌هایی دارند که روی حساب خودتان نیست، و سرور این کار را " +
      "رد می‌کند. از مدیر ارشد بخواهید یا آن اختیار را به نقش شما اضافه کند، یا خودش این نقش را " +
      "تخصیص دهد.",
  },
  USERNAME_TAKEN: {
    title: "این نام کاربری قبلاً استفاده شده است",
    body: "نام کاربری در کل سامانه یگانه است. نام دیگری بگذارید؛ چیزی ثبت نشد.",
  },
  MOBILE_TAKEN: {
    title: "این شمارهٔ موبایل روی حساب دیگری ثبت است",
    body:
      "شمارهٔ موبایل یگانه است، چون ورود مشتری با همان شماره انجام می‌شود. شماره را بررسی کنید یا " +
      "آن را خالی بگذارید؛ چیزی ثبت نشد.",
  },
  NOT_A_STAFF_ACCOUNT: {
    title: "این حساب گذرواژه ندارد",
    body:
      "این یک حساب مشتری است: ورود آن با کد یک‌بارمصرف پیامکی انجام می‌شود و هیچ گذرواژه‌ای برای " +
      "آن ذخیره نشده تا بازنشانی شود. برای اینکه این شخص کارمند شود باید حسابی با نام کاربری " +
      "ساخته شود.",
  },
  BRANCH_NAME_TAKEN: {
    title: "شعبه‌ای با همین نام وجود دارد",
    body:
      "نام شعبه یگانه است، چون همین نام روی سفارش‌های حضوری ثبت می‌شود و دو شعبهٔ هم‌نام سابقه را " +
      "غیرقابل‌تفکیک می‌کند. نام دیگری بگذارید.",
  },
  BRANCH_IN_USE: {
    title: "این شعبه حذف نمی‌شود، چون به آن ارجاع وجود دارد",
    body:
      "شعبه‌ای که کارمندی به آن تخصیص یافته یا سفارشی به نامش ثبت شده حذف نمی‌شود؛ حذف آن سابقه " +
      "را می‌شکند. برای بازنشسته‌کردن شعبه، آن را غیرفعال کنید.",
  },
  BRANCH_INACTIVE: {
    title: "این شعبه غیرفعال است",
    body: "تا زمانی که شعبه غیرفعال است، فروش حضوری در صندوق آن ثبت نمی‌شود.",
  },
};

export const accountFailure = (code: string | null | undefined): CodedFailure | null =>
  code ? (ACCOUNT_FAILURES[code] ?? null) : null;

// ---------------------------------------------------------------------------
// Orders — the DERIVED payment state, and the axis a date range runs on
// ---------------------------------------------------------------------------

/**
 * The order list's `paymentState`, which is NOT `payment.status`.
 *
 * `paymentStatusLabel` above names one receipt's own status. This names the
 * server's aggregate over ALL of an order's receipts, and it has one value that
 * no receipt has: `none`.
 *
 * `none` IS DELIBERATELY NOT "پرداخت‌نشده". An order whose only receipt is
 * `confirmed_unapplied` — real money that settled nothing — also reads `none`,
 * because the server refuses to call that `success` (the order is not paid) or
 * `pending` (something did arrive). Labelling it "unpaid" would put that
 * refusal back as a false claim, so the wording says what is actually true:
 * nothing has been recorded AGAINST THE ORDER, and the reconciliation queue is
 * the screen that owns the rest of the story.
 */
const ORDER_PAYMENT_STATE: Record<string, string> = {
  success: "پرداخت‌شده و اعمال‌شده",
  refunded: "بازپرداخت‌شده",
  pending: "پرداخت باز و بی‌نتیجه",
  failed: "همهٔ پرداخت‌ها ناموفق",
  none: "بدون پرداخت ثبت‌شده روی سفارش",
};

export const paymentStateLabel = (v: string | null | undefined) =>
  labelOf(ORDER_PAYMENT_STATE, v);

export const paymentStateTone = (v: string | null | undefined): BadgeTone => {
  switch (v) {
    case "success":
      return "success";
    case "refunded":
      return "info";
    case "pending":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
};

/** What a `paymentState` value means in one sentence, for a filter's hint. */
export const ORDER_PAYMENT_STATE_NOTE: Record<string, string> = {
  none:
    "«بدون پرداخت ثبت‌شده» شامل سفارش‌هایی هم می‌شود که رسید تأییدشدهٔ اعمال‌نشده دارند؛ آن‌ها در صف مغایرت پرداخت دیده می‌شوند.",
};

const ORDER_DATE_FIELD: Record<string, string> = {
  sold: "تاریخ فروش",
  paid: "تاریخ دریافت وجه",
  created: "تاریخ ثبت رکورد",
};

export const orderDateFieldLabel = (v: string | null | undefined) =>
  labelOf(ORDER_DATE_FIELD, v);

/** Why an operator would pick each axis. Shown under the date-field select. */
export const ORDER_DATE_FIELD_NOTE: Record<string, string> = {
  sold: "زمانی که فروش زده شده است. محور طبیعی فهرست سفارش‌ها.",
  paid:
    "زمانی که پول واقعاً رسیده است. سفارش پرداخت‌نشده تاریخ دریافت وجه ندارد و با این محور در بازه نمی‌آید.",
  created: "زمان ساخت ردیف در پایگاه داده. برای پیگیری پشتیبانی، نه برای حسابداری.",
};

/**
 * The four verbs of an order's own append-only history (`order_actions.action`).
 *
 * Separate from the audit catalogue on purpose: this ledger belongs to the
 * ORDER and is written inside the transaction that changed it, while
 * `admin_audit_log` is the cross-cutting record of what a PERSON did. The same
 * void appears in both, and the two are allowed to describe it in their own
 * vocabulary.
 */
const ORDER_ACTION_KIND: Record<string, string> = {
  status_change: "تغییر وضعیت",
  void: "ابطال سفارش",
  return: "ثبت مرجوعی",
  refund: "ثبت بازپرداخت",
};

export const orderActionKindLabel = (v: string | null | undefined) =>
  labelOf(ORDER_ACTION_KIND, v);

export const orderActionKindTone = (v: string | null | undefined): BadgeTone => {
  switch (v) {
    case "void":
      return "danger";
    case "return":
    case "refund":
      return "info";
    default:
      return "neutral";
  }
};

// ---------------------------------------------------------------------------
// Audit summaries
//
// `admin_audit_log.summary` is arbitrary JSON written by whichever service
// recorded the act, so this map cannot be exhaustive and does not pretend to
// be: an unknown key falls back to the key itself rather than being hidden.
// Hiding it would be the worse failure — a field an operator cannot see is a
// change they cannot review.
// ---------------------------------------------------------------------------

const AUDIT_SUMMARY_KEY: Record<string, string> = {
  before: "پیش از تغییر",
  after: "پس از تغییر",
  granted: "دسترسی‌های افزوده‌شده",
  revoked: "دسترسی‌های برداشته‌شده",
  added: "افزوده‌شده",
  removed: "برداشته‌شده",
  reason: "دلیل",
  name: "نام فنی",
  titleFa: "عنوان",
  description: "توضیح",
  permissions: "دسترسی‌ها",
  roles: "نقش‌ها",
  roleIds: "شناسهٔ نقش‌ها",
  values: "مقادیر",
  attributeId: "شناسهٔ ویژگی",
  attributeName: "نام ویژگی",
  productCount: "تعداد کالای وابسته",
  username: "نام کاربری",
  mobile: "شمارهٔ موبایل",
  identifier: "شناسهٔ ورود",
  isActive: "فعال",
  isStaff: "کارمند",
  mustChangePassword: "الزام تغییر گذرواژه",
  branchId: "شناسهٔ شعبه",
  branchName: "نام شعبه",
  address: "نشانی",
  phone: "تلفن",
  status: "وضعیت",
  fulfillmentState: "وضعیت آماده‌سازی",
  orderNumber: "شمارهٔ سفارش",
  orderId: "شناسهٔ سفارش",
  productId: "شناسهٔ کالا",
  variantId: "شناسهٔ گونه",
  sku: "کد کالا",
  title: "عنوان",
  slug: "نشانی یکتا",
  parentId: "شناسهٔ والد",
  mode: "نوع اصلاح",
  value: "مقدار",
  previousStock: "موجودی پیشین",
  balanceAfter: "موجودی پس از اصلاح",
  basketReserved: "رزرو سبد خرید",
  orderAllocated: "تخصیص‌یافته به سفارش",
  belowReserved: "کمتر از مقدار رزروشده",
  revoked_sessions: "نشست‌های قطع‌شده",
  sessionsRevoked: "نشست‌های قطع‌شده",
  action: "اقدام",
  resolutionType: "نوع تعیین تکلیف",
  amount: "مبلغ",
};

export const auditSummaryKeyLabel = (v: string) => AUDIT_SUMMARY_KEY[v] ?? v;

/** Persian for the primitive values that show up inside a summary. */
export function auditSummaryValueLabel(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "بله" : "خیر";
  if (typeof value === "string" && value === "") return "(خالی)";
  return String(value);
}

// ---------------------------------------------------------------------------
// The physical-stock ledger
//
// `reason` on a `stock_movements` row is the MACHINE reason and is the only
// "why" the ledger stores — the free text an administrator typed when correcting
// stock is not in this table at all (it is in the administrative audit trail).
// So these five labels have to carry the whole explanation of what moved the
// units, and each says WHO or WHAT caused it rather than restating the code.
// ---------------------------------------------------------------------------

const STOCK_MOVEMENT_REASON: Record<string, string> = {
  pos_sale: "فروش حضوری در صندوق",
  online_fulfillment: "کسر برای سفارش اینترنتی",
  cancellation_restore: "برگشت به انبار پس از ابطال سفارش",
  return_restore: "برگشت به انبار پس از مرجوعی",
  manual_adjustment: "اصلاح دستی توسط مدیر",
  initial_stock: "موجودی اولیه هنگام ساخت کالا",
  stock_receipt: "ثبت ورود کالا",
  inventory_correction: "اصلاح موجودی",
  valuation_initialization: "ارزش‌گذاری موجودی قبلی",
};

export const stockMovementReasonLabel = (v: string | null | undefined) =>
  labelOf(STOCK_MOVEMENT_REASON, v);

/*
 * PURCHASE-COST ACCOUNTING (apps/api/docs/PURCHASE-COST-ACCOUNTING.md).
 * Every figure is GROSS profit — nothing here is ever labelled «سود خالص».
 */

const COST_STATUS: Record<string, string> = {
  valued: "ارزش‌گذاری‌شده",
  unvalued: "ارزش‌گذاری‌نشده",
};
export const costStatusLabel = (v: string | null | undefined) => labelOf(COST_STATUS, v);

const COST_COVERAGE: Record<string, string> = {
  complete: "قیمت خرید کامل",
  partial: "قیمت خرید ناقص",
  none: "بدون قیمت خرید",
};
export const costCoverageLabel = (v: string | null | undefined) => labelOf(COST_COVERAGE, v);
export const costCoverageTone = (v: string | null | undefined): BadgeTone =>
  v === "complete" ? "success" : v === "partial" ? "warning" : "danger";

const LINE_COST_STATUS: Record<string, string> = {
  pending: "در انتظار خروج از انبار",
  known: "قیمت خرید معلوم",
  unknown: "قیمت خرید نامعلوم",
};
export const lineCostStatusLabel = (v: string | null | undefined) => labelOf(LINE_COST_STATUS, v);
export const lineCostStatusTone = (v: string | null | undefined): BadgeTone =>
  v === "known" ? "success" : v === "pending" ? "info" : "warning";

const LINE_ADJUSTMENT_KIND: Record<string, string> = {
  return_refund: "برگشت کالا با بازپرداخت",
  refund_only: "بازپرداخت بدون برگشت کالا",
  return_only: "برگشت کالا بدون بازپرداخت",
  void: "ابطال",
};
export const lineAdjustmentKindLabel = (v: string | null | undefined) =>
  labelOf(LINE_ADJUSTMENT_KIND, v);

const PROFIT_GROUP_BY: Record<string, string> = {
  day: "روز",
  branch: "شعبه",
  channel: "کانال",
  cashier: "صندوق‌دار",
  product: "محصول",
  variant: "گونه",
  category: "دسته‌بندی",
};
export const profitGroupByLabel = (v: string | null | undefined) => labelOf(PROFIT_GROUP_BY, v);

/** §9, word for word. Shown beside every row whose cost coverage is not complete. */
export const INCOMPLETE_COST_WARNING = "اطلاعات قیمت خرید این فروش ناقص است؛ سود قابل محاسبه نیست.";

/**
 * The stock BANDS of the inventory and product lists.
 *
 * The boundary between «رو به اتمام» and «موجود» is a display heuristic the
 * request carries, not a reorder point the shop owner has set — the labels
 * therefore describe a shelf, never an instruction to buy more.
 */
const STOCK_STATE: Record<string, string> = {
  in_stock: "موجود",
  low_stock: "رو به اتمام",
  out_of_stock: "ناموجود",
};

export const stockStateLabel = (v: string | null | undefined) => labelOf(STOCK_STATE, v);

/**
 * A role's Persian name, from its machine `name`.
 *
 * `GET /branch/:id` returns a branch's staff with role NAMES rather than ids,
 * so there is nothing to look the `titleFa` up by. The three built-in roles are
 * named here; a CUSTOM role falls back to its own machine name, which is at
 * least true — inventing Persian for a role somebody else created would be a
 * guess.
 */
export const roleNameLabel = (v: string | null | undefined) => labelOf(ROLE_LABEL, v);
