/**
 * ===========================================================================
 * PURCHASE-COST ARITHMETIC FOR THE ADMIN CONSOLE — pure, BigInt only
 * ===========================================================================
 *
 * The contract is apps/api/docs/PURCHASE-COST-ACCOUNTING.md. The server is the
 * only place cost is DECIDED; everything here exists so a form can show the
 * operator what will happen BEFORE they confirm it, using the same rounding
 * rules the server applies (§3.1 allocation, §9 percentages):
 *
 *  - Money never passes through a JavaScript `number`. A pool value is
 *    `MAX_STOCK_UNITS × MAX_RIAL ≈ 4.8 × 10¹⁹`, far past 2^53, so every figure
 *    here is a `bigint` and every figure that leaves is a base-10 string.
 *  - `BigInt(0)`, never the `0n` literal: the app compiles with
 *    `target: ES2017`, where TypeScript refuses BigInt literal syntax (TS2737).
 *  - MISSING IS NOT ZERO. An empty box is `{ kind: "empty" }`; a typed `0` is
 *    a real, explicit cost. Nothing in this module turns one into the other.
 *
 * No imports: this file is loaded directly by `node --test`.
 */

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const HUNDRED = BigInt(100);
const TEN_THOUSAND = BigInt(10000);

/**
 * The API's per-unit ceiling, derived exactly as `MAX_RIAL` is in
 * `apps/api/src/common/money/rial.ts` and `packages/ui` (MAX_SAFE_INTEGER /
 * (200 lines × 1000 units)). Integer division of BigInts is a floor.
 */
export const MAX_RIAL_BIGINT = BigInt(Number.MAX_SAFE_INTEGER) / BigInt(200 * 1000);

/** `floor((2^31 − 1) / 2)` — the API's MAX_STOCK_UNITS. Safe as a number. */
export const MAX_STOCK_UNITS = Math.floor((2 ** 31 - 1) / 2);

/** PostgreSQL `bigint` ceiling; a pool value above it is PURCHASE_COST_OUT_OF_RANGE. */
export const INT8_MAX = BigInt("9223372036854775807");

// ---------------------------------------------------------------------------
// Parsing what a person typed
// ---------------------------------------------------------------------------

export type ParseFailure = "not_integer" | "fraction" | "negative" | "too_large";

export type ParsedAmount =
  | { kind: "empty" }
  | { kind: "invalid"; reason: ParseFailure }
  | { kind: "value"; value: bigint };

/** Persian (U+06F0..) and Arabic-Indic (U+0660..) digits → ASCII. */
function foldDigits(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    if (code >= 0x06f0 && code <= 0x06f9) out += String(code - 0x06f0);
    else if (code >= 0x0660 && code <= 0x0669) out += String(code - 0x0660);
    else out += ch;
  }
  return out;
}

/**
 * Normalise a typed amount: fold digits and strip the grouping a person pastes
 * from a spreadsheet (ASCII comma, Persian thousands separator U+066C, Arabic
 * comma U+060C, whitespace). A DECIMAL separator (`.` or U+066B) is NOT
 * stripped — `packages/ui`'s `toLatinDigits` drops U+066B, which would read
 * «۱۲٫۵» as 125; here it is a refusal.
 */
function normalise(raw: string): string {
  return foldDigits(raw).replace(/[\s,٬،‌‏‎]/g, "");
}

/**
 * A Rial amount from an input box.
 *
 * `max` defaults to the API's MAX_RIAL. `allowNegative` is for signed inputs
 * only; money inputs in this feature are never negative.
 */
export function parseRialInput(
  raw: string,
  options: { max?: bigint; allowNegative?: boolean } = {},
): ParsedAmount {
  const max = options.max ?? MAX_RIAL_BIGINT;
  const cleaned = normalise(raw);
  if (cleaned === "") return { kind: "empty" };
  if (/^[-+]?\d*[.٫]\d*$/.test(cleaned) && /\d/.test(cleaned)) {
    return { kind: "invalid", reason: "fraction" };
  }
  if (!/^[-+]?\d+$/.test(cleaned)) return { kind: "invalid", reason: "not_integer" };
  const value = BigInt(cleaned.replace(/^\+/, ""));
  if (value < ZERO && !options.allowNegative) return { kind: "invalid", reason: "negative" };
  if ((value < ZERO ? -value : value) > max) return { kind: "invalid", reason: "too_large" };
  return { kind: "value", value };
}

