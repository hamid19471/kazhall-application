/**
 * Business-timezone helpers.
 *
 * The business day is `REPORT_TIMEZONE` (default `Asia/Tehran`, +03:30 with no
 * DST at present but historically DST-bearing, which is exactly why nothing
 * here hard-codes an offset). Everything is derived from the IANA zone, either
 * by PostgreSQL's `AT TIME ZONE` or by `Intl`.
 */

export const DEFAULT_REPORT_TIMEZONE = 'Asia/Tehran';

/** IANA zone names: letters, digits, `_`, `-`, `+`, `/`. */
const IANA_ZONE = /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/;

export function resolveReportTimezone(raw?: string | null): string {
  const tz = (raw ?? '').trim() || DEFAULT_REPORT_TIMEZONE;
  if (!IANA_ZONE.test(tz)) return DEFAULT_REPORT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_REPORT_TIMEZONE;
  }
}

/** `2026-09-09` — the local calendar day `instant` falls on, in `tz`. */
export function businessDate(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** `20260909` — compact form used inside human-facing order numbers. */
export function businessDateStamp(instant: Date, tz: string): string {
  return businessDate(instant, tz).replace(/-/g, '');
}
