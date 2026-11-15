import { CalendarDate, GregorianCalendar, PersianCalendar } from "@internationalized/date";
import { describe, expect, it } from "vitest";

import {
  BUSINESS_TIME_ZONE,
  REVERSED_RANGE_MESSAGE,
  formatIsoDayPersian,
  isIsoDay,
  isoDayToPersian,
  parseIsoDay,
  persianDay,
  persianToIsoDay,
  readDayRange,
  tehranDayEnd,
  tehranDayStart,
  todayIsoDay,
  validateDayRange,
} from "./persian-date";

const parts = (date: CalendarDate | null) => (date ? [date.year, date.month, date.day] : null);

describe("the machine's timezone cannot move a day", () => {
  it("runs under the zone the script asked for", () => {
    // Set by this package's own `test` script for the extra runs, not by turbo.
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    const requested = process.env.TZ;
    if (requested) expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(requested);
  });

  it("round-trips every day of two full years without a shift", () => {
    let day = new CalendarDate(new GregorianCalendar(), 2025, 1, 1);
    const end = new CalendarDate(new GregorianCalendar(), 2027, 1, 1);
    while (day.compare(end) < 0) {
      const iso = day.toString();
      expect(persianToIsoDay(isoDayToPersian(iso))).toBe(iso);
      day = day.add({ days: 1 });
    }
  });
});

describe("Gregorian ISO → Persian", () => {
  it("shows 2026-09-27 as 5 Mehr 1405", () => {
    expect(parts(isoDayToPersian("2026-09-27"))).toEqual([1405, 7, 5]);
    expect(formatIsoDayPersian("2026-09-27")).toBe("۵ مهر ۱۴۰۵");
  });

  it("puts Nowruz 1405 on 2026-03-21 and the day before in Esfand 1404", () => {
    expect(parts(isoDayToPersian("2026-03-21"))).toEqual([1405, 1, 1]);
    expect(parts(isoDayToPersian("2026-03-20"))).toEqual([1404, 12, 29]);
  });

  it("puts Nowruz 1404 on 2025-03-21", () => {
    expect(parts(isoDayToPersian("2025-03-21"))).toEqual([1404, 1, 1]);
  });

  it("gives leap year 1403 a 30th of Esfand and 1404 none", () => {
    const calendar = new PersianCalendar();
    expect(parts(isoDayToPersian("2025-03-20"))).toEqual([1403, 12, 30]);
    expect(calendar.getDaysInMonth(persianDay(1403, 12, 1))).toBe(30);
    expect(calendar.getDaysInMonth(persianDay(1404, 12, 1))).toBe(29);
    expect(calendar.getDaysInMonth(persianDay(1408, 12, 1))).toBe(30);
  });

  it("refuses shapes and days that do not exist", () => {
    for (const bad of ["", "2026-9-27", "27-09-2026", "2026-02-30", "2026-13-01", "۲۰۲۶-۰۹-۲۷", "2026-09-27T00:00:00Z"]) {
      expect(parseIsoDay(bad)).toBeNull();
      expect(isIsoDay(bad)).toBe(false);
      expect(isoDayToPersian(bad)).toBeNull();
    }
    expect(parseIsoDay(undefined)).toBeNull();
    expect(parseIsoDay(null)).toBeNull();
  });
});

describe("Persian selection → Gregorian ISO", () => {
  it("turns 1405/07/05 into 2026-09-27, never 1405-07-05", () => {
    expect(persianToIsoDay(persianDay(1405, 7, 5))).toBe("2026-09-27");
  });

  it("maps Nowruz and the leap day across the year boundary", () => {
    expect(persianToIsoDay(persianDay(1405, 1, 1))).toBe("2026-03-21");
    expect(persianToIsoDay(persianDay(1403, 12, 30))).toBe("2025-03-20");
    expect(persianToIsoDay(persianDay(1404, 1, 1))).toBe("2025-03-21");
  });

  it("keeps a day after month and year navigation", () => {
    const start = persianDay(1405, 7, 5);
    expect(persianToIsoDay(start.add({ months: 1 }))).toBe("2026-10-27");
    expect(persianToIsoDay(start.subtract({ months: 1 }))).toBe("2026-08-27");
    expect(persianToIsoDay(start.add({ years: 1 }))).toBe("2027-09-27");
    // 30 Esfand 1403 + 1 year has no 30th of Esfand; the day is constrained to 29.
    expect(persianToIsoDay(persianDay(1403, 12, 30).add({ years: 1 }))).toBe("2026-03-20");
  });

  it("returns null for no value", () => {
    expect(persianToIsoDay(null)).toBeNull();
    expect(persianToIsoDay(undefined)).toBeNull();
  });
});

describe("Tehran day boundaries", () => {
  it("uses Asia/Tehran", () => {
    expect(BUSINESS_TIME_ZONE).toBe("Asia/Tehran");
  });

  it("starts 2026-09-27 at 00:00 Tehran and ends it at 23:59:59.999 Tehran", () => {
    expect(tehranDayStart("2026-09-27")).toBe("2026-09-26T20:30:00.000Z");
    expect(tehranDayEnd("2026-09-27")).toBe("2026-09-27T20:29:59.999Z");
  });

  it("covers Nowruz as one whole Tehran day", () => {
    expect(tehranDayStart("2026-03-21")).toBe("2026-03-20T20:30:00.000Z");
    expect(tehranDayEnd("2026-03-21")).toBe("2026-03-21T20:29:59.999Z");
  });

  it("refuses a non-day", () => {
    expect(tehranDayStart("1405-07-05x")).toBeNull();
    expect(tehranDayEnd("")).toBeNull();
  });

  it("reports today as a real ISO day", () => {
    expect(isIsoDay(todayIsoDay())).toBe(true);
  });
});

describe("range validation and form reading", () => {
  it("accepts empty, one-sided, equal and ordered ranges", () => {
    expect(validateDayRange({})).toBeNull();
    expect(validateDayRange({ from: "2026-09-27" })).toBeNull();
    expect(validateDayRange({ to: "2026-09-27" })).toBeNull();
    expect(validateDayRange({ from: "2026-09-27", to: "2026-09-27" })).toBeNull();
    expect(validateDayRange({ from: "2026-09-01", to: "2026-09-30" })).toBeNull();
  });

  it("refuses a reversed range with a Persian message instead of swapping", () => {
    expect(validateDayRange({ from: "2026-09-28", to: "2026-09-27" })).toBe(REVERSED_RANGE_MESSAGE);
    expect(REVERSED_RANGE_MESSAGE).toMatch(/پیش از تاریخ شروع/);
  });

  it("reads only real ISO days from a form and reports the error", () => {
    const form = new FormData();
    form.set("from", "2026-09-28");
    form.set("to", "2026-09-27");
    form.set("channel", "pos");
    expect(readDayRange(form)).toEqual({ from: "2026-09-28", to: "2026-09-27", error: REVERSED_RANGE_MESSAGE });

    const junk = new FormData();
    junk.set("from", "۵ مهر ۱۴۰۵");
    junk.set("to", "");
    expect(readDayRange(junk)).toEqual({ from: undefined, to: undefined, error: null });

    const named = new FormData();
    named.set("since", "2026-09-01");
    expect(readDayRange(named, { from: "since", to: "until" })).toEqual({ from: "2026-09-01", to: undefined, error: null });
  });
});
