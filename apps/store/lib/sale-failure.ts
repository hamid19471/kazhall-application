/**
 * Turning a `POST /orders/pos` (or void/return) rejection into an instruction
 * the cashier can act on, and — more importantly — into a decision about the
 * IDEMPOTENCY KEY.
 *
 * The key rule the whole till hangs on:
 *
 *   ONE key per sale attempt, held across every retry of that attempt.
 *   NEVER mint a new key after a timeout until the previous result is known.
 *
 * because the server's replay semantics are:
 *
 *   same key + same payload, completed   -> 201 replaying the original sale
 *   same key + different payload         -> 409 IDEMPOTENCY_KEY_REUSED
 *   same key while the first is running  -> 409 IDEMPOTENCY_REQUEST_IN_PROGRESS
 *   completed key, different cashier     -> 409 IDEMPOTENCY_KEY_FOREIGN_CASHIER
 *   a request that ROLLED BACK rolls its key back too
 *
 * That last line is what makes `INSUFFICIENT_STOCK` safe to edit-and-resend on
 * the same key, and what makes a TIMEOUT unsafe to do anything with: a timeout
 * is not a refusal, it is an unknown outcome. Minting a fresh key there would
 * convert "I don't know whether that sale happened" into "sell it twice".
 */

import { isApiError } from "@kazhal/api-client";

export type SaleFailureKind =
  | "unresolved"
  | "in_progress"
  | "insufficient_stock"
  | "variant_inactive"
  | "not_in_branch"
  | "key_reused"
  | "foreign_cashier"
  | "no_branch"
  | "unknown_variant"
  | "fulfilment_incomplete"
  | "unauthorized"
  | "forbidden"
  | "validation"
  | "conflict"
  | "generic";

export interface StockShortfall {
  variantId?: number;
  sku?: string;
  /** «کد محصول», when the server names it. Never derived here. */
  productCode?: string;
  /** «کد گونه», when the server names it. Never derived here. */
  variantCode?: string;
  requested?: number;
  available?: number;
  retryable?: boolean;
}

export interface ReconciliationPointer {
  orderId?: number;
  status?: string;
  fulfillmentState?: string;
  requestedStatus?: string;
  reconciliationQueue?: string;
}

export interface SaleFailure {
  kind: SaleFailureKind;
  title: string;
  body: string;
  /** Machine code, shown only as a small technical hint for support. */
  code?: string;
  /** All human messages the server sent. */
  messages: string[];

  /**
   * TRUE when we do not know whether the sale was recorded. The basket must be
   * frozen, the key must be kept, and the only safe moves are "retry with the
   * identical payload" or "abandon and go check the activity list".
   */
  outcomeUnknown: boolean;
  /** Safe to resend this exact payload on the SAME key. */
  canRetrySameKey: boolean;
  /** Safe to edit the basket and submit again on the same key. */
  canEditAndResubmit: boolean;
  /** The key is spent. A new attempt requires `renew()` — and a human check. */
  keyIsSpent: boolean;

  stock?: StockShortfall;
  reconciliation?: ReconciliationPointer;
}

const GENERIC_BODY = "لطفاً دوباره تلاش کنید. اگر تکرار شد با پشتیبانی تماس بگیرید.";

/**
 * The API's human messages are ENGLISH, not Persian — verified against the
 * running server (`"This sale has already been returned"`). They are still
 * worth showing, because they are the most precise statement of what the server
 * refused, but they must never be the headline on a Persian till. So every
 * branch below writes its own Persian title and body, and appends the server's
 * own words underneath, labelled as such.
 */
function withServerText(body: string, messages: string[]): string {
  const text = messages.join("\n").trim();
  if (text === "") return body;
  return `${body}\n\nپیام سرور: ${text}`;
}

