/**
 * Money and number formatting for a Persian, RTL, integer-Rial storefront.
 *
 * Every monetary value in the Kazhal API is an **integer Rial**. There are no
 * decimals, no minor units and no currency field — so these helpers refuse to
 * render fractional digits at all, rather than inventing precision the domain
 * does not have.
 *
 * Digit grouping uses `Intl.NumberFormat("fa-IR")`, which produces Persian
 * (Extended Arabic-Indic) digits `۰۱۲۳۴۵۶۷۸۹` grouped with the Persian thousands
 * separator `٬` — not the Latin comma. Pass `digits: "latin"` where Persian
 * digits would be wrong (an input field the user types into, a `<time>` value,
 * an analytics payload).
 */

export type DigitSystem = "persian" | "latin";

const PERSIAN_LOCALE = "fa-IR";
const LATIN_LOCALE = "fa-IR-u-nu-latn";

/** `1234567` → `"۱٬۲۳۴٬۵۶۷"` */
export function formatInteger(value: number, digits: DigitSystem = "persian"): string {
  if (!Number.isFinite(value)) return "";
  return new Intl.NumberFormat(digits === "persian" ? PERSIAN_LOCALE : LATIN_LOCALE, {
    maximumFractionDigits: 0,
    useGrouping: true,
  }).format(Math.trunc(value));
}

export interface MoneyFormatOptions {
  digits?: DigitSystem;
  /** Append the unit. Default `true`. */
  withUnit?: boolean;
  /** Unit label. Default `"ریال"`. */
  unit?: string;
}

/**
 * Format an integer-Rial amount.
 *
 * `formatRial(1250000)` → `"۱٬۲۵۰٬۰۰۰ ریال"`
 * `formatRial(1250000, { withUnit: false })` → `"۱٬۲۵۰٬۰۰۰"`
 */
export function formatRial(value: number, options: MoneyFormatOptions = {}): string {
  const { digits = "persian", withUnit = true, unit = "ریال" } = options;
  const amount = formatInteger(value, digits);
  if (amount === "") return "";
  return withUnit ? `${amount} ${unit}` : amount;
}

/**
 * Rial → Toman for display only (1 Toman = 10 Rial). The API never sends or
 * accepts Toman; convert at the very edge and never round-trip through it.
 * Amounts that are not a whole number of Toman keep their Rial remainder rather
 * than being silently rounded, so this returns `null` for those.
 */
export function rialToToman(rial: number): number | null {
  if (!Number.isFinite(rial)) return null;
  const truncated = Math.trunc(rial);
  return truncated % 10 === 0 ? truncated / 10 : null;
}

/** `formatToman(1250000)` → `"۱۲۵٬۰۰۰ تومان"`, or `null` when not exact. */
export function formatToman(
  rial: number,
  options: Omit<MoneyFormatOptions, "unit"> = {},
): string | null {
  const toman = rialToToman(rial);
  if (toman === null) return null;
  return formatRial(toman, { ...options, unit: "تومان" });
}

