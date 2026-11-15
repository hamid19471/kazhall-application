/**
 * Monthly pricing screens: the pure helpers they lean on.
 *
 * The server owns the formula (apps/api pricing-formula.spec.ts); these pin
 * what the browser does before a request: turning typed percents into the
 * text the API accepts without a float, naming Persian months, and the
 * illustration panel's share split.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PERSIAN_MONTHS,
  currentPersianMonth,
  monthKey,
  parseMonthKey,
  parsePercentInput,
  persianDigits,
  planMonthLabel,
  shareExample,
} from "./pricing.ts";
import { adminPricingPlanHref, adminPricingPlansHref } from "./routes.ts";

describe("parsePercentInput", () => {
  it("accepts Latin, Persian and Arabic-Indic digits and a decimal mark", () => {
    assert.deepEqual(parsePercentInput("10"), { kind: "value", text: "10" });
    assert.deepEqual(parsePercentInput("۱۲٫۵"), { kind: "value", text: "12.5" });
    assert.deepEqual(parsePercentInput("٩.٧٥"), { kind: "value", text: "9.75" });
    assert.deepEqual(parsePercentInput(" 20 ٪ "), { kind: "value", text: "20" });
    assert.deepEqual(parsePercentInput("7.50"), { kind: "value", text: "7.5" });
    assert.deepEqual(parsePercentInput("0"), { kind: "value", text: "0" });
  });

  it("treats empty as empty, not zero", () => {
    assert.deepEqual(parsePercentInput("   "), { kind: "empty" });
  });

  it("refuses more than two decimals, negatives, junk and 100 % or more", () => {
    for (const bad of ["12.345", "-5", "abc", "100", "150", "1e2", "12..5"]) {
      assert.deepEqual(parsePercentInput(bad), { kind: "invalid" }, bad);
    }
    // a caller can raise the ceiling (the review threshold may exceed 100 %)
    assert.deepEqual(parsePercentInput("150", 10_001), { kind: "value", text: "150" });
  });
});

describe("months", () => {
  it("names Persian months and writes Persian digits", () => {
    assert.equal(PERSIAN_MONTHS.length, 12);
    assert.equal(planMonthLabel(1405, 7), "مهر ۱۴۰۵");
    assert.equal(planMonthLabel(1404, 12), "اسفند ۱۴۰۴");
    assert.equal(persianDigits(2026), "۲۰۲۶");
  });

  it("round-trips the YYYY-MM key and refuses nonsense", () => {
    assert.equal(monthKey(1405, 7), "1405-07");
    assert.deepEqual(parseMonthKey("1405-07"), { year: 1405, month: 7 });
    for (const bad of ["1405-13", "1405-00", "2026-09", "1405-7", undefined]) {
      assert.equal(parseMonthKey(bad as string | undefined), null);
    }
  });

  it("reports the current Persian month in Tehran", () => {
    const now = currentPersianMonth();
    assert.ok(now.year >= 1400 && now.year <= 1500);
    assert.ok(now.month >= 1 && now.month <= 12);
  });
});

describe("shareExample", () => {
  it("leaves the purchase-cost share of the price", () => {
    assert.deepEqual(shareExample("20.00", "10.00", "20.00"), { purchasePercent: "50.00" });
    assert.deepEqual(shareExample("12.70", "9.87", "12.34"), { purchasePercent: "65.09" });
  });

  it("is unusable at or beyond 100 % or with a missing input", () => {
    assert.equal(shareExample("20.00", "10.00", "70.00"), null);
    assert.equal(shareExample(null, "10.00", "20.00"), null);
  });
});

describe("routes", () => {
  it("builds the plan list and plan URLs, keeping filters in the query", () => {
    assert.equal(adminPricingPlansHref(), "/admin/pricing");
    assert.equal(adminPricingPlanHref(12), "/admin/pricing/12");
    assert.equal(
      adminPricingPlanHref(12, { view: "all", status: "BLOCKED", page: 3 }),
      "/admin/pricing/12?view=all&status=BLOCKED&page=3",
    );
  });
});
