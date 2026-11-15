/**
 * ===========================================================================
 * INTEGER RIAL, AS A BASE-10 STRING — the one money representation crossing
 * the API boundary.
 * ===========================================================================
 *
 * THE UNIT. Every money column in this schema stores INTEGER RIAL. There is no
 * minor unit, no scaling factor and no Toman anywhere in the database. A
 * display that wants Toman divides by ten AT THE POINT OF DISPLAY; nothing in
 * this file, in the API, or in the database ever appends or removes a zero to
 * convert between the two. Doing so is how a 1 000 000 Rial sale becomes a
 * 10 000 000 Rial sale exactly once and is never noticed again.
 *
 * WHY A STRING AND NOT A NUMBER. Every money column is PostgreSQL `bigint`,
 * and so is every `SUM()` over one: PostgreSQL widens `sum(bigint)` to
 * `numeric`, and node-postgres hands both back as STRINGS precisely so that the
 * driver never has to decide what to round. Converting that string with
 * `Number()` is safe only up to 2^53 − 1 = 9 007 199 254 740 991 Rial, and a
 * single year of turnover at Iranian Rial prices is already in the 10^12–10^13
 * range. The margin is one or two orders of magnitude, it shrinks with
 * inflation, and when it runs out nothing fails loudly — `grossSales` simply
 * starts coming back wrong in the last few digits, and `netSales`, computed as
 * a floating-point subtraction of two such numbers, comes back wrong sooner
 * than either operand does.
 *
 *   > 9007199254740993 - 1
 *   9007199254740992          // off by one, silently
 *
 * `BigInt` has no margin to reason about, so arithmetic here is `BigInt`
 * arithmetic and the value that leaves is `BigInt.prototype.toString()` —
 * base 10, no separators, no exponent, no locale.
 *
 * THE RULES THIS MODULE EXISTS TO ENFORCE, in one place so that no caller has
 * to remember them:
 *
 *   1. `Number()` and `parseInt()` are never applied to money.
 *   2. `+`, `-` and `*` on money are `BigInt` operations, never `number` ones.
 *   3. What is serialised is always a base-10 string of an integer.
 *   4. A malformed value is an error at the boundary, not a `NaN` in a report.
 *
 * COUNTS ARE NOT MONEY. `salesCount`, `unitsSold` and friends stay `number`.
 * They are bounded by the number of rows and line quantities in the database —
 * a range whose smallness is explicit — and turning them into strings would
 * make every consumer parse a value that was never at risk.
 */

/**
 * A base-10 decimal integer, optionally negative. No `+`, no leading zeros
 * beyond a bare `0`, no decimal point, no exponent, no whitespace.
 *
 * Leading zeros are rejected rather than trimmed because they are never
 * produced by `BigInt.prototype.toString()` or by PostgreSQL, so one appearing
 * means the value came from somewhere this module does not know about.
 */
const DECIMAL_INTEGER = /^-?(0|[1-9][0-9]*)$/;

/**
 * Integer Rial, serialised. A nominal alias rather than a branded type: the
 * point is to make the contract legible in every signature and response
 * interface, not to force casts on the many places that already hold a correct
 * string from PostgreSQL.
 */
export type RialString = string;

/**
 * `0`, spelled once. Used as the zero of every fold below so that an empty
 * result set produces `'0'` rather than `''` or `'NaN'`.
 */
export const ZERO_RIAL: RialString = '0';

/**
 * Normalises whatever PostgreSQL, a fixture or a DTO produced into the
 * canonical base-10 integer string.
 *
 * ACCEPTS:
 *   - `string`  — `bigint`/`numeric` from node-postgres, already exact.
 *   - `bigint`  — arithmetic performed by this module.
 *   - `number`  — ONLY a safe integer, and only as a convenience for the
 *                 places that still hold a `number` from the entity layer's
 *                 `bigIntTransformer`. A non-integer or an unsafe integer
 *                 throws, because silently accepting `1e21` or `1.5` is the
 *                 precise failure this module exists to prevent.
 *   - `null` / `undefined` — treated as absent and folded to `'0'`, which is
 *                 what `COALESCE(SUM(...), 0)` already guarantees in SQL and
 *                 what an aggregate over no rows means.
 *
 * REJECTS everything else, loudly. A report that cannot state a total exactly
 * must fail rather than print a plausible wrong number.
 */
export function toRial(
  value: string | number | bigint | null | undefined,
): RialString {
  if (value === null || value === undefined) return ZERO_RIAL;

  if (typeof value === 'bigint') return value.toString();

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(
        `toRial: ${String(value)} is not a safe integer. Money must not reach ` +
          `this module as a JavaScript number unless it is exactly representable; ` +
          `pass the database string instead.`,
      );
    }
    // `Number.prototype.toString()` on a safe integer is exact and never
    // produces exponent notation, so this cannot introduce `1e+21`.
    return value.toString();
  }

  const trimmed = value.trim();
  if (!DECIMAL_INTEGER.test(trimmed)) {
    throw new TypeError(
      `toRial: ${JSON.stringify(value)} is not a base-10 integer. Money crosses ` +
        `this boundary as an exact decimal integer string; a decimal point, an ` +
        `exponent or an empty value means the producer rounded already.`,
    );
  }
  // `-0` is the one value the pattern admits that `BigInt` normalises; going
  // through `BigInt` makes the output canonical for every input.
  return BigInt(trimmed).toString();
}

