/**
 * ===========================================================================
 * THE VALUATION POOL — every cost calculation in this system, and nothing else.
 * ===========================================================================
 *
 * Contract: docs/PURCHASE-COST-ACCOUNTING.md §3. Perpetual moving weighted
 * average per exact variant, kept as an EXACT integer-Rial total rather than a
 * rounded average, so re-averaging a rounded figure can never drift.
 *
 * Every function here is pure and works in `bigint`. SQL only ever stores what
 * these return (compare-and-set, see `InventoryService.writePool`), and nothing
 * outside this file multiplies, divides or subtracts a cost.
 *
 * THE POOL
 *
 *   stock             physical units on the variant
 *   unvaluedQuantity  units whose purchase cost is NOT known (legacy stock,
 *                     explicit unknown-cost corrections). Never valued at 0.
 *   value             Rial value of the other `stock − unvaluedQuantity` units
 *
 * THE ONE ROUNDING RULE (`allocate`)
 *
 *   taking all remaining units  → the whole remaining value
 *   taking some                 → floor(value × taken / units)
 *
 * so no Rial is created or lost, the pool never goes negative, and the
 * remainder of each floor stays in the pool until the last unit takes it.
 */

/** PostgreSQL `bigint` ceiling. A pool value above it cannot be stored. */
export const INT8_MAX = 9_223_372_036_854_775_807n;

export interface ValuationPool {
  stock: number;
  unvaluedQuantity: number;
  value: bigint;
}

/** A breach of the pool's own invariants — a programming error, never input. */
export class ValuationInvariantError extends Error {
  constructor(message: string) {
    super(`valuation invariant: ${message}`);
    this.name = 'ValuationInvariantError';
  }
}

/** A value that would not fit the database column. Input-driven, so a 400. */
export class ValuationOverflowError extends Error {
  constructor(readonly attempted: bigint) {
    super(`inventory value ${attempted.toString()} exceeds the bigint column`);
    this.name = 'ValuationOverflowError';
  }
}

function assertCount(name: string, n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new ValuationInvariantError(
      `${name} must be a non-negative integer, got ${String(n)}`,
    );
  }
}

function assertMoney(name: string, v: bigint): void {
  if (typeof v !== 'bigint' || v < 0n) {
    throw new ValuationInvariantError(
      `${name} must be a non-negative bigint, got ${String(v)}`,
    );
  }
}

/** Throws unless `pool` satisfies every invariant the CHECK constraints enforce. */
export function assertPool(pool: ValuationPool): void {
  assertCount('stock', pool.stock);
  assertCount('unvaluedQuantity', pool.unvaluedQuantity);
  assertMoney('value', pool.value);
  if (pool.unvaluedQuantity > pool.stock) {
    throw new ValuationInvariantError(
      `unvaluedQuantity ${pool.unvaluedQuantity} exceeds stock ${pool.stock}`,
    );
  }
  if (valuedQuantity(pool) === 0 && pool.value !== 0n) {
    throw new ValuationInvariantError(
      `no valued units but value is ${pool.value.toString()}`,
    );
  }
  if (pool.value > INT8_MAX) throw new ValuationOverflowError(pool.value);
}

export function valuedQuantity(pool: ValuationPool): number {
  return pool.stock - pool.unvaluedQuantity;
}

/**
 * The one rounding rule. `take` of `units` from a total of `total`.
 * Deterministic, remainder-preserving, and exact when `take === units`.
 */
export function allocate(total: bigint, units: number, take: number): bigint {
  assertMoney('total', total);
  assertCount('units', units);
  assertCount('take', take);
  if (take > units) {
    throw new ValuationInvariantError(`cannot take ${take} of ${units} units`);
  }
  if (take === 0) return 0n;
  if (take === units) return total;
  return (total * BigInt(take)) / BigInt(units); // BigInt division floors for non-negatives
}

/**
 * Display-only moving average: floor(value / valued units), or null for an
 * empty valued pool. NEVER stored and never used to cost anything — `allocate`
 * on the exact total is what costs a sale.
 */
export function averageUnitCost(pool: ValuationPool): bigint | null {
  const units = valuedQuantity(pool);
  return units === 0 ? null : pool.value / BigInt(units);
}

