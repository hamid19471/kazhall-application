/**
 * The ONE place a calendar day crosses between the API and the Persian UI.
 *
 * ============================================================================
 * THE CONTRACT
 * ============================================================================
 *  - The API, every query string and every form field carry a GREGORIAN
 *    calendar day as `YYYY-MM-DD` ("ISO day"). It is a local calendar day in
 *    the business timezone, Asia/Tehran — not an instant, not UTC.
 *  - People see and pick PERSIAN (Jalali) days, in Persian digits.
 *  - A Persian day such as `1405-07-05` must never reach the API. The only way
 *    out of the picker is {@link persianToIsoDay}, which always returns the
 *    Gregorian day.
 *
 * ============================================================================
 * WHY NOTHING HERE TOUCHES `Date`
 * ============================================================================
 * A calendar day has no time and no zone. `new Date("2026-09-27")` is UTC
 * midnight, which is still 26 September anywhere west of Greenwich, and
 * `new Date(2026, 8, 27)` is the BROWSER's midnight, which is not Tehran's.
 * Either one can move the selected day by one. So conversion is pure calendar
 * arithmetic from `@internationalized/date` (`CalendarDate` + `toCalendar`),
 * and the only instants produced are the explicit Tehran day boundaries below,
 * for the filters whose API takes instants.
 * ============================================================================
 */
import {
  CalendarDate,
  DateFormatter,
  GregorianCalendar,
  PersianCalendar,
  parseDate,
  toCalendar,
  toZoned,
  today,
  type DateValue,
} from "@internationalized/date";

/** The business timezone every calendar day is interpreted in. */
export const BUSINESS_TIME_ZONE = "Asia/Tehran";

/**
 * Locale for everything the picker shows: Persian language, Persian calendar,
 * Persian digits. Spelled out rather than relying on `fa-IR`'s defaults.
 */
export const PERSIAN_LOCALE = "fa-IR-u-ca-persian-nu-arabext";

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const persian = new PersianCalendar();
const gregorian = new GregorianCalendar();

/**
 * Parse a Gregorian `YYYY-MM-DD` into a calendar day, or `null`.
 *
 * Strict: the shape must match AND the day must exist. `2026-02-30` is refused
 * rather than silently rolled into March.
 */
export function parseIsoDay(value: string | null | undefined): CalendarDate | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!ISO_DAY.test(trimmed)) return null;
  try {
    const date = parseDate(trimmed);
    return date.toString() === trimmed ? date : null;
  } catch {
    return null;
  }
}

/** True for a real Gregorian `YYYY-MM-DD` day. */
export function isIsoDay(value: string | null | undefined): value is string {
  return parseIsoDay(value) !== null;
}

/** Gregorian ISO day → the same day in the Persian calendar, for display. */
export function isoDayToPersian(value: string | null | undefined): CalendarDate | null {
  const date = parseIsoDay(value);
  return date === null ? null : toCalendar(date, persian);
}

/**
 * Any calendar day (in practice, the Persian day a person picked) → its
 * Gregorian `YYYY-MM-DD`. The only value the UI ever submits.
 */
export function persianToIsoDay(value: DateValue | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const day = new CalendarDate(value.calendar, value.era, value.year, value.month, value.day);
  return toCalendar(day, gregorian).toString();
}

/** A Persian day by its parts, e.g. `persianDay(1405, 7, 5)`. */
export function persianDay(year: number, month: number, day: number): CalendarDate {
  return new CalendarDate(persian, year, month, day);
}

/** Today's Gregorian ISO day in Tehran — not in the browser's zone. */
export function todayIsoDay(): string {
  return toCalendar(today(BUSINESS_TIME_ZONE), gregorian).toString();
}

/**
 * The first instant of a Tehran calendar day, as a UTC ISO-8601 instant.
 * `2026-09-27` → `2026-09-26T20:30:00.000Z`.
 *
 * For the filters whose API takes instants (audit log, stock movements). The
 * report and order filters send the bare ISO day instead; the API applies
 * the same zone there.
 */
export function tehranDayStart(value: string): string | null {
  const date = parseIsoDay(value);
  return date === null ? null : toZoned(date, BUSINESS_TIME_ZONE).toAbsoluteString();
}

/**
 * The LAST instant of a Tehran calendar day (inclusive upper bound).
 * `2026-09-27` → `2026-09-27T20:29:59.999Z`.
 *
 * Computed as "start of the next day minus one millisecond" so it stays correct
 * even on a day whose length is not 24 hours.
 */
export function tehranDayEnd(value: string): string | null {
  const date = parseIsoDay(value);
  if (date === null) return null;
  return toZoned(date.add({ days: 1 }), BUSINESS_TIME_ZONE)
    .subtract({ milliseconds: 1 })
    .toAbsoluteString();
}

const longFormatter = new DateFormatter(PERSIAN_LOCALE, {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: BUSINESS_TIME_ZONE,
});

/**
 * A Gregorian ISO day, written as a Persian date: `2026-09-27` → `۵ مهر ۱۴۰۵`.
 * Formats the day itself (via its Tehran midnight), so no zone can shift it.
 */
export function formatIsoDayPersian(value: string | null | undefined): string {
  const date = parseIsoDay(value);
  if (date === null) return "";
  return longFormatter.format(toZoned(date, BUSINESS_TIME_ZONE).toDate());
}

export const REVERSED_RANGE_MESSAGE =
  "تاریخ پایان بازه نمی‌تواند پیش از تاریخ شروع باشد. تاریخ‌ها را اصلاح کنید؛ جابه‌جا نمی‌شوند.";

export interface DayRange {
  from?: string;
  to?: string;
}

/**
 * `null` when the range is acceptable, otherwise the Persian message to show.
 *
 * Both ends are optional. The range is inclusive, so `from === to` is one full
 * day. A reversed range is REFUSED, never swapped: swapping would run a query
 * the person did not ask for.
 */
export function validateDayRange(range: DayRange): string | null {
  const from = parseIsoDay(range.from);
  const to = parseIsoDay(range.to);
  if (from === null || to === null) return null;
  return from.compare(to) > 0 ? REVERSED_RANGE_MESSAGE : null;
}

/**
 * Read an ISO day range out of a submitted form, by field name.
 *
 * Returns only real ISO days (anything else becomes `undefined`) plus the
 * validation result, so a submit handler can refuse a reversed range with one
 * `if`.
 */
export function readDayRange(
  form: FormData,
  names: { from?: string; to?: string } = {},
): DayRange & { error: string | null } {
  const read = (name: string): string | undefined => {
    const raw = form.get(name);
    return typeof raw === "string" && isIsoDay(raw.trim()) ? raw.trim() : undefined;
  };
  const range: DayRange = { from: read(names.from ?? "from"), to: read(names.to ?? "to") };
  return { ...range, error: validateDayRange(range) };
}