/** The same normalisation, as a `bigint`, for callers that go on to compute. */
export function toRialBigInt(
  value: string | number | bigint | null | undefined,
): bigint {
  return BigInt(toRial(value));
}

/**
 * `base - d1 - d2 - …`, exactly.
 *
 * This is `netSales`: gross minus refunds minus voids. It is the single
 * operation in the reporting layer that used to be a floating-point
 * subtraction, and it is the one that loses precision FIRST — two operands can
 * each be exactly representable while their difference is not.
 */
export function subtractRial(
  base: string | number | bigint | null | undefined,
  ...deductions: Array<string | number | bigint | null | undefined>
): RialString {
  let result = toRialBigInt(base);
  for (const deduction of deductions) result -= toRialBigInt(deduction);
  return result.toString();
}

/** `a + b + …`, exactly. */
export function sumRial(
  ...values: Array<string | number | bigint | null | undefined>
): RialString {
  let result = 0n;
  for (const value of values) result += toRialBigInt(value);
  return result.toString();
}

/**
 * A bounded, non-money integer: row counts, line quantities, page numbers.
 *
 * Kept here beside {@link toRial} so that the distinction is stated in one
 * place rather than implied by whichever helper a call site happened to reach
 * for. It still refuses an unsafe value, because a count that large means the
 * query was wrong, not that the number needs widening.
 */
export function toCount(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new TypeError(
      `toCount: ${String(value)} is not a safe integer count. Counts are bounded ` +
        `by the number of rows in the database; a value this large is a broken query.`,
    );
  }
  return n;
}

// ===========================================================================
// SAFE-INTEGER BOUNDARIES FOR THE WRITE PATHS
// ===========================================================================

/*
 * WHY A PER-FIELD BOUND OF `Number.MAX_SAFE_INTEGER` IS NOT ENOUGH.
 *
 * Everything above this line protects money on the way OUT: a `bigint` column
 * or a `SUM()` over one arrives as a string and is never `Number()`-ed. None of
 * it protects money on the way IN. A price enters as a JSON number, is written
 * to a `bigint` column, and is then MULTIPLIED by a quantity and SUMMED across
 * the lines of an order — in JavaScript, in `OrdersService` — before anything
 * turns back into a string:
 *
 *     const lineTotal = unitPrice * item.quantity;   // orders.service.ts
 *     subtotal += lineTotal;
 *
 * So the failure this section prevents is NOT "a price larger than 2^53 − 1 was
 * stored". It is "every individual price was safely representable and the
 * ORDER TOTAL computed from them was not" — at which point `subtotal` is a
 * rounded double, it is written to `orders.total_price`, `payment.amount` is
 * derived from it, and the gateway is asked for a figure that differs from the
 * one on the receipt by a few hundred Rial that nobody can account for. Nothing
 * throws; the books are simply wrong.
 *
 * THE ARITHMETIC, EXPLICITLY.
 *
 * A JavaScript integer is exact up to
 *
 *     Number.MAX_SAFE_INTEGER = 2^53 − 1 = 9 007 199 254 740 991
 *
 * The worst order this API will accept is MAX_ORDER_LINES lines, each of
 * MAX_LINE_QUANTITY units, each unit priced at MAX_RIAL. Its subtotal is
 *
 *     MAX_ORDER_LINES × MAX_LINE_QUANTITY × MAX_RIAL
 *
 * and that product — not MAX_RIAL on its own — is what has to stay inside the
 * safe range. Fixing the two count bounds first and solving for the price:
 *
 *     MAX_ORDER_LINES    =        200          (@ArrayMaxSize on POS items)
 *     MAX_LINE_QUANTITY  =      1 000          (@Max on every quantity field)
 *     ------------------------------------------------------------------
 *     units per order    =    200 000
 *     MAX_RIAL           = ⌊(2^53 − 1) / 200 000⌋ = 45 035 996 273
 *
 * Checking it back:
 *
 *     45 035 996 273 × 200 000 = 9 007 199 254 600 000
 *                              ≤ 9 007 199 254 740 991  ✓ (140 991 to spare)
 *
 * 45 035 996 273 Rial is 4 503 599 627 Toman per SINGLE UNIT — four orders of
 * magnitude above the most expensive thing this catalogue has ever listed, so
 * the bound costs nothing real while making the overflow unreachable.
 *
 * THE TWO COUNTS ARE CHOSEN, NOT DERIVED, AND THAT IS THE POINT. There is no
 * natural ceiling on "how many lines may a sale have"; there is only a number
 * beyond which a request is a mistake or an attack. 200 lines and 1 000 units
 * are both an order of magnitude past any real till receipt, and fixing them
 * here is what lets MAX_RIAL be computed rather than guessed. Raising either
 * one LOWERS MAX_RIAL — they are three faces of one constraint and must move
 * together, which is why they live in one place.
 */