function checked(pool: ValuationPool): ValuationPool {
  assertPool(pool);
  return pool;
}

/** Units received at a known unit cost (a receipt, an opening balance). */
export function receive(
  pool: ValuationPool,
  quantity: number,
  unitCost: bigint,
): { pool: ValuationPool; costDelta: bigint } {
  assertPool(pool);
  assertCount('quantity', quantity);
  assertMoney('unitCost', unitCost);
  if (quantity === 0)
    throw new ValuationInvariantError('receive needs quantity > 0');
  const costDelta = unitCost * BigInt(quantity);
  return {
    pool: checked({
      stock: pool.stock + quantity,
      unvaluedQuantity: pool.unvaluedQuantity,
      value: pool.value + costDelta,
    }),
    costDelta,
  };
}

/** Units added with an EXPLICITLY unknown cost. Never valued at zero. */
export function receiveUnvalued(
  pool: ValuationPool,
  quantity: number,
): { pool: ValuationPool } {
  assertPool(pool);
  assertCount('quantity', quantity);
  if (quantity === 0)
    throw new ValuationInvariantError('receiveUnvalued needs quantity > 0');
  return {
    pool: checked({
      stock: pool.stock + quantity,
      unvaluedQuantity: pool.unvaluedQuantity + quantity,
      value: pool.value,
    }),
  };
}

export interface Consumption {
  /** Units that left with a known cost. */
  knownQuantity: number;
  /** Units that left with an unknown cost (taken first — contract §3.2). */
  unknownQuantity: number;
  /** Exact Rial cost of the known units. */
  cogs: bigint;
}

/**
 * Units leaving the pool: a sale, a negative correction.
 *
 * Unknown-cost units leave FIRST (owner decision B-1), then the known cost of
 * the rest is `allocate`d from the valued part of the pool.
 */
export function consume(
  pool: ValuationPool,
  quantity: number,
): { pool: ValuationPool; consumption: Consumption } {
  assertPool(pool);
  assertCount('quantity', quantity);
  if (quantity === 0)
    throw new ValuationInvariantError('consume needs quantity > 0');
  if (quantity > pool.stock) {
    throw new ValuationInvariantError(
      `cannot consume ${quantity} of ${pool.stock} units`,
    );
  }
  const unknownQuantity = Math.min(quantity, pool.unvaluedQuantity);
  const knownQuantity = quantity - unknownQuantity;
  const cogs = allocate(pool.value, valuedQuantity(pool), knownQuantity);
  return {
    pool: checked({
      stock: pool.stock - quantity,
      unvaluedQuantity: pool.unvaluedQuantity - unknownQuantity,
      value: pool.value - cogs,
    }),
    consumption: { knownQuantity, unknownQuantity, cogs },
  };
}

/**
 * Units coming back with the EXACT cost they left with (a return, a void).
 * Never re-costed at the current average.
 */
export function restore(
  pool: ValuationPool,
  input: { knownQuantity: number; cost: bigint; unknownQuantity: number },
): { pool: ValuationPool } {
  assertPool(pool);
  assertCount('knownQuantity', input.knownQuantity);
  assertCount('unknownQuantity', input.unknownQuantity);
  assertMoney('cost', input.cost);
  if (input.knownQuantity + input.unknownQuantity === 0) {
    throw new ValuationInvariantError('restore needs at least one unit');
  }
  if (input.knownQuantity === 0 && input.cost !== 0n) {
    throw new ValuationInvariantError('cost restored without a known unit');
  }
  return {
    pool: checked({
      stock: pool.stock + input.knownQuantity + input.unknownQuantity,
      unvaluedQuantity: pool.unvaluedQuantity + input.unknownQuantity,
      value: pool.value + input.cost,
    }),
  };
}

/** Values every currently-unvalued unit at `totalValue` (legacy initialisation). */
export function initialise(
  pool: ValuationPool,
  totalValue: bigint,
): { pool: ValuationPool; valuedUnits: number } {
  assertPool(pool);
  assertMoney('totalValue', totalValue);
  if (pool.unvaluedQuantity === 0) {
    throw new ValuationInvariantError('nothing to initialise');
  }
  return {
    pool: checked({
      stock: pool.stock,
      unvaluedQuantity: 0,
      value: pool.value + totalValue,
    }),
    valuedUnits: pool.unvaluedQuantity,
  };
}

