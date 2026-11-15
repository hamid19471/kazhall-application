/**
 * Monthly cost-recovery pricing — the ONE pure module that does the arithmetic.
 *
 * Contract: docs/MONTHLY-PRICING.md. Everything here is exact integer
 * arithmetic in BigInt. Money is integer Rial; rates are integer BASIS POINTS
 * (1 bp = 0.01 %, so 10 % = 1000 bp). No JavaScript `number` ever carries a
 * Rial amount or a rate through a division.
 *
 * ============================================================================
 * METHOD `TARGET_REVENUE`, FORMULA VERSION 1
 * ============================================================================
 *
 *   operatingCostRate = C / R                      (C = monthly costs, R = target revenue)
 *   denominator       = 1 − C/R − t − p            (t = tax rate, p = target profit margin)
 *   rawPrice          = cost / denominator
 *   proposedPrice     = ⌈rawPrice / step⌉ × step   (ROUNDED UP to the step)
 *
 * The operating-cost rate, the tax rate and the profit margin are all shares
 * of the FINAL SELLING PRICE (of revenue), not mark-ups on cost: a 20 % margin
 * means 20 % of every Rial the customer pays is profit. With C/R = 20 %,
 * t = 10 %, p = 20 % and a cost of 1 000 000 the denominator is 50 % and the
 * price is 2 000 000, which splits exactly as
 *
 *   400 000 (20 %) operating cost + 200 000 (10 %) tax
 *   + 400 000 (20 %) profit + 1 000 000 (50 %) purchase cost = 2 000 000.
 *
 * With every rate expressed over a common denominator of 10 000·R:
 *
 *   denominator = (10000·R − 10000·C − (t + p)·R) / (10000·R)
 *   rawPrice    = cost × 10000·R / (10000·R − 10000·C − (t + p)·R)
 *
 * so the price is one exact rational number, and rounding happens exactly
 * once, upward, directly from that rational — never from an already-rounded
 * intermediate. Rounding UP is deliberate: it can only increase the covered
 * share, so rounding can never erode the configured coverage or margin.
 *
 * This is a PRICING TARGET. The configured monthly costs are covered only if
 * actual monthly revenue reaches R; nothing here predicts or guarantees sales.
 * ============================================================================
 */

export const PRICING_METHOD = {
  TARGET_REVENUE: 'TARGET_REVENUE',
} as const;
export type PricingMethod =
  (typeof PRICING_METHOD)[keyof typeof PRICING_METHOD];

/**
 * Bumped whenever the arithmetic or the eligibility rules below change
 * meaning. Every plan, calculation run and preview item stores the version it
 * was computed with, so a historical plan keeps its original meaning after a
 * later version (or a later method such as `PRODUCT_SALES_FORECAST`) exists.
 */
export const TARGET_REVENUE_FORMULA_VERSION = 1;

export const BPS_PER_UNIT = 10_000n;

/** 100 % in basis points. */
export const FULL_RATE_BPS = 10_000;

/**
 * Ceiling for plan-level Rial amounts (a cost entry, the monthly total, the
 * revenue target). Deliberately NOT `MAX_RIAL`, which bounds a single price:
 * a month's revenue target can legitimately exceed one item's price ceiling.
 * 10^15 Rial keeps every intermediate product far inside PostgreSQL bigint.
 */
export const MAX_PLAN_RIAL = 1_000_000_000_000_000n;

/** Rounding step bounds: 1 Rial up to 10 000 000 Rial. */
export const MIN_ROUNDING_STEP_RIAL = 1n;
export const MAX_ROUNDING_STEP_RIAL = 10_000_000n;

export interface TargetRevenueInputs {
  monthlyCostsTotalRial: bigint;
  targetMonthlyRevenueRial: bigint;
  taxRateBps: number;
  targetProfitMarginBps: number;
  roundingStepRial: bigint;
}