function readNumber(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = source?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readString(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function base(kind: SaleFailureKind, title: string, body: string): SaleFailure {
  return {
    kind,
    title,
    body,
    messages: [],
    outcomeUnknown: false,
    canRetrySameKey: false,
    canEditAndResubmit: true,
    keyIsSpent: false,
  };
}

/**
 * Classify anything thrown by a POS mutation.
 *
 * `USER_NOT_IN_BRANCH` deserves a note: the server raises it as a bare
 * `BadRequestException` carrying only a human sentence, so the error envelope
 * has NO machine code for it. We therefore detect the branch problem from the
 * session (`branchId === null`) before ever submitting, and treat a 400 on the
 * sale route as a secondary, best-effort signal — never the primary one.
 */
export function classifySaleFailure(error: unknown): SaleFailure {
  if (!isApiError(error)) {
    const failure = base(
      "unresolved",
      "نتیجه‌ی این فروش مشخص نیست",
      "پاسخی از سرور دریافت نشد. تا روشن‌شدن نتیجه، سبد قفل می‌ماند.",
    );
    failure.outcomeUnknown = true;
    failure.canRetrySameKey = true;
    failure.canEditAndResubmit = false;
    return failure;
  }

  const messages = error.messages;
  const code = error.code;
  const details = error.details;

  // --- outcome genuinely unknown -----------------------------------------
  if (error.kind === "network" || error.kind === "timeout" || error.kind === "aborted") {
    const failure = base(
      "unresolved",
      "نتیجه‌ی این فروش مشخص نیست",
      "درخواست به سرور نرسید یا پاسخی برنگشت. ممکن است فروش ثبت شده باشد و ممکن است نشده باشد. " +
        "با همان کلید دوباره تلاش کنید — تکرار با کلید یکسان هرگز فروش دوم ایجاد نمی‌کند.",
    );
    failure.outcomeUnknown = true;
    failure.canRetrySameKey = true;
    failure.canEditAndResubmit = false;
    failure.messages = messages;
    return failure;
  }

  if (code === "IDEMPOTENCY_REQUEST_IN_PROGRESS") {
    const failure = base(
      "in_progress",
      "همین فروش در حال ثبت است",
      "درخواست قبلی هنوز روی سرور در جریان است. چند لحظه صبر کنید و دوباره تلاش کنید. " +
        "سبد را تغییر ندهید.",
    );
    failure.outcomeUnknown = true;
    failure.canRetrySameKey = true;
    failure.canEditAndResubmit = false;
    failure.code = code;
    failure.messages = messages;
    return failure;
  }

  // --- the key is bound to a DIFFERENT, completed sale --------------------
  if (code === "IDEMPOTENCY_KEY_REUSED") {
    const failure = base(
      "key_reused",
      "این کلید قبلاً برای فروش دیگری ثبت شده",
      "سرور فروش قبلی را دست‌نخورده نگه داشت و فروش دومی ایجاد نکرد. " +
        "پیش از هر کار دیگر، از مدیر بخواهید بررسی کند کدام فروش ثبت شده است.",
    );
    failure.keyIsSpent = true;
    failure.canEditAndResubmit = false;
    failure.code = code;
    failure.messages = messages;
    return failure;
  }

  if (code === "IDEMPOTENCY_KEY_FOREIGN_CASHIER") {
    const failure = base(
      "foreign_cashier",
      "این کلید متعلق به صندوق‌دار دیگری است",
      "یک فروش ثبت‌شده با این کلید به نام شخص دیگری است و هرگز به نام شما بازخوانی نمی‌شود. " +
        "این فروش را تکرار نکنید؛ ابتدا از مدیر بخواهید وضعیت را بررسی کند.",
    );
    failure.keyIsSpent = true;
    failure.canEditAndResubmit = false;
    failure.code = code;
    failure.messages = messages;
    return failure;
  }

  // --- a refusal that rolled back: the key is free again ------------------
  if (code === "INSUFFICIENT_STOCK") {
    const failure = base(
      "insufficient_stock",
      "موجودی کافی نیست",
      "هیچ کالایی کسر نشد و فروشی ثبت نشد. تعداد را اصلاح کنید یا کالا را از سبد بردارید.",
    );
    failure.code = code;
    failure.messages = messages;
    failure.canRetrySameKey = true;
    failure.stock = {
      ...(readNumber(details, "variantId") !== undefined
        ? { variantId: readNumber(details, "variantId") as number }
        : {}),
      ...(readString(details, "sku") ? { sku: readString(details, "sku") as string } : {}),
      ...(readNumber(details, "requested") !== undefined
        ? { requested: readNumber(details, "requested") as number }
        : {}),
      ...(readNumber(details, "available") !== undefined
        ? { available: readNumber(details, "available") as number }
        : {}),
      ...(typeof details?.["retryable"] === "boolean"
        ? { retryable: details["retryable"] as boolean }
        : {}),
    };
    return failure;
  }

  /*
   * --- a retired SKU: rolled back, and retrying will not help -------------
   *
   * Distinct from `insufficient_stock` on purpose. The shortfall message tells
   * a cashier to sell fewer units, which is the wrong instruction here: the
   * shelf may be full and no quantity is sellable. Only an administrator
   * reactivating the SKU changes the answer, so the sale offers "remove the
   * line", not "retry".
   *
   * The key is free again -- the whole transaction rolled back, including the
   * idempotency claim -- so the same key may be reused once the line is gone.
   */
  if (code === "VARIANT_INACTIVE") {
    const failure = base(
      "variant_inactive",
      "این کالا غیرفعال شده است",
      "هیچ کالایی کسر نشد و فروشی ثبت نشد. این کد کالا غیرفعال است و تا زمانی که " +
        "مدیر آن را فعال نکند، فروش آن ممکن نیست. آن را از سبد بردارید و ادامه دهید.",
    );
    failure.code = code;
    failure.messages = messages;
    failure.canRetrySameKey = true;
    failure.stock = {
      ...(readNumber(details, "variantId") !== undefined
        ? { variantId: readNumber(details, "variantId") as number }
        : {}),
      ...(readString(details, "sku") ? { sku: readString(details, "sku") as string } : {}),
      // `retryable: false` from the server. Kept verbatim so the UI can say
      // "retrying changes nothing" rather than guessing from the kind.
      ...(typeof details?.["retryable"] === "boolean"
        ? { retryable: details["retryable"] as boolean }
        : {}),
    };
    return failure;
  }

  /*
   * --- not offered at THIS branch: rolled back, and not a stock problem ----
   *
   * The product exists, the SKU is active, and it may be selling all day in
   * the next shop along -- it is simply not part of this branch's offer. So
   * the copy must not borrow either neighbouring sentence: "موجودی کافی نیست"
   * would send the cashier to count a shelf that is full, and "غیرفعال شده"
   * would be a false statement about a live SKU.
   *
   * Nothing was consumed -- the whole transaction rolled back, idempotency
   * claim included -- so the key is free and `canRetrySameKey` is true: the
   * same key carries the corrected basket once the line is gone. Retrying the
   * SAME basket is pointless, which is what the server's `retryable: false`
   * says, and the panel prints it verbatim rather than guessing.
   */
  if (code === "PRODUCT_NOT_AVAILABLE_IN_BRANCH") {
    const failure = base(
      "not_in_branch",
      "این کالا در شعبهٔ شما عرضه نمی‌شود",
      "هیچ کالایی کسر نشد و فروشی ثبت نشد. این کالا در این شعبه عرضه نمی‌شود و فروش آن " +
        "از این صندوق ممکن نیست. آن را از سبد بردارید و ادامه دهید.",
    );
    failure.code = code;
    failure.messages = messages;
    failure.canRetrySameKey = true;
    failure.stock = {
      ...(readNumber(details, "variantId") !== undefined
        ? { variantId: readNumber(details, "variantId") as number }
        : {}),
      // Codes only. The server sends no quantities with this refusal, and an
      // invented "موجود: ۰" would be a lie about a shelf that may be full.
      ...(readString(details, "productCode")
        ? { productCode: readString(details, "productCode") as string }
        : {}),
      ...(readString(details, "variantCode")
        ? { variantCode: readString(details, "variantCode") as string }
        : {}),
      ...(typeof details?.["retryable"] === "boolean"
        ? { retryable: details["retryable"] as boolean }
        : {}),
    };
    return failure;
  }

  // --- Workstream A's paid-order guard ------------------------------------
  if (code === "ORDER_FULFILMENT_INCOMPLETE") {
    const failure = base(
      "fulfilment_incomplete",
      "این سفارش پرداخت‌شده هنوز تحویل نشده است",
      "پیشبرد وضعیت این سفارش مجاز نیست، چون کالای آن هنوز تخصیص نیافته. " +
        "این کار از صندوق انجام نمی‌شود و به‌صورت خودکار هم تکرار نخواهد شد؛ " +
        "پرونده باید در صف مغایرت‌ها توسط کاربر مجاز بررسی شود.",
    );
    failure.code = code;
    failure.messages = messages;
    failure.canEditAndResubmit = false;
    failure.reconciliation = {
      ...(readNumber(details, "orderId") !== undefined
        ? { orderId: readNumber(details, "orderId") as number }
        : {}),
      ...(readString(details, "status") ? { status: readString(details, "status") as string } : {}),
      ...(readString(details, "fulfillmentState")
        ? { fulfillmentState: readString(details, "fulfillmentState") as string }
        : {}),
      ...(readString(details, "requestedStatus")
        ? { requestedStatus: readString(details, "requestedStatus") as string }
        : {}),
      ...(readString(details, "reconciliationQueue")
        ? { reconciliationQueue: readString(details, "reconciliationQueue") as string }
        : {}),
    };
    return failure;
  }

  if (error.status === 401) {
    const failure = base(
      "unauthorized",
      "نشست شما پایان یافته است",
      "برای ادامه دوباره وارد شوید. سبد فروش تا آن زمان دست‌نخورده می‌ماند.",
    );
    failure.canEditAndResubmit = false;
    failure.messages = messages;
    return failure;
  }

  if (error.status === 403) {
    const failure = base(
      "forbidden",
      "دسترسی لازم را ندارید",
      withServerText("این عملیات برای حساب شما مجاز نیست.", messages),
    );
    failure.canEditAndResubmit = false;
    failure.messages = messages;
    return failure;
  }

  if (error.status === 404) {
    const failure = base(
      "unknown_variant",
      "یکی از کالاها دیگر در دسترس نیست",
      "کالایی که در سبد است روی سرور پیدا نشد. آن سطر را بردارید و دوباره از فهرست کالاها انتخاب کنید.",
    );
    failure.messages = messages;
    return failure;
  }

  if (error.status === 400) {
    // No machine code exists for USER_NOT_IN_BRANCH — the server throws a bare
    // BadRequestException with a sentence — so this match is on the sentence,
    // and only ever as a fallback to the session check we do up front.
    const looksLikeNoBranch = messages.some((message) =>
      message.toLowerCase().includes("branch"),
    );
    const failure = base(
      looksLikeNoBranch ? "no_branch" : "validation",
      looksLikeNoBranch ? "شعبه‌ای به حساب شما اختصاص نیافته" : "اطلاعات فروش پذیرفته نشد",
      looksLikeNoBranch
        ? "ثبت فروش حضوری بدون شعبه ممکن نیست. این تنظیم روی سرور انجام می‌شود؛ " +
          "با مدیر سیستم تماس بگیرید."
        : withServerText("اطلاعات ارسال‌شده پذیرفته نشد.", messages),
    );
    failure.canEditAndResubmit = !looksLikeNoBranch;
    failure.messages = messages;
    if (code) failure.code = code;
    return failure;
  }

  if (error.status === 409) {
    const failure = base(
      "conflict",
      "این عملیات انجام نشد",
      withServerText("وضعیت فعلی سفارش اجازه‌ی این کار را نمی‌دهد.", messages),
    );
    failure.messages = messages;
    if (code) failure.code = code;
    return failure;
  }

  const failure = base(
    "generic",
    error.kind === "server" ? "خطای سرور" : "درخواست انجام نشد",
    error.kind === "server" ? GENERIC_BODY : withServerText(GENERIC_BODY, messages),
  );
  failure.messages = messages;
  if (code) failure.code = code;
  // A 5xx is NOT a refusal: the server may have committed before failing to
  // answer. Treat it exactly like a timeout.
  if (error.kind === "server") {
    failure.outcomeUnknown = true;
    failure.canRetrySameKey = true;
    failure.canEditAndResubmit = false;
  }
  return failure;
}
