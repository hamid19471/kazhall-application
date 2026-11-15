/**
 * The till's basket, as a pure reducer.
 *
 * Kept free of React and of `fetch` so the rules that matter — picking the same
 * variant twice aggregates, a frozen basket cannot be edited, an unsellable
 * variant never enters the basket — are one readable function rather than
 * scattered `setState` calls.
 *
 * IMPORTANT: nothing here is authoritative. `availableForPos` is a snapshot the
 * server itself labels indicative; `POST /orders/pos` is the only thing that
 * decides whether a sale happens.
 */

import type { CreatePosOrderBody, PosSaleResult } from "@kazhal/api-client";
// Persian digits, so a refusal reads like the rest of the till rather than
// mixing Latin numerals into an RTL sentence.
import { formatInteger } from "@kazhal/ui";

import type { CatalogProduct, CatalogVariant } from "./catalog";

import { isIranianMobile, type PosPaymentMethod } from "./pos-domain";
import type { SaleFailure } from "./sale-failure";

export interface TillLine {
  variantId: number;
  productId: number;
  /** Live catalogue title when picked. The RECEIPT uses the server snapshot. */
  productTitle: string;
  sku: string;
  /**
   * The shop's own codes, as the catalogue reported them.
   *
   * DISTINCT FROM `sku`, which is the warehouse's (often a vendor's) string:
   * «کد محصول» names the product family and «کد گونه» this exact variant. A
   * cashier reading a shelf label or a customer's note quotes one of these, so
   * the basket has to be able to show them.
   *
   * `null` when the catalogue response did not carry one — the POS projection
   * is free to add them without this file changing, and a missing code is
   * simply not rendered rather than invented.
   */
  productCode: string | null;
  variantCode: string | null;
  /**
   * The variant's attributes, by their real axis names. Two lines for the same
   * product differ only by these, so a basket that shows a SKU alone makes the
   * cashier decode which is which while a customer waits.
   */
  attributes: Array<{ id: number; name: string | null; value: string }>;
  unitPrice: number;
  quantity: number;
  /**
   * `product_variants.isActive`, as last reported by the server.
   *
   * A line enters the basket from the POS catalogue, which never lists a
   * retired variant, so `true` is the only possible value at insertion. What
   * changes it is the AVAILABILITY REFRESH: the batch endpoint reports
   * `isActive` for every line, so an administrator retiring a SKU while it
   * sits in an open basket turns this false on the next authoritative read --
   * which a `pos:availability:invalidated` frame triggers within milliseconds.
   *
   * It blocks checkout (`canSubmit`). The SERVER refuses the sale regardless;
   * this is what makes the refusal legible to a cashier before they charge a
   * customer, not the control itself.
   */
  isActive: boolean;
  /** `physicalStock − orderAllocated`. Indicative, refreshed out of band. */
  availableForPos: number | null;
  availabilityAt: string | null;
  /**
   * A `stock:updated` frame arrived for this variant. The frame carries
   * `newStock` = committed PHYSICAL stock, which is NOT the same quantity as
   * `availableForPos` (that one subtracts `orderAllocated`), so we deliberately
   * do NOT paint the frame's number into the basket. We mark the row stale and
   * refetch the authoritative snapshot instead.
   */
  availabilityStale: boolean;
}

/**
 *  - `editing`   normal
 *  - `submitting` a sale request is in flight; every mutation is blocked
 *  - `frozen`    the previous attempt's OUTCOME IS UNKNOWN. The basket is
 *                read-only and the idempotency key must not be renewed until a
 *                human resolves it. This state exists so a timeout can never
 *                turn into a double sale.
 *  - `completed` a sale was recorded; the receipt is showing
 */
export type TillPhase = "editing" | "submitting" | "frozen" | "completed";

export type TillNoticeTone = "success" | "warning" | "danger";

export interface TillNotice {
  tone: TillNoticeTone;
  text: string;
  /** Bumped on every notice so a repeated message still re-announces. */
  seq: number;
}

export interface TillState {
  phase: TillPhase;
  lines: TillLine[];
  paymentMethod: PosPaymentMethod;
  mobile: string;
  name: string;
  failure: SaleFailure | null;
  notice: TillNotice | null;
  sale: PosSaleResult | null;
  /**
   * The exact body sent under the current idempotency key. While `frozen`, a
   * retry MUST resend this byte-for-byte: the same key with a different payload
   * is a 409, by design.
   */
  submittedBody: CreatePosOrderBody | null;
  noticeSeq: number;
}