/**
 * Maximum DISTINCT LINES on one order (`@ArrayMaxSize` on `CreatePosOrderDto.
 * items`). POS lines are aggregated by variant before pricing, so this bounds
 * distinct variants, not scans.
 */
export const MAX_ORDER_LINES = 200;

/** Maximum units on ONE line (`@Max` on every `quantity` field). */
export const MAX_LINE_QUANTITY = 1_000;

/**
 * The ceiling on any SINGLE-UNIT money figure that enters over HTTP:
 * `basePrice`, a variant `price`, a `minPrice`/`maxPrice` filter.
 *
 * Derived, never written as a literal, so that changing either count bound
 * above cannot leave a stale number here that silently reopens the overflow.
 */
export const MAX_RIAL = Math.floor(
  Number.MAX_SAFE_INTEGER / (MAX_ORDER_LINES * MAX_LINE_QUANTITY),
);

/**
 * The ceiling on an AGGREGATE money figure — an order subtotal, a payment, a
 * refund amount. Exactly the worst-case order above, so by construction it is
 * the largest total this API can legitimately produce AND it is still exactly
 * representable as a `number`.
 *
 * It is deliberately NOT `Number.MAX_SAFE_INTEGER`: a value between the two
 * would be representable but could not have arisen from any accepted order, so
 * accepting it would mean accepting a figure the system cannot explain.
 */
export const MAX_ORDER_RIAL = MAX_RIAL * MAX_ORDER_LINES * MAX_LINE_QUANTITY;

/**
 * The ceiling on a STOCK figure — `stock` on a variant, `value` on a stock
 * adjustment.
 *
 * Not money, so it is bounded by its own storage rather than by MAX_RIAL:
 * `product_variants.stock` and `stock_movements.quantity` are PostgreSQL
 * `integer` (int4, ±2 147 483 647). HALF that ceiling, because a `delta`
 * adjustment is applied as `stock = stock + value` INSIDE PostgreSQL — two
 * values that each fit int4 can overflow when added, and an int4 overflow
 * there is a 500 from the driver rather than a 400 anyone can act on.
 */
export const MAX_STOCK_UNITS = Math.floor((2 ** 31 - 1) / 2);

/**
 * `unitPrice × quantity`, refusing to return a rounded product.
 *
 * The multiplication is done in `BigInt` and only then narrowed, so the check
 * is on the TRUE product rather than on the double that `*` already lost. The
 * DTO bounds make this unreachable for anything that came in over HTTP today;
 * it fires for a price that was already in the database before those bounds
 * existed, which is exactly the case a validator cannot cover.
 */
export function lineTotalRial(unitPrice: number, quantity: number): number {
  if (!Number.isSafeInteger(unitPrice) || !Number.isSafeInteger(quantity)) {
    throw new TypeError(
      `lineTotalRial: ${String(unitPrice)} x ${String(quantity)} is not a pair ` +
        `of safe integers. A line total is INTEGER RIAL times a unit count; ` +
        `neither operand may already have been rounded.`,
    );
  }
  const exact = BigInt(unitPrice) * BigInt(quantity);
  if (
    exact > BigInt(Number.MAX_SAFE_INTEGER) ||
    exact < -BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new RangeError(
      `lineTotalRial: ${unitPrice} x ${quantity} = ${exact.toString()} exceeds ` +
        `Number.MAX_SAFE_INTEGER. Returning it would round the line total, and ` +
        `the rounded figure is what would be charged.`,
    );
  }
  return Number(exact);
}

/**
 * `Σ lineTotals`, refusing to return a rounded sum.
 *
 * Folded in `BigInt` rather than with `+=` on doubles: two line totals can each
 * be exactly representable while their sum is not, and that is the first place
 * precision is lost, not the last.
 */
export function sumLineTotalsRial(lineTotals: readonly number[]): number {
  let exact = 0n;
  for (const total of lineTotals) {
    if (!Number.isSafeInteger(total)) {
      throw new TypeError(
        `sumLineTotalsRial: line total ${String(total)} is not a safe integer.`,
      );
    }
    exact += BigInt(total);
  }
  if (
    exact > BigInt(Number.MAX_SAFE_INTEGER) ||
    exact < -BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new RangeError(
      `sumLineTotalsRial: subtotal ${exact.toString()} exceeds ` +
        `Number.MAX_SAFE_INTEGER. An order whose total cannot be stated exactly ` +
        `must not be placed; ${MAX_ORDER_RIAL} is the largest total the DTO ` +
        `bounds can produce.`,
    );
  }
  return Number(exact);
}
