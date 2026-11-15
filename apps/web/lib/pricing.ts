/**
 * Pure helpers for the monthly pricing screens (docs/MONTHLY-PRICING.md).
 *
 * No React, no Next, no `@/` imports — `node --test` loads this file directly.
 * Money never passes through `number`: amounts are parsed by `parseRialInput`
 * (lib/costing.ts) into BigInt and sent as base-10 strings, and percentages are
 * sent as TEXT the server parses digit by digit.
 */
import { isoDayToPersian, todayIsoDay } from "../../../packages/ui/src/date/persian-date.ts";

const PERSIAN_DIGIT = /[۰-۹]/g;
const ARABIC_DIGIT = /[٠-٩]/g;

function latin(text: string): string {
  return text
    .replace(PERSIAN_DIGIT, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(ARABIC_DIGIT, (d) => String(d.charCodeAt(0) - 0x0660));
}

export type PercentInput =
  | { kind: "empty" }
  | { kind: "invalid" }
  | { kind: "value"; text: string };

/**
 * A typed percent → the canonical text the API accepts ("10", "12.5").
 * Accepts Persian and Arabic-Indic digits, `٫` or `.` as the decimal mark and
 * a trailing `٪`/`%`; refuses more than two decimals and anything ≥ `max`.
 */
export function parsePercentInput(raw: string, max = 100): PercentInput {
  const cleaned = latin(raw).replace(/[\s٪%]/g, "").replace(/٫/g, ".");
  if (cleaned === "") return { kind: "empty" };
  const match = /^(\d{1,5})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return { kind: "invalid" };
  const whole = Number(match[1]);
  const frac = match[2] ?? "";
  const hundredths = whole * 100 + Number(frac.padEnd(2, "0"));
  if (hundredths >= max * 100) return { kind: "invalid" };
  const significant = frac.replace(/0+$/, "");
  return { kind: "value", text: significant === "" ? String(whole) : `${whole}.${significant}` };
}

export const PERSIAN_MONTHS = [
  "فروردین",
  "اردیبهشت",
  "خرداد",
  "تیر",
  "مرداد",
  "شهریور",
  "مهر",
  "آبان",
  "آذر",
  "دی",
  "بهمن",
  "اسفند",
] as const;

/** Latin digits → Persian digits, for display. */
export function persianDigits(value: number | string): string {
  return String(value).replace(/[0-9]/g, (d) => String.fromCharCode(0x06f0 + Number(d)));
}

/** `(1405, 7)` → "مهر ۱۴۰۵". */
export function planMonthLabel(year: number, month: number): string {
  const name = PERSIAN_MONTHS[month - 1] ?? String(month);
  return `${name} ${persianDigits(year)}`;
}

/** The current Persian year and month, in Tehran — never the browser's zone. */
export function currentPersianMonth(): { year: number; month: number } {
  const today = isoDayToPersian(todayIsoDay());
  return today ? { year: today.year, month: today.month } : { year: 1405, month: 1 };
}

/** The effective-month field as `YYYY-MM` for a URL or a form value. */
export function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** `YYYY-MM` back to parts, or null. Persian calendar years only (1300–1700). */
export function parseMonthKey(raw: string | undefined): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(raw ?? "");
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1300 || year > 1700 || month < 1 || month > 12) return null;
  return { year, month };
}

/**
 * The share split of a price at the plan's rates, for the explanation panel:
 * how much of each Rial goes to operating cost, tax, profit and purchase cost.
 * Percent strings in, percent strings out; `null` when unusable.
 */
export function shareExample(
  operatingCostRatePercent: string | null,
  taxRatePercent: string | null,
  profitPercent: string | null,
): { purchasePercent: string } | null {
  if (operatingCostRatePercent === null || taxRatePercent === null || profitPercent === null) return null;
  const hundredths = (text: string) => {
    const [whole, frac = ""] = text.replace(/^-/, "").split(".");
    const value = Number(whole) * 100 + Number(frac.padEnd(2, "0").slice(0, 2));
    return text.startsWith("-") ? -value : value;
  };
  const rest = 10_000 - hundredths(operatingCostRatePercent) - hundredths(taxRatePercent) - hundredths(profitPercent);
  if (rest <= 0) return null;
  return { purchasePercent: `${Math.trunc(rest / 100)}.${String(rest % 100).padStart(2, "0")}` };
}
