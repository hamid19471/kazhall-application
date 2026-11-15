import {
  INT8_MAX,
  ValuationInvariantError,
  ValuationOverflowError,
  ValuationPool,
  allocate,
  assertPool,
  averageUnitCost,
  consume,
  consumeLines,
  initialise,
  percentString,
  receive,
  receiveUnvalued,
  restockSplit,
  restore,
  reverseRevenue,
  LineCostState,
} from './valuation';
import { parsePurchaseCost, requirePurchaseCost } from './purchase-cost';
import { MAX_RIAL } from 'src/common/money/rial';

const empty: ValuationPool = { stock: 0, unvaluedQuantity: 0, value: 0n };

describe('valuation pool (docs/PURCHASE-COST-ACCOUNTING.md §3)', () => {
  describe('allocate — the one rounding rule', () => {
    it('floors a partial take and gives the whole remainder to a full take', () => {
      expect(allocate(10n, 3, 1)).toBe(3n);
      expect(allocate(10n, 3, 2)).toBe(6n);
      expect(allocate(10n, 3, 3)).toBe(10n);
      expect(allocate(0n, 5, 5)).toBe(0n);
      expect(allocate(7n, 5, 0)).toBe(0n);
    });

    it('refuses to take more units than exist', () => {
      expect(() => allocate(10n, 2, 3)).toThrow(ValuationInvariantError);
    });

    it('is exact for magnitudes far beyond Number.MAX_SAFE_INTEGER', () => {
      const big = 9_000_000_000_000_000_001n;
      expect(allocate(big, 3, 1)).toBe(3_000_000_000_000_000_000n);
      expect(allocate(big, 3, 3)).toBe(big);
    });
  });

  it('reproduces the worked example in the contract exactly', () => {
    let pool = receive(empty, 3, 10_000n).pool;
    pool = receive(pool, 2, 13_001n).pool;
    expect(pool).toEqual({ stock: 5, unvaluedQuantity: 0, value: 56_002n });
    expect(averageUnitCost(pool)).toBe(11_200n);

    const a = consume(pool, 2);
    expect(a.consumption.cogs).toBe(22_400n);
    const b = consume(a.pool, 1);
    expect(b.consumption.cogs).toBe(11_200n);
    const c = consume(b.pool, 2);
    expect(c.consumption.cogs).toBe(22_402n);
    expect(c.pool).toEqual(empty);
    expect(a.consumption.cogs + b.consumption.cogs + c.consumption.cogs).toBe(
      56_002n,
    );
  });

  it('conserves every Rial across random receipts and sales (property)', () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed % n;
    };
    for (let run = 0; run < 200; run++) {
      let pool = empty;
      let received = 0n;
      let allocated = 0n;
      for (let step = 0; step < 40; step++) {
        if (pool.stock === 0 || rand(3) === 0) {
          const q = 1 + rand(9);
          const c = BigInt(rand(1_000_003));
          pool = receive(pool, q, c).pool;
          received += BigInt(q) * c;
        } else {
          const q = 1 + rand(pool.stock);
          const step2 = consume(pool, q);
          pool = step2.pool;
          allocated += step2.consumption.cogs;
        }
        assertPool(pool);
        expect(allocated + pool.value).toBe(received);
      }
      if (pool.stock > 0) {
        allocated += consume(pool, pool.stock).consumption.cogs;
      }
      expect(allocated).toBe(received);
    }
  });

  it('keeps an explicit zero cost distinct from an unknown cost', () => {
    const free = receive(empty, 4, 0n).pool;
    expect(free).toEqual({ stock: 4, unvaluedQuantity: 0, value: 0n });
    const sold = consume(free, 4).consumption;
    expect(sold).toEqual({ knownQuantity: 4, unknownQuantity: 0, cogs: 0n });

    const unknown = receiveUnvalued(empty, 4).pool;
    const soldUnknown = consume(unknown, 4).consumption;
    expect(soldUnknown).toEqual({
      knownQuantity: 0,
      unknownQuantity: 4,
      cogs: 0n,
    });
  });

  it('takes unknown-cost units first from a mixed pool (B-1)', () => {
    let pool = receiveUnvalued(empty, 2).pool;
    pool = receive(pool, 3, 1_000n).pool;
    const step = consume(pool, 3);
    expect(step.consumption).toEqual({
      knownQuantity: 1,
      unknownQuantity: 2,
      cogs: 1_000n,
    });
    expect(step.pool).toEqual({ stock: 2, unvaluedQuantity: 0, value: 2_000n });
  });

  it('restores the exact cost of returned units, not the current average', () => {
    let pool = receive(empty, 2, 1_000n).pool;
    const sale = consume(pool, 1);
    pool = receive(sale.pool, 1, 5_000n).pool; // average moved to 3 000
    pool = restore(pool, {
      knownQuantity: 1,
      cost: sale.consumption.cogs,
      unknownQuantity: 0,
    }).pool;
    expect(pool).toEqual({ stock: 3, unvaluedQuantity: 0, value: 7_000n });
  });

  it('refuses a cost restored without a known unit', () => {
    expect(() =>
      restore(empty, { knownQuantity: 0, cost: 1n, unknownQuantity: 1 }),
    ).toThrow(ValuationInvariantError);
  });

  it('initialises legacy unvalued units exactly once', () => {
    const legacy: ValuationPool = { stock: 5, unvaluedQuantity: 5, value: 0n };
    const done = initialise(legacy, 50_000n);
    expect(done.pool).toEqual({
      stock: 5,
      unvaluedQuantity: 0,
      value: 50_000n,
    });
    expect(done.valuedUnits).toBe(5);
    expect(() => initialise(done.pool, 1n)).toThrow(ValuationInvariantError);
  });

  it('rejects impossible pools', () => {
    expect(() =>
      assertPool({ stock: 1, unvaluedQuantity: 2, value: 0n }),
    ).toThrow(ValuationInvariantError);
    expect(() =>
      assertPool({ stock: 0, unvaluedQuantity: 0, value: 1n }),
    ).toThrow(ValuationInvariantError);
    expect(() =>
      assertPool({ stock: 1, unvaluedQuantity: 0, value: -1n }),
    ).toThrow(ValuationInvariantError);
    expect(() =>
      consume({ stock: 1, unvaluedQuantity: 0, value: 0n }, 2),
    ).toThrow(ValuationInvariantError);
  });

  it('refuses a value the bigint column cannot hold', () => {
    const pool: ValuationPool = {
      stock: 1,
      unvaluedQuantity: 0,
      value: INT8_MAX,
    };
    expect(() => receive(pool, 1, 1n)).toThrow(ValuationOverflowError);
    expect(() => receive(empty, 1_073_741_823, BigInt(MAX_RIAL))).toThrow(
      ValuationOverflowError,
    );
  });

  it('allocates several lines of one variant in ascending id, conserving the total', () => {
    const pool = receive(empty, 7, 1_001n).pool; // 7 007
    const out = consumeLines(pool, [
      { orderItemId: 9, quantity: 2 },
      { orderItemId: 3, quantity: 3 },
    ]);
    expect(out.allocations.map((a) => a.orderItemId)).toEqual([3, 9]);
    expect(out.allocations[0].cogs).toBe(3_003n);
    expect(out.allocations[1].cogs).toBe(2_002n);
    expect(out.pool.value + 3_003n + 2_002n).toBe(7_007n);
  });

  describe('line reversals', () => {
    const line = (over: Partial<LineCostState> = {}): LineCostState => ({
      quantity: 3,
      totalPrice: 30_000n,
      cogsTotal: 10n,
      costKnownQuantity: 3,
      costUnknownQuantity: 0,
      reversedRevenueQuantity: 0,
      reversedRevenue: 0n,
      restockedKnownQuantity: 0,
      restockedUnknownQuantity: 0,
      reversedCogs: 0n,
      ...over,
    });

    it('reverses revenue per unit and the remainder on the last unit', () => {
      expect(reverseRevenue(line({ totalPrice: 10n }), 1)).toBe(3n);
      expect(
        reverseRevenue(
          line({
            totalPrice: 10n,
            reversedRevenueQuantity: 2,
            reversedRevenue: 6n,
          }),
          1,
        ),
      ).toBe(4n);
      expect(() => reverseRevenue(line(), 4)).toThrow(ValuationInvariantError);
    });

    it('returns the line’s own COGS deterministically, never more than recognised', () => {
      const first = restockSplit(line(), 1);
      expect(first).toEqual({
        knownQuantity: 1,
        unknownQuantity: 0,
        cogsReversed: 3n,
      });
      const second = restockSplit(
        line({ restockedKnownQuantity: 1, reversedCogs: 3n }),
        2,
      );
      expect(second.cogsReversed).toBe(7n);
      expect(first.cogsReversed + second.cogsReversed).toBe(10n);
      expect(() =>
        restockSplit(line({ restockedKnownQuantity: 3, reversedCogs: 10n }), 1),
      ).toThrow(ValuationInvariantError);
    });

    it('brings unknown-cost units of a mixed line back first', () => {
      const mixed = line({
        cogsTotal: 500n,
        costKnownQuantity: 1,
        costUnknownQuantity: 2,
      });
      expect(restockSplit(mixed, 2)).toEqual({
        knownQuantity: 0,
        unknownQuantity: 2,
        cogsReversed: 0n,
      });
      expect(restockSplit(mixed, 3)).toEqual({
        knownQuantity: 1,
        unknownQuantity: 2,
        cogsReversed: 500n,
      });
    });
  });

  describe('percentString', () => {
    it('is null for zero or negative revenue, never Infinity or NaN', () => {
      expect(percentString(5n, 0n)).toBeNull();
      expect(percentString(5n, -10n)).toBeNull();
    });

    it('rounds half away from zero to two decimals', () => {
      expect(percentString(1n, 3n)).toBe('33.33');
      expect(percentString(2n, 3n)).toBe('66.67');
      expect(percentString(12_345n, 100_000n)).toBe('12.35');
      expect(percentString(-1n, 3n)).toBe('-33.33');
      expect(percentString(0n, 7n)).toBe('0.00');
      expect(percentString(7n, 7n)).toBe('100.00');
    });
  });
});

