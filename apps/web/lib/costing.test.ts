import assert from "node:assert/strict";
import { test } from "node:test";

import {
  INT8_MAX,
  MAX_RIAL_BIGINT,
  MAX_STOCK_UNITS,
  allocate,
  averageUnitCost,
  formatPercentString,
  grossProfitPerUnit,
  marginPercent,
  parseQuantityInput,
  parseRialInput,
  receiptPreview,
  removalPreview,
  rialOf,
  unvaluedIncreasePreview,
  valuationPreview,
} from "./costing.ts";

const B = (value: string | number) => BigInt(value);

test("an empty box is missing, not zero", () => {
  assert.deepEqual(parseRialInput(""), { kind: "empty" });
  assert.deepEqual(parseRialInput("   "), { kind: "empty" });
  assert.deepEqual(parseRialInput("٬ ,"), { kind: "empty" });
});

test("an explicit zero is a real value", () => {
  assert.deepEqual(parseRialInput("0"), { kind: "value", value: B(0) });
  assert.deepEqual(parseRialInput("۰"), { kind: "value", value: B(0) });
  assert.deepEqual(parseRialInput("000"), { kind: "value", value: B(0) });
});

test("Persian and Arabic-Indic digits and pasted separators are folded", () => {
  assert.deepEqual(parseRialInput("۱۲۵٬۰۰۰"), { kind: "value", value: B(125000) });
  assert.deepEqual(parseRialInput("١٢٥٠٠٠"), { kind: "value", value: B(125000) });
  assert.deepEqual(parseRialInput(" 8,500,000 "), { kind: "value", value: B(8500000) });
});

test("fractions are refused, including the Persian decimal separator", () => {
  assert.deepEqual(parseRialInput("12.5"), { kind: "invalid", reason: "fraction" });
  assert.deepEqual(parseRialInput("۱۲٫۵"), { kind: "invalid", reason: "fraction" });
  assert.deepEqual(parseRialInput(".5"), { kind: "invalid", reason: "fraction" });
});

test("letters, exponents and negatives are refused", () => {
  assert.deepEqual(parseRialInput("abc"), { kind: "invalid", reason: "not_integer" });
  assert.deepEqual(parseRialInput("1e6"), { kind: "invalid", reason: "not_integer" });
  assert.deepEqual(parseRialInput("-5"), { kind: "invalid", reason: "negative" });
  assert.deepEqual(parseRialInput("-5", { allowNegative: true }), { kind: "value", value: B(-5) });
});

test("the API's MAX_RIAL is the ceiling, checked without Number", () => {
  assert.equal(MAX_RIAL_BIGINT, B(45035996273));
  assert.deepEqual(parseRialInput("45035996273"), { kind: "value", value: B(45035996273) });
  assert.deepEqual(parseRialInput("45035996274"), { kind: "invalid", reason: "too_large" });
  assert.deepEqual(parseRialInput("99999999999999999999999"), {
    kind: "invalid",
    reason: "too_large",
  });
});

test("quantities: zero, negatives and the stock ceiling", () => {
  assert.deepEqual(parseQuantityInput("۳"), { kind: "value", value: 3 });
  assert.deepEqual(parseQuantityInput("0"), { kind: "value", value: 0 });
  assert.deepEqual(parseQuantityInput("0", { allowZero: false }), { kind: "invalid", reason: "zero" });
  assert.deepEqual(parseQuantityInput("-3"), { kind: "invalid", reason: "negative" });
  assert.deepEqual(parseQuantityInput("-3", { allowNegative: true }), { kind: "value", value: -3 });
  assert.deepEqual(parseQuantityInput(String(MAX_STOCK_UNITS)), { kind: "value", value: MAX_STOCK_UNITS });
  assert.deepEqual(parseQuantityInput(String(MAX_STOCK_UNITS + 1)), { kind: "invalid", reason: "too_large" });
  assert.deepEqual(parseQuantityInput("1.5"), { kind: "invalid", reason: "fraction" });
});

test("rialOf reads API strings exactly and refuses malformed ones", () => {
  assert.equal(rialOf("9007199254740993"), B("9007199254740993"));
  assert.equal(rialOf(null), null);
  assert.equal(rialOf("12.0"), null);
});

test("gross profit per unit, including a loss", () => {
  assert.equal(grossProfitPerUnit(B(12000), B(10000)), B(2000));
  assert.equal(grossProfitPerUnit(B(10000), B(12000)), B(-2000));
  assert.equal(grossProfitPerUnit(B(10000), B(0)), B(10000));
});

test("margin is null when revenue is not positive", () => {
  assert.equal(marginPercent(B(0), B(0)), null);
  assert.equal(marginPercent(B(-5), B(-100)), null);
  assert.equal(marginPercent(B(100), B(0)), null);
});

test("margin has exactly two decimals", () => {
  assert.equal(marginPercent(B(2000), B(12000)), "16.67");
  assert.equal(marginPercent(B(0), B(12000)), "0.00");
  assert.equal(marginPercent(B(12000), B(12000)), "100.00");
  assert.equal(marginPercent(B(1), B(3)), "33.33");
  assert.equal(marginPercent(B(2), B(3)), "66.67");
});

test("margin rounds half away from zero, both signs", () => {
  // 1/8 = 12.5% exactly → "12.50"; 1/800 = 0.125% → 0.13
  assert.equal(marginPercent(B(1), B(800)), "0.13");
  assert.equal(marginPercent(B(-1), B(800)), "-0.13");
  // 0.004% rounds to zero and must not print as "-0.00"
  assert.equal(marginPercent(B(-1), B(25000)), "0.00");
  assert.equal(marginPercent(B(-2000), B(10000)), "-20.00");
  assert.equal(marginPercent(B(-3), B(2)), "-150.00");
});

