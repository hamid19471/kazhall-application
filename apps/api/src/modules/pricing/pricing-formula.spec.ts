import { MAX_RIAL } from 'src/common/money/rial';

import {
  DEFAULT_REVIEW_RULES,
  PRICING_INPUT_PROBLEMS as P,
  PRICING_ITEM_STATUS as S,
  PRICING_REASON as R,
  TargetRevenueInputs,
  VariantPricingFacts,
  bpsToPercentText,
  ceilDiv,
  evaluateVariant,
  fixedPoint,
  inputProblems,
  percentTextToBps,
  pricingDenominator,
  targetRevenuePrice,
} from './pricing-formula';

const MAX = BigInt(MAX_RIAL);

/** The worked example from the brief and docs/MONTHLY-PRICING.md. */
const EXAMPLE: TargetRevenueInputs = {
  monthlyCostsTotalRial: 1_000_000_000n,
  targetMonthlyRevenueRial: 5_000_000_000n,
  taxRateBps: 1_000,
  targetProfitMarginBps: 2_000,
  roundingStepRial: 1n,
};

const FACTS: VariantPricingFacts = {
  isActive: true,
  offered: true,
  stock: 10,
  unvaluedQuantity: 0,
  averageUnitCost: 1_000_000n,
  currentPrice: 1_900_000n,
};