describe('parsePurchaseCost', () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as { getResponse(): { error: string } }).getResponse().error;
    }
    return 'no error';
  };

  it('distinguishes missing from an explicit zero', () => {
    expect(parsePurchaseCost(undefined)).toBeUndefined();
    expect(parsePurchaseCost(0)).toBe(0n);
    expect(parsePurchaseCost('0')).toBe(0n);
    expect(code(() => requirePurchaseCost(undefined))).toBe(
      'PURCHASE_COST_REQUIRED',
    );
  });

  it('accepts safe integers and base-10 strings up to MAX_RIAL', () => {
    expect(parsePurchaseCost(125_000)).toBe(125_000n);
    expect(parsePurchaseCost(String(MAX_RIAL))).toBe(BigInt(MAX_RIAL));
  });

  it('refuses fractional, malformed, null and unsafe values', () => {
    for (const bad of [
      1.5,
      NaN,
      Infinity,
      null,
      '',
      '1e3',
      '01',
      ' 5',
      '5.0',
      {},
      [],
      true,
      2 ** 53,
    ]) {
      expect(code(() => parsePurchaseCost(bad))).toBe('PURCHASE_COST_INVALID');
    }
  });

  it('refuses negatives and values above MAX_RIAL as out of range', () => {
    expect(code(() => parsePurchaseCost(-1))).toBe(
      'PURCHASE_COST_OUT_OF_RANGE',
    );
    expect(code(() => parsePurchaseCost(MAX_RIAL + 1))).toBe(
      'PURCHASE_COST_OUT_OF_RANGE',
    );
  });
});
