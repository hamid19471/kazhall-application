/**
 * Date filters: the Persian picker in the page, Gregorian `YYYY-MM-DD` in the
 * URL and the API.
 *
 * Covers what happens around the picker — the query string it produces, the
 * range a reload or Back/Forward restores, clearing, other filters surviving a
 * date change — using the same functions the pages call. The picker's own
 * behaviour is tested in `packages/ui` (vitest + jsdom).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isoDayToPersian,
  persianDay,
  persianToIsoDay,
  readDayRange,
  tehranDayEnd,
  tehranDayStart,
} from "../../../packages/ui/src/date/persian-date.ts";
import {
  adminAuditHref,
  adminMovementsHref,
  adminOrdersHref,
  adminProfitReportHref,
  adminReportsHref,
} from "./routes.ts";
import { localDateParam, type RawSearchParams } from "./search-params.ts";

/** What Next hands a page for this URL's query string. */
function searchParamsOf(href: string): RawSearchParams {
  const params: RawSearchParams = {};
  for (const [key, value] of new URL(href, "http://localhost:8001").searchParams) params[key] = value;
  return params;
}

/** The form a picker range submits: hidden ISO fields plus the page's other fields. */
function formWith(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

const PICKED = persianDay(1405, 7, 5); // ۵ مهر ۱۴۰۵

describe("a picked Persian day in the query string", () => {
  it("is serialised as the Gregorian day, never the Persian one", () => {
    const day = persianToIsoDay(PICKED);
    assert.equal(day, "2026-09-27");
    const href = adminProfitReportHref({ from: day ?? undefined, to: day ?? undefined });
    const query = new URL(href, "http://localhost:8001").searchParams;
    assert.equal(query.get("from"), "2026-09-27");
    assert.equal(query.get("to"), "2026-09-27");
    assert.doesNotMatch(href, /1405/);
  });

  for (const [name, build] of [
    ["profit report", adminProfitReportHref],
    ["sales report", adminReportsHref],
    ["orders", adminOrdersHref],
    ["audit log", adminAuditHref],
    ["stock movements", adminMovementsHref],
  ] as const) {
    it(`uses from/to on the ${name} URL`, () => {
      const href = build({ from: "2026-09-01", to: "2026-09-27" });
      assert.match(href, /[?&]from=2026-09-01(&|$)/);
      assert.match(href, /[?&]to=2026-09-27(&|$)/);
    });
  }
});

describe("restoring a range after reload or Back/Forward", () => {
  it("reads the Gregorian days back and shows the same Persian day", () => {
    const params = searchParamsOf(adminProfitReportHref({ from: "2026-09-27", to: "2026-09-27", channel: "pos" }));
    const from = localDateParam(params, "from");
    assert.equal(from, "2026-09-27");
    const shown = isoDayToPersian(from);
    assert.deepEqual([shown?.year, shown?.month, shown?.day], [1405, 7, 5]);
  });

  it("drops a Persian or malformed value from the URL instead of misreading it", () => {
    // A hand-typed Persian-digit date or a non-padded day is not the contract, so it
    // is ignored (the filter is simply absent) rather than guessed at.
    assert.equal(localDateParam(searchParamsOf("/admin/reports?from=۱۴۰۵-۰۷-۰۵"), "from"), undefined);
    assert.equal(localDateParam(searchParamsOf("/admin/reports?from=2026-9-27"), "from"), undefined);
  });
});

describe("submitting the filter form", () => {
  it("keeps every other filter when only the date changes", () => {
    const form = formWith({
      from: "2026-09-27",
      to: "2026-09-27",
      channel: "pos",
      productId: "43",
      variantId: "55",
    });
    const range = readDayRange(form);
    assert.equal(range.error, null);
    const href = adminProfitReportHref({
      from: range.from,
      to: range.to,
      channel: String(form.get("channel")),
      productId: String(form.get("productId")),
      variantId: String(form.get("variantId")),
    });
    const query = new URL(href, "http://localhost:8001").searchParams;
    assert.deepEqual(
      Object.fromEntries(query),
      { from: "2026-09-27", to: "2026-09-27", channel: "pos", productId: "43", variantId: "55" },
    );
  });

  it("clears the range: an empty picker submits nothing and the URL has no from/to", () => {
    const range = readDayRange(formWith({ from: "", to: "", channel: "pos" }));
    assert.deepEqual(range, { from: undefined, to: undefined, error: null });
    const href = adminProfitReportHref({ from: range.from, to: range.to, channel: "pos" });
    assert.doesNotMatch(href, /from=|to=/);
    // "پاک‌کردن فیلترها" navigates to the bare page.
    assert.doesNotMatch(adminProfitReportHref(), /\?/);
  });

  it("refuses a reversed range instead of swapping it", () => {
    const range = readDayRange(formWith({ from: "2026-09-28", to: "2026-09-27" }));
    assert.match(range.error ?? "", /پیش از تاریخ شروع/);
    assert.equal(range.from, "2026-09-28");
    assert.equal(range.to, "2026-09-27");
  });
});

describe("instant-based filters (audit log, stock movements)", () => {
  it("send the whole Tehran day, whatever the browser's zone", () => {
    assert.equal(tehranDayStart("2026-09-27"), "2026-09-26T20:30:00.000Z");
    assert.equal(tehranDayEnd("2026-09-27"), "2026-09-27T20:29:59.999Z");
  });
});