export type ParsedQuantity =
  | { kind: "empty" }
  | { kind: "invalid"; reason: ParseFailure | "zero" }
  | { kind: "value"; value: number };

/**
 * A unit count. Bounded by MAX_STOCK_UNITS, so the result is a safe `number`.
 * `allowZero` defaults to true; `allowNegative` to false.
 */
export function parseQuantityInput(
  raw: string,
  options: { allowNegative?: boolean; allowZero?: boolean } = {},
): ParsedQuantity {
  const parsed = parseRialInput(raw, {
    max: BigInt(MAX_STOCK_UNITS),
    ...(options.allowNegative ? { allowNegative: true } : {}),
  });
  if (parsed.kind !== "value") return parsed;
  if (parsed.value === ZERO && options.allowZero === false) return { kind: "invalid", reason: "zero" };
  return { kind: "value", value: Number(parsed.value) };
}

/** The Persian sentence for a refused amount. */
export function amountProblem(reason: ParseFailure | "zero", what = "مبلغ"): string {
  switch (reason) {
    case "fraction":
      return `${what} باید عدد صحیح ریال باشد؛ اعشار پذیرفته نمی‌شود.`;
    case "negative":
      return `${what} نمی‌تواند منفی باشد.`;
    case "too_large":
      return `${what} از سقف مجاز بیشتر است.`;
    case "zero":
      return `${what} نمی‌تواند صفر باشد.`;
    default:
      return `${what} را فقط با رقم بنویسید.`;
  }
}

/** An API money string → bigint, or null when absent / malformed. */
export function rialOf(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  return BigInt(trimmed);
}

// ---------------------------------------------------------------------------
// Profit and margin
// ---------------------------------------------------------------------------

/** Selling price − purchase price. Negative is real (selling at a loss). */
export function grossProfitPerUnit(sell: bigint, cost: bigint): bigint {
  return sell - cost;
}

/**
 * `profit / revenue × 100` as a two-decimal string, rounded HALF AWAY FROM
 * ZERO, computed entirely in BigInt — the rule §9 states for the server.
 * `null` when revenue ≤ 0: never Infinity, NaN or an invented 0.
 */
export function marginPercent(profit: bigint, revenue: bigint): string | null {
  if (revenue <= ZERO) return null;
  const scaled = profit * TEN_THOUSAND; // hundredths of a percent × revenue
  const negative = scaled < ZERO;
  const magnitude = negative ? -scaled : scaled;
  let quotient = magnitude / revenue;
  const remainder = magnitude % revenue;
  if (remainder * TWO >= revenue) quotient += ONE;
  const whole = quotient / HUNDRED;
  const fraction = (quotient % HUNDRED).toString().padStart(2, "0");
  const sign = negative && quotient !== ZERO ? "-" : "";
  return `${sign}${whole.toString()}.${fraction}`;
}

/**
 * A two-decimal percentage string (from the API or {@link marginPercent}) in
 * Persian digits with the Persian decimal separator, or "—" for null.
 */
export function formatPercentString(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return "—";
  const negative = trimmed.startsWith("-") && !/^-?0+(\.0+)?$/.test(trimmed);
  const body = trimmed.replace(/^-/, "").replace(".", "٫");
  const persian = foldToPersian(body);
  return `${negative ? "−" : ""}${persian}٪`;
}

function foldToPersian(input: string): string {
  const digits = "۰۱۲۳۴۵۶۷۸۹";
  return input.replace(/[0-9]/g, (d) => digits[Number(d)] ?? d);
}

// ---------------------------------------------------------------------------
// The valuation pool (docs §3)
// ---------------------------------------------------------------------------

export interface PoolInput {
  stock: number;
  unvaluedQuantity: number;
  /** The API sends a string; a bigint is accepted for tests and chaining. */
  inventoryCostValue: string | bigint;
}

function poolValue(pool: PoolInput): bigint {
  if (typeof pool.inventoryCostValue === "bigint") return pool.inventoryCostValue;
  return rialOf(pool.inventoryCostValue) ?? ZERO;
}

