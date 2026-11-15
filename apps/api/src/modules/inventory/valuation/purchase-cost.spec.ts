import { HttpException } from '@nestjs/common';

import { MAX_RIAL } from 'src/common/money/rial';
import { parseCostTotal, parsePurchaseCost } from './purchase-cost';
import { INT8_MAX } from './valuation';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof HttpException) {
      return (err.getResponse() as { error?: string }).error;
    }
    throw err;
  }
  return undefined;
}

describe('parseCostTotal', () => {
  it('returns undefined for a missing value — missing is not zero', () => {
    expect(parseCostTotal(undefined)).toBeUndefined();
  });

  it('accepts 0, a safe JSON integer and a base-10 string', () => {
    expect(parseCostTotal(0)).toBe(0n);
    expect(parseCostTotal(125_000)).toBe(125_000n);
    expect(parseCostTotal('125000')).toBe(125_000n);
  });

  it('accepts a total far above MAX_RIAL, up to INT8_MAX, as a string', () => {
    const above = (BigInt(MAX_RIAL) * 1_000n).toString();
    expect(parseCostTotal(above)).toBe(BigInt(above));
    expect(parseCostTotal(INT8_MAX.toString())).toBe(INT8_MAX);
    // …which the unit-cost parser rightly refuses.
    expect(codeOf(() => parsePurchaseCost(above, 'unitCost'))).toBe(
      'PURCHASE_COST_OUT_OF_RANGE',
    );
  });

  it('refuses anything above the bigint column', () => {
    expect(codeOf(() => parseCostTotal((INT8_MAX + 1n).toString()))).toBe(
      'PURCHASE_COST_OUT_OF_RANGE',
    );
  });

  it('refuses negatives as out of range', () => {
    expect(codeOf(() => parseCostTotal(-1))).toBe('PURCHASE_COST_OUT_OF_RANGE');
    expect(codeOf(() => parseCostTotal('-5'))).toBe(
      'PURCHASE_COST_OUT_OF_RANGE',
    );
  });

  it.each([null, '', ' 1', '1.5', 1.5, '1e3', '01', '+1', '1,000', {}, []])(
    'refuses %p as invalid',
    (raw) => {
      expect(codeOf(() => parseCostTotal(raw))).toBe('PURCHASE_COST_INVALID');
    },
  );

  it('refuses an unsafe JSON number — its digits are already lost', () => {
    expect(codeOf(() => parseCostTotal(2 ** 60))).toBe('PURCHASE_COST_INVALID');
  });
});