test("margin is exact far beyond 2^53", () => {
  const revenue = B("90071992547409930000");
  const profit = B("30023997515803310000");
  assert.equal(marginPercent(profit, revenue), "33.33");
  assert.equal(marginPercent(revenue - B(1), revenue), "100.00");
});

test("percent strings render in Persian with the Persian decimal separator", () => {
  assert.equal(formatPercentString("16.67"), "۱۶٫۶۷٪");
  assert.equal(formatPercentString("-20.00"), "−۲۰٫۰۰٪");
  assert.equal(formatPercentString("-0.00"), "۰٫۰۰٪");
  assert.equal(formatPercentString(null), "—");
  assert.equal(formatPercentString("NaN"), "—");
});

test("allocation follows the docs' worked example and never loses a Rial", () => {
  // receive 3 @ 10 000, receive 2 @ 13 001 → 5 units, 56 002
  let value = B(56002);
  let units = 5;
  const first = allocate(value, units, 2);
  assert.equal(first, B(22400));
  value -= first;
  units -= 2;
  const second = allocate(value, units, 1);
  assert.equal(second, B(11200));
  value -= second;
  units -= 1;
  const last = allocate(value, units, 2);
  assert.equal(last, B(22402));
  assert.equal(first + second + last, B(56002));
  assert.equal(allocate(B(100), 0, 1), B(0));
});

test("average is a floor and null with no valued units", () => {
  assert.equal(averageUnitCost(B(56002), 5), B(11200));
  assert.equal(averageUnitCost(B(0), 0), null);
});

test("receipt preview: old, incoming, new value and new moving average", () => {
  const preview = receiptPreview({ stock: 3, unvaluedQuantity: 0, inventoryCostValue: "30000" }, 2, B(13001));
  assert.equal(preview.oldValue, B(30000));
  assert.equal(preview.incomingValue, B(26002));
  assert.equal(preview.newValue, B(56002));
  assert.equal(preview.newStock, 5);
  assert.equal(preview.newValuedQuantity, 5);
  assert.equal(preview.newAverage, B(11200));
  assert.equal(preview.outOfRange, false);
});

test("receipt preview ignores unvalued units in the average", () => {
  const preview = receiptPreview({ stock: 10, unvaluedQuantity: 10, inventoryCostValue: "0" }, 4, B(2500));
  assert.equal(preview.newValue, B(10000));
  assert.equal(preview.newValuedQuantity, 4);
  assert.equal(preview.newAverage, B(2500));
});

test("a zero-cost receipt is a known cost of zero", () => {
  const preview = receiptPreview({ stock: 0, unvaluedQuantity: 0, inventoryCostValue: "0" }, 5, B(0));
  assert.equal(preview.newValue, B(0));
  assert.equal(preview.newAverage, B(0));
});

test("receipt preview stays exact past 2^53 and flags bigint overflow", () => {
  const big = receiptPreview(
    { stock: 1, unvaluedQuantity: 0, inventoryCostValue: "9007199254740993" },
    MAX_STOCK_UNITS,
    MAX_RIAL_BIGINT,
  );
  assert.equal(big.newValue, B("9007199254740993") + B(MAX_STOCK_UNITS) * MAX_RIAL_BIGINT);
  assert.equal(big.outOfRange, big.newValue > INT8_MAX);
  assert.equal(big.outOfRange, true);
});

test("valuation preview by unit cost and by total value", () => {
  const pool = { stock: 12, unvaluedQuantity: 8, inventoryCostValue: "40000" };
  const byUnit = valuationPreview(pool, { mode: "unitCost", unitCost: B(9000) });
  assert.equal(byUnit.valuedUnits, 8);
  assert.equal(byUnit.addedValue, B(72000));
  assert.equal(byUnit.newValue, B(112000));
  assert.equal(byUnit.newAverage, B(9333));

  const byTotal = valuationPreview(pool, { mode: "totalValue", totalValue: B(1) });
  assert.equal(byTotal.addedValue, B(1));
  assert.equal(byTotal.newValue, B(40001));
});

test("removal takes unknown-cost units first and removes proportional cost", () => {
  const pool = { stock: 10, unvaluedQuantity: 3, inventoryCostValue: "70001" };
  const small = removalPreview(pool, 2);
  assert.equal(small.unknownQuantity, 2);
  assert.equal(small.knownQuantity, 0);
  assert.equal(small.costRemoved, B(0));

  const mixed = removalPreview(pool, 5);
  assert.equal(mixed.unknownQuantity, 3);
  assert.equal(mixed.knownQuantity, 2);
  assert.equal(mixed.costRemoved, B(20000)); // floor(70001 × 2 / 7)
  assert.equal(mixed.newValue, B(50001));
  assert.equal(mixed.newUnvalued, 0);

  const all = removalPreview(pool, 10);
  assert.equal(all.costRemoved, B(70001));
  assert.equal(all.newValue, B(0));
  assert.equal(all.newAverage, null);
});

test("an unknown-cost increase adds units without value", () => {
  const preview = unvaluedIncreasePreview({ stock: 4, unvaluedQuantity: 0, inventoryCostValue: "4000" }, 2);
  assert.equal(preview.newStock, 6);
  assert.equal(preview.newUnvalued, 2);
  assert.equal(preview.newValue, B(4000));
  assert.equal(preview.newAverage, B(1000));
});