// ===========================================================================
// ORDER LINES
// ===========================================================================

export interface LineDemand {
  orderItemId: number;
  quantity: number;
}

export interface LineAllocation extends Consumption {
  orderItemId: number;
}

/**
 * Consumes several lines of ONE variant from its pool, sequentially in
 * ascending `orderItemId`, so the split is reproducible whatever order the
 * caller passed. Σ cogs over the lines equals the pool's value decrease.
 */
export function consumeLines(
  pool: ValuationPool,
  lines: readonly LineDemand[],
): { pool: ValuationPool; allocations: LineAllocation[] } {
  const ordered = [...lines].sort((a, b) => a.orderItemId - b.orderItemId);
  let current = pool;
  const allocations: LineAllocation[] = [];
  for (const line of ordered) {
    const step = consume(current, line.quantity);
    current = step.pool;
    allocations.push({ orderItemId: line.orderItemId, ...step.consumption });
  }
  return { pool: current, allocations };
}

// ===========================================================================
// REVERSALS OF ONE LINE
// ===========================================================================

/** What a line recognised at consumption, and what has been reversed since. */
export interface LineCostState {
  quantity: number;
  totalPrice: bigint;
  /** null for a pending line (never consumed) or a legacy line. */
  cogsTotal: bigint | null;
  costKnownQuantity: number;
  costUnknownQuantity: number;
  reversedRevenueQuantity: number;
  reversedRevenue: bigint;
  restockedKnownQuantity: number;
  restockedUnknownQuantity: number;
  reversedCogs: bigint;
}

/** Revenue reversed for `units` more units of the line (contract §5). */
export function reverseRevenue(line: LineCostState, units: number): bigint {
  const remainingUnits = line.quantity - line.reversedRevenueQuantity;
  if (units > remainingUnits) {
    throw new ValuationInvariantError(
      `revenue for ${units} unit(s) requested, ${remainingUnits} remain`,
    );
  }
  return allocate(
    line.totalPrice - line.reversedRevenue,
    remainingUnits,
    units,
  );
}

export interface RestockSplit {
  knownQuantity: number;
  unknownQuantity: number;
  cogsReversed: bigint;
}

/**
 * How `units` returned units of a line split into known/unknown cost, and the
 * exact COGS they carry back. Unknown-cost units come back first (B-1), and
 * the known part is `allocate`d from what the line has not yet reversed.
 */
export function restockSplit(line: LineCostState, units: number): RestockSplit {
  const knownLeft = line.costKnownQuantity - line.restockedKnownQuantity;
  const unknownLeft = line.costUnknownQuantity - line.restockedUnknownQuantity;
  if (units > knownLeft + unknownLeft) {
    throw new ValuationInvariantError(
      `restock of ${units} unit(s) requested, ${knownLeft + unknownLeft} remain`,
    );
  }
  const unknownQuantity = Math.min(units, unknownLeft);
  const knownQuantity = units - unknownQuantity;
  const cogsLeft = (line.cogsTotal ?? 0n) - line.reversedCogs;
  return {
    knownQuantity,
    unknownQuantity,
    cogsReversed: allocate(cogsLeft, knownLeft, knownQuantity),
  };
}

// ===========================================================================
// PERCENTAGES
// ===========================================================================

/**
 * `numerator / denominator × 100` as a string with two decimals, rounded half
 * away from zero, in BigInt. `null` when the denominator is not positive —
 * a margin on zero or negative revenue is undefined, not 0 and not Infinity.
 */
export function percentString(
  numerator: bigint,
  denominator: bigint,
): string | null {
  if (denominator <= 0n) return null;
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  // basis points ×10 so the last digit decides rounding
  const scaled = (abs * 100_000n) / denominator; // percent × 1000
  const rounded = (scaled + 5n) / 10n; // percent × 100, half-up on magnitude
  const whole = rounded / 100n;
  const frac = (rounded % 100n).toString().padStart(2, '0');
  const body = `${whole.toString()}.${frac}`;
  return negative && rounded !== 0n ? `-${body}` : body;
}