describe('TARGET_REVENUE formula', () => {
  it('prices the worked example at exactly 2 000 000 Rial', () => {
    const { numerator, denominator } = pricingDenominator(EXAMPLE);
    // 1 − 20 % − 10 % − 20 % = 50 %
    expect(numerator * 2n).toBe(denominator);
    expect(targetRevenuePrice(1_000_000n, EXAMPLE)).toEqual({
      rawPrice: '2000000.0000',
      proposedPrice: 2_000_000n,
    });
  });

  it('splits the price into operating cost, tax, profit and purchase cost exactly', () => {
    const price = targetRevenuePrice(1_000_000n, EXAMPLE).proposedPrice;
    const operating = (price * 1_000_000_000n) / 5_000_000_000n; // C/R of revenue
    const tax = (price * 1_000n) / 10_000n;
    const profit = (price * 2_000n) / 10_000n;
    expect(operating + tax + profit + 1_000_000n).toBe(price);
  });

  it('rounds UP to the step, never down', () => {
    const inputs = { ...EXAMPLE, roundingStepRial: 10_000n };
    // cost 1 000 001 → raw 2 000 002 → next multiple of 10 000
    expect(targetRevenuePrice(1_000_001n, inputs).proposedPrice).toBe(
      2_010_000n,
    );
    // an exact multiple stays where it is
    expect(targetRevenuePrice(1_000_000n, inputs).proposedPrice).toBe(
      2_000_000n,
    );
    // a step of 1 still rounds a fractional raw price up
    const third: TargetRevenueInputs = {
      monthlyCostsTotalRial: 0n,
      targetMonthlyRevenueRial: 1n,
      taxRateBps: 0,
      targetProfitMarginBps: 6_667, // denominator 33.33 %
      roundingStepRial: 1n,
    };
    const priced = targetRevenuePrice(100n, third);
    // 100 / 0.3333 = 300.030003… — the stored raw price is rounded UP at 4 dp too
    expect(priced.rawPrice).toBe('300.0301');
    expect(priced.proposedPrice).toBe(301n);
  });

  it('keeps the configured margin after rounding (rounding only adds)', () => {
    for (const cost of [1n, 7n, 999_999n, 123_456_789n]) {
      for (const step of [1n, 10n, 1_000n, 10_000n]) {
        const inputs = { ...EXAMPLE, roundingStepRial: step };
        const { proposedPrice } = targetRevenuePrice(cost, inputs);
        // price × 50 % ≥ cost  ⇔  the cost is covered at the configured shares
        expect(proposedPrice * 5_000n).toBeGreaterThanOrEqual(cost * 10_000n);
        expect(proposedPrice % step).toBe(0n);
      }
    }
  });

  it('stays exact at integer-Rial scale far beyond Number.MAX_SAFE_INTEGER', () => {
    const inputs: TargetRevenueInputs = {
      monthlyCostsTotalRial: 999_999_999_999_999n,
      targetMonthlyRevenueRial: 1_000_000_000_000_000n,
      taxRateBps: 0,
      targetProfitMarginBps: 0,
      roundingStepRial: 1n,
    };
    // denominator = 1 − 0.999999999999999 = 1e-15 → price = cost × 1e15
    expect(targetRevenuePrice(7n, inputs).proposedPrice).toBe(
      7_000_000_000_000_000n,
    );
  });

  it('prices a zero-cost denominator boundary as unusable, not Infinity', () => {
    const boundary = { ...EXAMPLE, targetProfitMarginBps: 7_000 }; // 20 + 10 + 70 = 100 %
    expect(inputProblems(boundary)).toEqual([P.DENOMINATOR_NOT_POSITIVE]);
    expect(() => targetRevenuePrice(1n, boundary)).toThrow(RangeError);
    const justInside = { ...EXAMPLE, targetProfitMarginBps: 6_999 }; // 0.01 % left
    expect(inputProblems(justInside)).toEqual([]);
    expect(targetRevenuePrice(1_000_000n, justInside).proposedPrice).toBe(
      10_000_000_000n,
    );
  });

  it('refuses every invalid input with a stable code', () => {
    expect(
      inputProblems({ ...EXAMPLE, targetMonthlyRevenueRial: 0n }),
    ).toContain(P.TARGET_REVENUE_NOT_POSITIVE);
    expect(
      inputProblems({ ...EXAMPLE, targetMonthlyRevenueRial: -1n }),
    ).toEqual(
      expect.arrayContaining([
        P.AMOUNT_NEGATIVE,
        P.TARGET_REVENUE_NOT_POSITIVE,
      ]),
    );
    expect(inputProblems({ ...EXAMPLE, monthlyCostsTotalRial: -1n })).toContain(
      P.AMOUNT_NEGATIVE,
    );
    expect(
      inputProblems({ ...EXAMPLE, monthlyCostsTotalRial: 10n ** 16n }),
    ).toContain(P.AMOUNT_TOO_LARGE);
    expect(inputProblems({ ...EXAMPLE, taxRateBps: -1 })).toContain(
      P.TAX_RATE_OUT_OF_RANGE,
    );
    expect(inputProblems({ ...EXAMPLE, taxRateBps: 10_000 })).toContain(
      P.TAX_RATE_OUT_OF_RANGE,
    );
    expect(inputProblems({ ...EXAMPLE, taxRateBps: 12.5 })).toContain(
      P.TAX_RATE_OUT_OF_RANGE,
    );
    expect(
      inputProblems({ ...EXAMPLE, targetProfitMarginBps: 10_000 }),
    ).toContain(P.PROFIT_MARGIN_OUT_OF_RANGE);
    expect(inputProblems({ ...EXAMPLE, roundingStepRial: 0n })).toContain(
      P.ROUNDING_STEP_INVALID,
    );
    expect(
      inputProblems({ ...EXAMPLE, roundingStepRial: 10_000_001n }),
    ).toContain(P.ROUNDING_STEP_INVALID);
    // costs above revenue ⇒ C/R > 100 % ⇒ negative denominator
    expect(
      inputProblems({ ...EXAMPLE, monthlyCostsTotalRial: 6_000_000_000n }),
    ).toEqual([P.DENOMINATOR_NOT_POSITIVE]);
  });

  it('allows zero monthly costs, zero tax and zero profit', () => {
    const plain = {
      ...EXAMPLE,
      monthlyCostsTotalRial: 0n,
      taxRateBps: 0,
      targetProfitMarginBps: 0,
    };
    expect(targetRevenuePrice(1_234n, plain).proposedPrice).toBe(1_234n);
  });
});

describe('helpers', () => {
  it('parses percent text without floats', () => {
    expect(percentTextToBps('10')).toBe(1_000);
    expect(percentTextToBps('12.5')).toBe(1_250);
    expect(percentTextToBps('33.33')).toBe(3_333);
    expect(percentTextToBps(' 0 ')).toBe(0);
    for (const bad of [
      '',
      '1.234',
      '-1',
      '1e2',
      '٫5',
      'abc',
      '1000',
      '0.1.1',
    ]) {
      expect(percentTextToBps(bad)).toBeNull();
    }
    expect(bpsToPercentText(1_250)).toBe('12.50');
    expect(bpsToPercentText(5)).toBe('0.05');
  });

  it('divides upward exactly', () => {
    expect(ceilDiv(10n, 5n)).toBe(2n);
    expect(ceilDiv(11n, 5n)).toBe(3n);
    expect(ceilDiv(0n, 5n)).toBe(0n);
    expect(() => ceilDiv(1n, 0n)).toThrow(RangeError);
    expect(fixedPoint(123_4567n, 4)).toBe('123.4567');
    expect(fixedPoint(5n, 4)).toBe('0.0005');
  });
});

