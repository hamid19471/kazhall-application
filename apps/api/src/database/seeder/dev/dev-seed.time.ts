/**
 * Date strategy for the review dataset.
 *
 * Reports are the reason this file exists. A summary for "today" is only
 * reviewable if some sales are dated today, and a date-range report is only
 * reviewable if others are dated weeks back — so the orders cannot all carry
 * one frozen literal timestamp.
 *
 * The strategy is therefore RELATIVE, and anchored to local midnight in the
 * reporting timezone (`Asia/Tehran`, the same zone `ReportsService` uses), so
 * "today's sales" means the same thing to the seed and to the report.
 *
 * That keeps the data useful without making the seed non-idempotent: an order
 * is matched by its `orderNumber`, never by its date, so a run on a later day
 * finds every order already present and moves nothing. The anchor only decides
 * where orders land the FIRST time they are written.
 */

/**
 * The UTC instant of the most recent local midnight in `timeZone`.
 *
 * No offset is hard-coded. The zone's own offset at `now` is recovered by
 * formatting `now` into the zone and reading the difference, which is how the
 * rest of the codebase avoids baking in +03:30.
 */
export function zonedStartOfDay(now: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);

  const field = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');

  // `hour` comes back as 24 at midnight under `hour12: false`; fold it to 0.
  const wallClockAsUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour') % 24,
    field('minute'),
    field('second'),
  );

  // Whole seconds on both sides: the formatter has no millisecond field, so
  // comparing against the unrounded instant would leak up to 999ms of error
  // into the offset.
  const offsetMs = wallClockAsUtc - Math.floor(now.getTime() / 1000) * 1000;

  const localMidnightAsUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
  );

  return new Date(localMidnightAsUtc - offsetMs);
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Every timestamp the seed writes, derived from one anchor.
 *
 * Times of day are mid-morning/afternoon on purpose: a sale stamped exactly at
 * local midnight sits on the boundary of two report days and makes an
 * off-by-one in the range SQL invisible.
 */
export class SeedClock {
  /** Local midnight today, in the reporting timezone. */
  readonly startOfToday: Date;
  readonly now: Date;

  constructor(now: Date, timeZone: string) {
    this.now = now;
    this.startOfToday = zonedStartOfDay(now, timeZone);
  }

  /** `daysAgo` local days back, at `hour`:`minute` local time. */
  at(daysAgo: number, hour: number, minute = 0): Date {
    return new Date(
      this.startOfToday.getTime() -
        daysAgo * DAY_MS +
        hour * HOUR_MS +
        minute * 60 * 1000,
    );
  }

  /**
   * The same instant, but never in the future.
   *
   * Every seeded sale is a sale that ALREADY HAPPENED. Without this clamp a
   * seed run at 09:00 would stamp "today at 14:40" on a sale and on the stock
   * movement it wrote, producing a ledger entry dated after the moment it was
   * written — and, worse, a lazy reservation sweep run at that future instant
   * would expire basket holds that are still live in real time.
   */
  past(daysAgo: number, hour: number, minute = 0): Date {
    const wanted = this.at(daysAgo, hour, minute).getTime();
    const ceiling = this.now.getTime() - 60 * 1000;
    return new Date(Math.min(wanted, ceiling));
  }
}