export const initialTillState: TillState = {
  phase: "editing",
  lines: [],
  paymentMethod: "cash",
  mobile: "",
  name: "",
  failure: null,
  notice: null,
  sale: null,
  submittedBody: null,
  noticeSeq: 0,
};

export type TillAction =
  | { type: "addVariant"; product: CatalogProduct; variant: CatalogVariant }
  | { type: "setQuantity"; variantId: number; quantity: number }
  | { type: "remove"; variantId: number }
  | { type: "clearBasket" }
  | { type: "setPaymentMethod"; value: PosPaymentMethod }
  | { type: "setMobile"; value: string }
  | { type: "setName"; value: string }
  | {
      type: "availability";
      snapshots: Array<{ variantId: number; availableForPos: number; isActive: boolean }>;
      at: string;
    }
  | { type: "markStale"; variantIds: number[] }
  | { type: "submitStart"; body: CreatePosOrderBody }
  | { type: "submitOk"; sale: PosSaleResult }
  | { type: "submitFail"; failure: SaleFailure }
  | { type: "dismissFailure" }
  | { type: "notice"; tone: TillNoticeTone; text: string }
  | { type: "startNewSale" };

/** Mutations are refused unless the basket is genuinely editable. */
function isEditable(state: TillState): boolean {
  return state.phase === "editing";
}

function withNotice(state: TillState, tone: TillNoticeTone, text: string): TillState {
  const seq = state.noticeSeq + 1;
  return { ...state, noticeSeq: seq, notice: { tone, text, seq } };
}