/** Why a set of inputs cannot produce a price. Stable codes for the API. */
export const PRICING_INPUT_PROBLEMS = {
  TARGET_REVENUE_NOT_POSITIVE: 'PRICING_TARGET_REVENUE_NOT_POSITIVE',
  AMOUNT_NEGATIVE: 'PRICING_AMOUNT_NEGATIVE',
  AMOUNT_TOO_LARGE: 'PRICING_AMOUNT_TOO_LARGE',
  TAX_RATE_OUT_OF_RANGE: 'PRICING_TAX_RATE_OUT_OF_RANGE',
  PROFIT_MARGIN_OUT_OF_RANGE: 'PRICING_PROFIT_MARGIN_OUT_OF_RANGE',
  ROUNDING_STEP_INVALID: 'PRICING_ROUNDING_STEP_INVALID',
  DENOMINATOR_NOT_POSITIVE: 'PRICING_DENOMINATOR_NOT_POSITIVE',
} as const;
export type PricingInputProblem =
  (typeof PRICING_INPUT_PROBLEMS)[keyof typeof PRICING_INPUT_PROBLEMS];

/**
 * The exact denominator `1 − C/R − t − p`, as `numerator / denominator` over
 * 10 000·R. The numerator is positive for every usable plan.
 */
export interface PricingDenominator {
  numerator: bigint;
  denominator: bigint;
}

export function pricingDenominator(
  inputs: TargetRevenueInputs,
): PricingDenominator {
  const R = inputs.targetMonthlyRevenueRial;
  const C = inputs.monthlyCostsTotalRial;
  const rates = BigInt(inputs.taxRateBps + inputs.targetProfitMarginBps);
  return {
    numerator: BPS_PER_UNIT * R - BPS_PER_UNIT * C - rates * R,
    denominator: BPS_PER_UNIT * R,
  };
}

/**
 * Every reason these inputs are unusable, in a stable order. Empty = usable.
 * The denominator rule is checked only when the parts it is built from are
 * themselves valid, so the manager is told the root cause first.
 */
export function inputProblems(
  inputs: TargetRevenueInputs,
): PricingInputProblem[] {
  const problems: PricingInputProblem[] = [];
  const P = PRICING_INPUT_PROBLEMS;

  if (
    inputs.monthlyCostsTotalRial < 0n ||
    inputs.targetMonthlyRevenueRial < 0n
  ) {
    problems.push(P.AMOUNT_NEGATIVE);
  }
  if (
    inputs.monthlyCostsTotalRial > MAX_PLAN_RIAL ||
    inputs.targetMonthlyRevenueRial > MAX_PLAN_RIAL
  ) {
    problems.push(P.AMOUNT_TOO_LARGE);
  }
  if (inputs.targetMonthlyRevenueRial <= 0n) {
    problems.push(P.TARGET_REVENUE_NOT_POSITIVE);
  }
  if (!isRateBps(inputs.taxRateBps)) problems.push(P.TAX_RATE_OUT_OF_RANGE);
  if (!isRateBps(inputs.targetProfitMarginBps)) {
    problems.push(P.PROFIT_MARGIN_OUT_OF_RANGE);
  }
  if (
    inputs.roundingStepRial < MIN_ROUNDING_STEP_RIAL ||
    inputs.roundingStepRial > MAX_ROUNDING_STEP_RIAL
  ) {
    problems.push(P.ROUNDING_STEP_INVALID);
  }

  if (problems.length === 0 && pricingDenominator(inputs).numerator <= 0n) {
    problems.push(P.DENOMINATOR_NOT_POSITIVE);
  }
  return problems;
}

/** A tax or profit rate: an integer number of basis points in [0, 100 %). */
export function isRateBps(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < FULL_RATE_BPS;
}

/** ⌈a / b⌉ for a ≥ 0, b > 0, in BigInt. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError('ceilDiv: divisor must be positive');
  if (a < 0n) throw new RangeError('ceilDiv: dividend must not be negative');
  return (a + b - 1n) / b;
}

export interface TargetRevenuePrice {
  /**
   * The exact raw price rounded UP at 4 decimal places, as a decimal string
   * ("1234567.8901"). Stored for display and audit; the proposed price is NOT
   * derived from it (it is derived from the exact rational).
   */
  rawPrice: string;
  /** ⌈raw / step⌉ × step, integer Rial. */
  proposedPrice: bigint;
}

/** Scale of the stored raw price: 4 decimal places. */
export const RAW_PRICE_SCALE = 4;
const RAW_PRICE_FACTOR = 10n ** BigInt(RAW_PRICE_SCALE);

/**
 * The price for one variant of known weighted-average cost.
 *
 * Throws on unusable inputs — callers validate with `inputProblems` first; a
 * throw here is a programming error, not a user error.
 */