/** `formatPercent(0.15)` → `"۱۵٪"` */
export function formatPercent(ratio: number, digits: DigitSystem = "persian"): string {
  if (!Number.isFinite(ratio)) return "";
  return new Intl.NumberFormat(digits === "persian" ? PERSIAN_LOCALE : LATIN_LOCALE, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(ratio);
}

/**
 * A Persian (Jalali) calendar date, via `Intl` — no date library needed.
 * `formatDate("2026-03-21T00:00:00Z")` → `"۱ فروردین ۱۴۰۵"`
 */
export function formatDate(
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions = { year: "numeric", month: "long", day: "numeric" },
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", options).format(date);
}

/** Same, with a 24-hour time appended. */
export function formatDateTime(value: string | number | Date): string {
  return formatDate(value, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Normalize Persian/Arabic-Indic digits typed by a user back to ASCII, so a
 * form value can be parsed. Handles both `۰-۹` (fa) and `٠-٩` (ar).
 */
export function toLatinDigits(input: string): string {
  return input
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[٫٬،٬]/g, "");
}

/**
 * THE API'S BOUND, MIRRORED. Kept in step with `MAX_RIAL` in
 * apps/api/src/common/money/rial.ts, where the arithmetic behind it is worked
 * out in full. In short: a unit price is multiplied by a line quantity and
 * summed across the lines of an order, so the ceiling on ONE price has to be
 * `Number.MAX_SAFE_INTEGER` divided by the largest number of units an order may
 * contain — 200 lines x 1 000 units — not `Number.MAX_SAFE_INTEGER` itself.
 *
 * DUPLICATED RATHER THAN IMPORTED. `packages/ui` must not depend on the NestJS
 * application, so the two constants are derived the same way instead of shared.
 * Both are computed from `Number.MAX_SAFE_INTEGER` and the same two counts, so
 * neither can be edited into a rounder-looking literal without the derivation
 * visibly disagreeing.
 *
 * `Number.MAX_SAFE_INTEGER` is used directly rather than the `2 ** 53 - 1`
 * spelling because both apps compile with `target: ES2017`, where `**` is fine
 * but there is no reason to restate a constant the language already names.
 */
const MAX_ORDER_LINES = 200;
const MAX_LINE_QUANTITY = 1000;
export const MAX_RIAL = Math.floor(
  Number.MAX_SAFE_INTEGER / (MAX_ORDER_LINES * MAX_LINE_QUANTITY),
);

/**
 * Parse a user-typed amount (Persian or Latin digits) into integer Rial.
 *
 * Returns `null` — the same "this is not a number" signal it has always
 * returned for `"abc"` — for a magnitude above {@link MAX_RIAL}, so a price
 * field cannot submit a figure the API will answer with a 400. The value is
 * NOT clamped to the bound: silently substituting 45 035 996 273 for what the
 * admin typed would put a price on the shelf that nobody chose.
 *
 * Note this bounds the MAGNITUDE, so a pasted negative is rejected by the same
 * rule. `parseRial` has always returned negatives and the callers that need a
 * non-negative value already test for one; widening the contract to reject them
 * here would change behaviour those callers do not expect.
 */
export function parseRial(input: string): number | null {
  const cleaned = toLatinDigits(input).replace(/[\s,]/g, "");
  if (cleaned === "" || !/^-?\d+$/.test(cleaned)) return null;
  // `Number.parseInt` on a 30-digit string returns a rounded double rather than
  // failing, so the length is checked BEFORE parsing: 11 digits is already past
  // MAX_RIAL, and anything longer cannot be compared safely once parsed.
  const digits = cleaned.startsWith("-") ? cleaned.slice(1) : cleaned;
  if (digits.replace(/^0+(?=\d)/, "").length > String(MAX_RIAL).length) return null;
  const parsed = Number.parseInt(cleaned, 10);
  if (!Number.isSafeInteger(parsed) || Math.abs(parsed) > MAX_RIAL) return null;
  return parsed;
}


// ===========================================================================
// INTEGER-RIAL STRINGS — the precision-safe half of this module
// ===========================================================================

/*
 * WHY THERE ARE TWO FAMILIES OF HELPER IN ONE FILE.
 *
 * Everything above takes a `number`, which is correct for a catalogue price a
 * human typed: those values are small, they are bounded by what one product
 * costs, and `Intl.NumberFormat` is the right tool for them.
 *
 * Everything below takes a STRING, because the API's aggregate money — every
 * figure on `/admin/dashboard/summary`, `/reports/sales*`, the reconciliation
 * queue and the admin order projections — is a PostgreSQL `bigint` or a
 * `SUM()` over one. node-postgres hands those back as strings precisely so the
 * driver never rounds, and `Number()`-ing them throws that guarantee away at
 * 2^53 − 1 Rial. A year of turnover reaches that range, so the formatter has
 * to group the digits itself and never parse.
 *
 * These used to live in `apps/web/lib/money.ts`, where `apps/store` could not
 * reach them — so the POS reimplemented report formatting on `number` and lost
 * the precision the API had preserved. They are here so there is exactly one
 * implementation for both applications.
 */

const PERSIAN_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"] as const;

/** The Persian thousands separator (U+066C). NOT a Latin comma. */
const PERSIAN_GROUP_SEPARATOR = "٬";

/** The true minus sign (U+2212), not the ASCII hyphen. */
const MINUS_SIGN = "−";

/** A base-10 integer, optionally negative. No decimal point, no exponent. */
const DECIMAL_INTEGER = /^-?\d+$/;

/** Map ASCII digits in a string to Persian (Extended Arabic-Indic) digits. */
export function toPersianDigits(input: string): string {
  return input.replace(/[0-9]/g, (d) => PERSIAN_DIGITS[Number(d)] ?? d);
}

/**
 * Group a non-negative ASCII digit string in threes from the right.
 * `"1234567"` → `"1٬234٬567"`. Length-driven, so it works on a 40-digit
 * string exactly as well as on a 4-digit one.
 */
function groupDigits(digits: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    const fromEnd = digits.length - i;
    out += digits[i];
    if (fromEnd > 1 && (fromEnd - 1) % 3 === 0) out += PERSIAN_GROUP_SEPARATOR;
  }
  return out;
}

export interface RialStringOptions {
  /** Append the unit. Default `true`. */
  withUnit?: boolean;
  /** Unit label. Default `"ریال"`. */
  unit?: string;
  /** Rendered for null/undefined/malformed input. Default `"—"`. */
  fallback?: string;
  /** Persian digits (default) or ASCII, for inputs and machine-read values. */
  digits?: DigitSystem;
}

/**
 * Format an integer-Rial amount that arrived as a STRING, without ever
 * converting it to a `number`.
 *
 * `formatRialString("9007199254740993")` → `"۹٬۰۰۷٬۱۹۹٬۲۵۴٬۷۴۰٬۹۹۳ ریال"` —
 * every digit, including the last one, which `Number("9007199254740993")`
 * silently turns into a 2. There is no rounding, no exponent notation and no
 * `NaN`: anything that is not an optional `-` followed by ASCII digits is
 * returned as the fallback rather than guessed at, because a malformed money
 * figure must look wrong rather than plausible.
 *
 * NEGATIVE VALUES ARE REAL. `netSales` is gross minus refunds minus voids, and
 * a month with more returns than sales is genuinely negative; it is rendered
 * with a true minus sign rather than an ASCII hyphen.
 *
 * NO RIAL/TOMAN CONVERSION HAPPENS HERE. A zero is never appended or removed.
 */
export function formatRialString(
  raw: string | null | undefined,
  options: RialStringOptions = {},
): string {
  const {
    withUnit = true,
    unit = "ریال",
    fallback = "—",
    digits = "persian",
  } = options;
  if (raw === null || raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!DECIMAL_INTEGER.test(trimmed)) return fallback;

  const negative = trimmed.startsWith("-");
  const magnitude = (negative ? trimmed.slice(1) : trimmed).replace(/^0+(?=\d)/, "");
  const grouped = groupDigits(magnitude);
  const localised = digits === "persian" ? toPersianDigits(grouped) : grouped;
  // `-0` is zero. Rendering "−۰" would suggest a loss that did not happen.
  const signed = negative && !/^0+$/.test(magnitude) ? `${MINUS_SIGN}${localised}` : localised;
  return withUnit ? `${signed} ${unit}` : signed;
}

/**
 * Compare two integer-Rial strings WITHOUT parsing them, so the comparator is
 * exact at any magnitude. Returns a negative number, zero, or a positive
 * number, like any `Array.prototype.sort` comparator.
 */
export function compareRialStrings(a: string, b: string): number {
  const clean = (v: string) => v.trim().replace(/^\+/, "");
  const [x, y] = [clean(a), clean(b)];
  if (!DECIMAL_INTEGER.test(x) || !DECIMAL_INTEGER.test(y)) return 0;
  const negX = x.startsWith("-");
  const negY = y.startsWith("-");
  if (negX !== negY) return negX ? -1 : 1;
  const dx = (negX ? x.slice(1) : x).replace(/^0+(?=\d)/, "");
  const dy = (negY ? y.slice(1) : y).replace(/^0+(?=\d)/, "");
  // Same length ⇒ lexicographic order over digits IS numeric order.
  const magnitude = dx.length !== dy.length ? dx.length - dy.length : dx.localeCompare(dy);
  return negX ? -magnitude : magnitude;
}

/** True when an integer-Rial string is exactly zero (`"0"`, `"-0"`, `"000"`). */
export function isZeroRialString(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return false;
  const trimmed = raw.trim();
  return /^-?0+$/.test(trimmed);
}

/**
 * Sum integer-Rial STRINGS exactly, returning a string.
 *
 * Exists because the one place a screen legitimately adds two report figures
 * together — "reversals = voided + refunded" on the POS sales console — was
 * doing it with `+` on values that had just become strings, which concatenates
 * rather than adds. `BigInt` is the only arithmetic in this file.
 */
export function addRialStrings(...values: Array<string | null | undefined>): string | null {
  // `BigInt(0)` rather than the `0n` literal: both apps compile with
  // `target: ES2017`, under which TypeScript refuses BigInt literal syntax
  // (TS2737) while the `BigInt` global itself is available from `lib: esnext`.
  let total = BigInt(0);
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const trimmed = value.trim();
    if (!DECIMAL_INTEGER.test(trimmed)) return null;
    total += BigInt(trimmed);
  }
  return total.toString();
}