describe('evaluateVariant', () => {
  const ev = (
    facts: Partial<VariantPricingFacts>,
    rules = DEFAULT_REVIEW_RULES,
  ) => evaluateVariant({ ...FACTS, ...facts }, EXAMPLE, rules, MAX);

  it('is READY for a small increase on a fully valued variant', () => {
    expect(ev({})).toMatchObject({
      status: S.READY,
      reasons: [],
      proposedPrice: 2_000_000n,
    });
  });

  it('is UNCHANGED when the proposed price equals the current price', () => {
    expect(ev({ currentPrice: 2_000_000n })).toMatchObject({
      status: S.UNCHANGED,
    });
  });

  it('needs review for any decrease, unless the plan says otherwise', () => {
    expect(ev({ currentPrice: 2_500_000n })).toMatchObject({
      status: S.NEEDS_REVIEW,
      reasons: [R.PRICE_DECREASE],
    });
    expect(
      ev(
        { currentPrice: 2_500_000n },
        { ...DEFAULT_REVIEW_RULES, reviewDecreases: false },
      ),
    ).toMatchObject({ status: S.READY });
  });

  it('needs review for an increase above the plan threshold, and only above it', () => {
    // 2 000 000 over 1 666 667 is +19.99998 %: within the default 20 %.
    expect(ev({ currentPrice: 1_666_667n })).toMatchObject({ status: S.READY });
    // 2 000 000 over 1 600 000 is +25 %: above it.
    expect(ev({ currentPrice: 1_600_000n })).toMatchObject({
      status: S.NEEDS_REVIEW,
      reasons: [R.LARGE_INCREASE],
    });
    // The threshold is exclusive: exactly +100 % against a 100 % limit is READY,
    // and +100.0001 % is not.
    const rules = {
      ...DEFAULT_REVIEW_RULES,
      maxIncreaseBpsWithoutReview: 10_000,
    };
    expect(ev({ currentPrice: 1_000_000n }, rules)).toMatchObject({
      status: S.READY,
    });
    expect(ev({ currentPrice: 999_999n }, rules)).toMatchObject({
      status: S.NEEDS_REVIEW,
    });
  });

  it('needs review when the current price is missing or zero', () => {
    expect(ev({ currentPrice: null })).toMatchObject({
      status: S.NEEDS_REVIEW,
      reasons: [R.CURRENT_PRICE_MISSING],
    });
    expect(ev({ currentPrice: 0n })).toMatchObject({
      status: S.NEEDS_REVIEW,
      reasons: [R.CURRENT_PRICE_ZERO],
    });
  });

  it('blocks unknown and partially unknown cost, and never prices from a guess', () => {
    const unknown = ev({
      stock: 5,
      unvaluedQuantity: 5,
      averageUnitCost: null,
    });
    expect(unknown).toMatchObject({
      status: S.BLOCKED,
      reasons: [R.COST_UNKNOWN],
      costBasis: null,
    });
    const partial = ev({
      stock: 5,
      unvaluedQuantity: 2,
      averageUnitCost: 1_000_000n,
    });
    expect(partial).toMatchObject({
      status: S.BLOCKED,
      reasons: [R.COST_PARTIALLY_UNKNOWN],
    });
    const empty = ev({ stock: 0, unvaluedQuantity: 0, averageUnitCost: null });
    expect(empty).toMatchObject({
      status: S.BLOCKED,
      reasons: [R.NO_COST_BASIS],
      proposedPrice: null,
    });
    expect(ev({ averageUnitCost: 0n })).toMatchObject({
      status: S.BLOCKED,
      reasons: [R.ZERO_COST_BASIS],
    });
  });

  it('blocks inactive and unoffered variants', () => {
    expect(ev({ isActive: false })).toMatchObject({
      status: S.BLOCKED,
      reasons: [R.VARIANT_INACTIVE],
    });
    expect(ev({ offered: false })).toMatchObject({
      status: S.BLOCKED,
      reasons: [R.PRODUCT_NOT_OFFERED],
    });
  });

  it('blocks a proposed price above the single-price ceiling', () => {
    const blocked = evaluateVariant(
      { ...FACTS, averageUnitCost: MAX },
      EXAMPLE,
      DEFAULT_REVIEW_RULES,
      MAX,
    );
    expect(blocked).toMatchObject({
      status: S.BLOCKED,
      reasons: [R.PRICE_OUT_OF_RANGE],
    });
  });
});