/** `floor(value / units)`, or null when there are no valued units. */
export function averageUnitCost(value: bigint, valuedUnits: number): bigint | null {
  if (valuedUnits <= 0) return null;
  return value / BigInt(valuedUnits);
}

/**
 * The single rounding rule (§3.1): the whole remainder when taking every unit,
 * otherwise `floor(value × take / units)`.
 */
export function allocate(value: bigint, units: number, take: number): bigint {
  if (take <= 0 || units <= 0) return ZERO;
  if (take >= units) return value;
  return (value * BigInt(take)) / BigInt(units);
}

export interface ReceiptPreview {
  oldValue: bigint;
  incomingValue: bigint;
  newValue: bigint;
  newStock: number;
  newValuedQuantity: number;
  /** `floor(newValue / newValuedQuantity)`; null when nothing is valued. */
  newAverage: bigint | null;
  /** The result would not fit a PostgreSQL bigint — the server will refuse it. */
  outOfRange: boolean;
}

/** «ثبت ورود کالا»: `stock += q`, `value += q × c`. */
export function receiptPreview(pool: PoolInput, quantity: number, unitCost: bigint): ReceiptPreview {
  const oldValue = poolValue(pool);
  const incomingValue = BigInt(quantity) * unitCost;
  const newValue = oldValue + incomingValue;
  const newValuedQuantity = pool.stock - pool.unvaluedQuantity + quantity;
  return {
    oldValue,
    incomingValue,
    newValue,
    newStock: pool.stock + quantity,
    newValuedQuantity,
    newAverage: averageUnitCost(newValue, newValuedQuantity),
    outOfRange: newValue > INT8_MAX,
  };
}

export type ValuationInput =
  | { mode: "unitCost"; unitCost: bigint }
  | { mode: "totalValue"; totalValue: bigint };

export interface ValuationPreview {
  /** The units that become valued: every currently unvalued unit. */
  valuedUnits: number;
  addedValue: bigint;
  oldValue: bigint;
  newValue: bigint;
  /** Over the whole stock, which is entirely valued afterwards. */
  newAverage: bigint | null;
  outOfRange: boolean;
}

/** «ارزش‌گذاری موجودی قبلی»: `value += v`, `unvalued = 0`. */
export function valuationPreview(pool: PoolInput, input: ValuationInput): ValuationPreview {
  const oldValue = poolValue(pool);
  const valuedUnits = pool.unvaluedQuantity;
  const addedValue =
    input.mode === "unitCost" ? BigInt(valuedUnits) * input.unitCost : input.totalValue;
  const newValue = oldValue + addedValue;
  return {
    valuedUnits,
    addedValue,
    oldValue,
    newValue,
    newAverage: averageUnitCost(newValue, pool.stock),
    outOfRange: newValue > INT8_MAX,
  };
}

export interface RemovalPreview {
  /** Units of unknown cost that leave first (§3.2). */
  unknownQuantity: number;
  knownQuantity: number;
  /** Proportional cost removed — reported as inventory LOSS, never COGS. */
  costRemoved: bigint;
  newValue: bigint;
  newStock: number;
  newUnvalued: number;
  newAverage: bigint | null;
}

/** A negative correction: the same `consume` allocation a sale uses. */
export function removalPreview(pool: PoolInput, quantity: number): RemovalPreview {
  const value = poolValue(pool);
  const take = Math.min(quantity, pool.stock);
  const unknownQuantity = Math.min(take, pool.unvaluedQuantity);
  const knownQuantity = take - unknownQuantity;
  const valued = pool.stock - pool.unvaluedQuantity;
  const costRemoved = allocate(value, valued, knownQuantity);
  const newValue = value - costRemoved;
  return {
    unknownQuantity,
    knownQuantity,
    costRemoved,
    newValue,
    newStock: pool.stock - take,
    newUnvalued: pool.unvaluedQuantity - unknownQuantity,
    newAverage: averageUnitCost(newValue, valued - knownQuantity),
  };
}

/** A positive correction with its cost explicitly unknown: units arrive unvalued. */
export function unvaluedIncreasePreview(pool: PoolInput, quantity: number) {
  const value = poolValue(pool);
  return {
    newStock: pool.stock + quantity,
    newUnvalued: pool.unvaluedQuantity + quantity,
    newValue: value,
    newAverage: averageUnitCost(value, pool.stock - pool.unvaluedQuantity),
  };
}