export function tillReducer(state: TillState, action: TillAction): TillState {
  switch (action.type) {
    case "addVariant": {
      if (!isEditable(state)) return state;
      const { product, variant } = action;

      // A variant with no sellable stock never enters the basket. The server
      // would refuse the whole sale anyway, and it is far better to say so
      // while the customer is still choosing than after they have queued.
      if (!variant.inStock) {
        return withNotice(
          state,
          "danger",
          `«${product.title}» با کد ${variant.sku} موجود نیست.`,
        );
      }

      // A variant that carries no price has nothing to charge. Adding it would
      // put a zero on the slip.
      if (variant.price === null) {
        return withNotice(
          state,
          "danger",
          `برای «${product.title}» با کد ${variant.sku} قیمتی ثبت نشده است.`,
        );
      }

      const attributes = variant.attributeValues.map((value) => ({
        id: value.id,
        name: value.attribute?.name ?? null,
        value: value.value,
      }));

      const existing = state.lines.find((line) => line.variantId === variant.id);
      if (existing) {
        // Picking the same variant twice ADDS one, rather than creating a
        // second identical row. Different variants of one product stay
        // separate lines, because they are different things to sell.
        const lines = state.lines.map((line) =>
          line.variantId === variant.id
            ? {
                ...line,
                quantity: line.quantity + 1,
                unitPrice: variant.price ?? line.unitPrice,
                availableForPos: variant.availableForPos,
                availabilityAt: new Date().toISOString(),
                availabilityStale: false,
              }
            : line,
        );
        return withNotice(
          { ...state, lines },
          "success",
          `${product.title} — تعداد ${existing.quantity + 1}`,
        );
      }

      const line: TillLine = {
        variantId: variant.id,
        productId: product.id,
        productTitle: product.title,
        sku: variant.sku,
        productCode: product.productCode ?? null,
        variantCode: variant.variantCode ?? null,
        attributes,
        unitPrice: variant.price,
        quantity: 1,
        isActive: true,
        availableForPos: variant.availableForPos,
        availabilityAt: new Date().toISOString(),
        availabilityStale: false,
      };
      return withNotice(
        { ...state, lines: [...state.lines, line] },
        "success",
        `${product.title} افزوده شد`,
      );
    }

    case "setQuantity": {
      if (!isEditable(state)) return state;
      const quantity = Math.trunc(action.quantity);
      if (!Number.isFinite(quantity) || quantity < 1) {
        return { ...state, lines: state.lines.filter((line) => line.variantId !== action.variantId) };
      }
      return {
        ...state,
        lines: state.lines.map((line) =>
          line.variantId === action.variantId ? { ...line, quantity } : line,
        ),
      };
    }

    case "remove": {
      if (!isEditable(state)) return state;
      return { ...state, lines: state.lines.filter((line) => line.variantId !== action.variantId) };
    }

    case "clearBasket": {
      if (!isEditable(state)) return state;
      return { ...state, lines: [], failure: null, notice: null };
    }

    case "setPaymentMethod":
      if (!isEditable(state)) return state;
      return { ...state, paymentMethod: action.value };

    case "setMobile":
      if (!isEditable(state)) return state;
      return { ...state, mobile: action.value };

    case "setName":
      if (!isEditable(state)) return state;
      return { ...state, name: action.value };

    case "availability": {
      // Allowed in every phase: a frozen basket still shows fresh stock, it
      // just cannot be edited.
      const byId = new Map(action.snapshots.map((s) => [s.variantId, s]));
      return {
        ...state,
        lines: state.lines.map((line) => {
          const snap = byId.get(line.variantId);
          if (snap === undefined) return line;
          return {
            ...line,
            /*
             * SELLABILITY TRAVELS WITH THE NUMBER.
             *
             * This used to copy `availableForPos` only, leaving `isActive`
             * frozen at the `true` every new line is created with — so
             * `canSubmit`'s deactivated-line branch was unreachable and a
             * retired SKU stayed checkout-able in the till until the server
             * refused it. A retired variant can report a positive
             * `availableForPos` (the figure is raw, so the stockroom count
             * stays visible), which is exactly why the flag has to be carried
             * rather than inferred from the quantity.
             */
            isActive: snap.isActive,
            availableForPos: snap.availableForPos,
            availabilityAt: action.at,
            availabilityStale: false,
          };
        }),
      };
    }

    case "markStale": {
      const ids = new Set(action.variantIds);
      if (!state.lines.some((line) => ids.has(line.variantId))) return state;
      return {
        ...state,
        lines: state.lines.map((line) =>
          ids.has(line.variantId) ? { ...line, availabilityStale: true } : line,
        ),
      };
    }

    case "submitStart":
      return { ...state, phase: "submitting", failure: null, submittedBody: action.body };

    case "submitOk":
      return { ...state, phase: "completed", sale: action.sale, failure: null, notice: null };

    case "submitFail":
      return {
        ...state,
        // An unknown outcome freezes the basket. Anything else hands it back.
        phase: action.failure.outcomeUnknown ? "frozen" : "editing",
        failure: action.failure,
      };

    case "dismissFailure":
      return { ...state, failure: null };

    case "notice":
      return withNotice(state, action.tone, action.text);

    /**
     * Start over. The CALLER is responsible for calling `attempt.renew()` in the
     * same breath — this reducer cannot mint keys, and separating the two would
     * make it possible to start a new sale on a spent key.
     */
    case "startNewSale":
      return {
        ...initialTillState,
        paymentMethod: state.paymentMethod,
        noticeSeq: state.noticeSeq,
      };

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export interface TillTotals {
  itemCount: number;
  unitCount: number;
  subtotal: number;
}

export function tillTotals(lines: readonly TillLine[]): TillTotals {
  let unitCount = 0;
  let subtotal = 0;
  for (const line of lines) {
    unitCount += line.quantity;
    subtotal += line.quantity * line.unitPrice;
  }
  return { itemCount: lines.length, unitCount, subtotal };
}

/** A line whose quantity exceeds the last known indicative availability. */
export function shortLines(lines: readonly TillLine[]): TillLine[] {
  return lines.filter(
    (line) => line.availableForPos !== null && line.quantity > line.availableForPos,
  );
}

/**
 * Short lines the till is entitled to REFUSE on, as opposed to merely warn about.
 *
 * The difference is staleness. `availabilityStale` is set the moment a
 * `stock:updated` or `availability:updated` frame names this variant and stays
 * set until the authoritative `GET /inventory/availability` answers, so a line
 * carrying it holds a number we already know is wrong — in an unknown
 * direction. Refusing on that number would block sales the server would have
 * accepted, which is worse than the 409 it replaces.
 *
 * A line with `availableForPos === null` has never been read at all and is
 * likewise not grounds for a refusal.
 */
export function blockingShortLines(lines: readonly TillLine[]): TillLine[] {
  return shortLines(lines).filter((line) => !line.availabilityStale);
}

export type SubmitBlock =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Whether submitting is obviously invalid.
 *
 * Deliberately narrow: it blocks what CANNOT succeed — empty basket, inactive
 * line, bad mobile — plus one availability case, added with care.
 *
 * ## Why availability now blocks, and only sometimes
 *
 * The rule used to be "never block on availability, the sale endpoint is the
 * authority". That is still true of the endpoint, and it is still the reason
 * `POST /orders/pos` re-checks under a row lock and answers 409. But it treated
 * every availability number as equally untrustworthy, and they are not.
 *
 * A number that arrived from `GET /inventory/availability` and has NOT since
 * been contradicted by a realtime frame is the server's own answer, seconds
 * old. Submitting a quantity that exceeds it is not "letting the cashier try" —
 * it is knowingly spending a round trip, an idempotency key and a customer's
 * patience on a refusal we can already predict. The cashier gets a Persian
 * sentence naming the SKU and the number instead.
 *
 * A number that a frame HAS contradicted is excluded (see
 * {@link blockingShortLines}): it is known-wrong in an unknown direction, and
 * refusing on it would block sales the server would have accepted. So would
 * refusing on a variant never read at all. In both of those cases the cashier
 * must still be able to try, and the server still decides.
 *
 * This closes the predictable half of the race. The unpredictable half — a till
 * elsewhere selling the same units in the milliseconds between this check and
 * the request landing — is unchanged and still ends in a 409.
 */
export function canSubmit(state: TillState, hasBranch: boolean): SubmitBlock {
  if (!hasBranch) {
    return { ok: false, reason: "حساب شما به هیچ شعبه‌ای متصل نیست؛ ثبت فروش حضوری ممکن نیست." };
  }
  if (state.phase !== "editing") {
    return { ok: false, reason: "سبد در حال حاضر قابل ثبت نیست." };
  }
  // The key is bound to a completed sale that is not this basket. Resubmitting
  // would only earn a second 409; the correct move is to check what was
  // recorded and then deliberately start a new attempt on a fresh key.
  if (state.failure?.keyIsSpent) {
    return {
      ok: false,
      reason: "کلید این فروش مصرف شده است. ابتدا فروش قبلی را بررسی و سپس «شروع فروش جدید» را بزنید.",
    };
  }
  if (state.lines.length === 0) {
    return { ok: false, reason: "سبد خالی است. از فهرست کالاها یک کالا انتخاب کنید." };
  }
  const inactive = state.lines.find((line) => !line.isActive);
  if (inactive) {
    return { ok: false, reason: `کالای ${inactive.sku} غیرفعال است؛ آن را از سبد بردارید.` };
  }
  const badQuantity = state.lines.find(
    (line) => !Number.isInteger(line.quantity) || line.quantity < 1,
  );
  if (badQuantity) {
    return { ok: false, reason: `تعداد کالای ${badQuantity.sku} معتبر نیست.` };
  }
  const [short] = blockingShortLines(state.lines);
  if (short) {
    const available = short.availableForPos ?? 0;
    return {
      ok: false,
      reason:
        available === 0
          ? `کالای ${short.sku} دیگر موجود نیست؛ آن را از سبد بردارید.`
          : `از کالای ${short.sku} فقط ${formatInteger(available)} عدد قابل فروش است؛ تعداد را اصلاح کنید.`,
    };
  }
  const mobile = state.mobile.trim();
  if (mobile !== "" && !isIranianMobile(mobile)) {
    return { ok: false, reason: "شماره موبایل معتبر نیست. نمونه‌ی درست: ۰۹۱۲۳۴۵۶۷۸۹" };
  }
  return { ok: true };
}

/**
 * Build the request body.
 *
 * `cashierId` and `branchId` are NEVER sent. The server documents them as
 * ignored, but a POS that transmits them at all invites someone to make them
 * editable later. Attribution is token-only.
 *
 * `name` travels only with a `mobile`, because the server stores it only then.
 */
export function buildSaleBody(state: TillState): CreatePosOrderBody {
  const mobile = state.mobile.trim();
  const name = state.name.trim();
  return {
    paymentMethod: state.paymentMethod,
    items: state.lines.map((line) => ({
      productVariantId: line.variantId,
      quantity: line.quantity,
    })),
    ...(mobile !== "" ? { mobile } : {}),
    ...(mobile !== "" && name !== "" ? { name } : {}),
  };
}