export function targetRevenuePrice(
  costBasisRial: bigint,
  inputs: TargetRevenueInputs,
): TargetRevenuePrice {
  if (costBasisRial < 0n)
    throw new RangeError('cost basis must not be negative');
  const problems = inputProblems(inputs);
  if (problems.length > 0) {
    throw new RangeError(`unusable pricing inputs: ${problems.join(', ')}`);
  }
  const { numerator, denominator } = pricingDenominator(inputs);

  // raw = cost × denominator / numerator  (the reciprocal of `1 − C/R − t − p`)
  const rawNumerator = costBasisRial * denominator;
  const rawScaled = ceilDiv(rawNumerator * RAW_PRICE_FACTOR, numerator);
  const step = inputs.roundingStepRial;
  const proposedPrice = ceilDiv(rawNumerator, numerator * step) * step;

  return { rawPrice: fixedPoint(rawScaled, RAW_PRICE_SCALE), proposedPrice };
}

/** An integer scaled by 10^scale, written as a plain decimal string. */
export function fixedPoint(scaled: bigint, scale: number): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const factor = 10n ** BigInt(scale);
  const whole = abs / factor;
  const frac = (abs % factor).toString().padStart(scale, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${frac}`;
}

// ---------------------------------------------------------------------------
// Rates as text
// ---------------------------------------------------------------------------

const PERCENT_TEXT = /^(\d{1,3})(?:\.(\d{1,2}))?$/;

/**
 * A percent written as text ("10", "12.5", "33.33") → basis points (1000,
 * 1250, 3333). Parsed digit by digit: a rate never passes through a float.
 * `null` for anything that is not 0–3 integer digits with at most two decimals.
 */
export function percentTextToBps(text: string): number | null {
  const match = PERCENT_TEXT.exec(text.trim());
  if (!match) return null;
  const whole = Number(match[1]);
  const frac = Number((match[2] ?? '').padEnd(2, '0'));
  return whole * 100 + frac;
}

/** Basis points → a two-decimal percent string: 1250 → "12.50". */
export function bpsToPercentText(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = String(bps % 100).padStart(2, '0');
  return `${whole}.${frac}`;
}

// ---------------------------------------------------------------------------
// Eligibility and review classification
// ---------------------------------------------------------------------------

export const PRICING_ITEM_STATUS = {
  READY: 'READY',
  UNCHANGED: 'UNCHANGED',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  BLOCKED: 'BLOCKED',
} as const;
export type PricingItemStatus =
  (typeof PRICING_ITEM_STATUS)[keyof typeof PRICING_ITEM_STATUS];

/**
 * Why a row is blocked, needs review, or carries a note. BLOCKED reasons
 * describe the DATA (fix it and recalculate); REVIEW reasons describe the
 * CHANGE (a person may approve it as it is).
 */
export const PRICING_REASON = {
  // blocked
  VARIANT_INACTIVE: 'VARIANT_INACTIVE',
  PRODUCT_NOT_OFFERED: 'PRODUCT_NOT_OFFERED',
  COST_UNKNOWN: 'COST_UNKNOWN',
  COST_PARTIALLY_UNKNOWN: 'COST_PARTIALLY_UNKNOWN',
  NO_COST_BASIS: 'NO_COST_BASIS',
  ZERO_COST_BASIS: 'ZERO_COST_BASIS',
  PRICE_OUT_OF_RANGE: 'PRICE_OUT_OF_RANGE',
  STALE: 'STALE',
  // review
  CURRENT_PRICE_MISSING: 'CURRENT_PRICE_MISSING',
  CURRENT_PRICE_ZERO: 'CURRENT_PRICE_ZERO',
  PRICE_DECREASE: 'PRICE_DECREASE',
  LARGE_INCREASE: 'LARGE_INCREASE',
} as const;
export type PricingReason =
  (typeof PRICING_REASON)[keyof typeof PRICING_REASON];

export const BLOCKING_REASONS: ReadonlySet<PricingReason> = new Set([
  PRICING_REASON.VARIANT_INACTIVE,
  PRICING_REASON.PRODUCT_NOT_OFFERED,
  PRICING_REASON.COST_UNKNOWN,
  PRICING_REASON.COST_PARTIALLY_UNKNOWN,
  PRICING_REASON.NO_COST_BASIS,
  PRICING_REASON.ZERO_COST_BASIS,
  PRICING_REASON.PRICE_OUT_OF_RANGE,
  PRICING_REASON.STALE,
]);

export interface ReviewRules {
  /** An increase above this many basis points needs review. */
  maxIncreaseBpsWithoutReview: number;
  /** Any decrease needs review. */
  reviewDecreases: boolean;
}

export const DEFAULT_REVIEW_RULES: ReviewRules = {
  maxIncreaseBpsWithoutReview: 2_000, // 20 %
  reviewDecreases: true,
};

/** The live facts about one variant that the calculation reads. */
export interface VariantPricingFacts {
  isActive: boolean;
  /** Offered anywhere: on the site OR at one or more branches. */
  offered: boolean;
  stock: number;
  unvaluedQuantity: number;
  /** The exact weighted average, `null` when no unit is valued. */
  averageUnitCost: bigint | null;
  /** `product_variants.price`, the price every sale path charges. */
  currentPrice: bigint | null;
}

export interface ItemEvaluation {
  status: PricingItemStatus;
  reasons: PricingReason[];
  costBasis: bigint | null;
  rawPrice: string | null;
  proposedPrice: bigint | null;
}

/**
 * Classify one variant. Pure: the same facts and inputs always give the same
 * row, which is what lets a stale check be a comparison of facts.
 *
 * `maxPriceRial` is the single-price ceiling (`MAX_RIAL`) passed in so this
 * module stays free of Nest imports.
 */
export function evaluateVariant(
  facts: VariantPricingFacts,
  inputs: TargetRevenueInputs,
  rules: ReviewRules,
  maxPriceRial: bigint,
): ItemEvaluation {
  const R = PRICING_REASON;
  const blocked: PricingReason[] = [];

  if (!facts.isActive) blocked.push(R.VARIANT_INACTIVE);
  if (!facts.offered) blocked.push(R.PRODUCT_NOT_OFFERED);

  const valued = facts.stock - facts.unvaluedQuantity;
  let costBasis: bigint | null = facts.averageUnitCost;
  if (facts.unvaluedQuantity > 0 && valued > 0) {
    // Some units of unknown cost: the average describes only part of the shelf.
    blocked.push(R.COST_PARTIALLY_UNKNOWN);
  } else if (facts.unvaluedQuantity > 0) {
    blocked.push(R.COST_UNKNOWN);
    costBasis = null;
  } else if (costBasis === null) {
    // Nothing on the shelf, so there is no weighted average to price from.
    blocked.push(R.NO_COST_BASIS);
  } else if (costBasis === 0n) {
    blocked.push(R.ZERO_COST_BASIS);
  }

  let rawPrice: string | null = null;
  let proposedPrice: bigint | null = null;
  if (costBasis !== null && costBasis > 0n) {
    const priced = targetRevenuePrice(costBasis, inputs);
    rawPrice = priced.rawPrice;
    proposedPrice = priced.proposedPrice;
    if (proposedPrice > maxPriceRial) blocked.push(R.PRICE_OUT_OF_RANGE);
  }

  if (blocked.length > 0 || proposedPrice === null) {
    return {
      status: PRICING_ITEM_STATUS.BLOCKED,
      reasons: blocked,
      costBasis,
      rawPrice,
      proposedPrice,
    };
  }

  const review: PricingReason[] = [];
  const current = facts.currentPrice;
  if (current === null) {
    review.push(R.CURRENT_PRICE_MISSING);
  } else if (current === 0n) {
    review.push(R.CURRENT_PRICE_ZERO);
  } else if (proposedPrice === current) {
    return {
      status: PRICING_ITEM_STATUS.UNCHANGED,
      reasons: [],
      costBasis,
      rawPrice,
      proposedPrice,
    };
  } else if (proposedPrice < current) {
    if (rules.reviewDecreases) review.push(R.PRICE_DECREASE);
  } else {
    // increase in basis points of the current price, compared exactly
    const increase = proposedPrice - current;
    if (
      increase * BPS_PER_UNIT >
      BigInt(rules.maxIncreaseBpsWithoutReview) * current
    ) {
      review.push(R.LARGE_INCREASE);
    }
  }

  return {
    status:
      review.length > 0
        ? PRICING_ITEM_STATUS.NEEDS_REVIEW
        : PRICING_ITEM_STATUS.READY,
    reasons: review,
    costBasis,
    rawPrice,
    proposedPrice,
  };
}
