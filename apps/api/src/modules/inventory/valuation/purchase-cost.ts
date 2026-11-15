import { MAX_RIAL } from 'src/common/money/rial';
import { CostingErrorCodes, costingError } from './costing.errors';
import { INT8_MAX } from './valuation';

/**
 * Parses a purchase cost that arrived over HTTP.
 *
 * The DTOs declare these fields with `@Allow()` and leave the decision to this
 * function, because class-validator can only answer with a generic 400 and the
 * contract promises stable codes (docs/PURCHASE-COST-ACCOUNTING.md §11).
 *
 * MISSING IS NOT ZERO. `undefined` returns `undefined` — the caller decides
 * whether absence is allowed. `0` is a legitimate, explicit cost (free
 * inventory). `null`, `''`, fractions, exponents, negatives, unsafe integers
 * and anything above MAX_RIAL are refused, never coerced.
 *
 * Accepts a JSON number (a safe integer) or a base-10 integer string — the same
 * two shapes money already takes in and out of this API.
 */
export function parsePurchaseCost(
  raw: unknown,
  field = 'purchasePrice',
): bigint | undefined {
  if (raw === undefined) return undefined;

  let value: bigint;
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) {
      throw costingError.badRequest(CostingErrorCodes.PURCHASE_COST_INVALID, {
        field,
      });
    }
    value = BigInt(raw);
  } else if (typeof raw === 'string' && /^-?(0|[1-9][0-9]*)$/.test(raw)) {
    value = BigInt(raw);
  } else {
    throw costingError.badRequest(CostingErrorCodes.PURCHASE_COST_INVALID, {
      field,
    });
  }

  if (value < 0n || value > BigInt(MAX_RIAL)) {
    throw costingError.badRequest(
      CostingErrorCodes.PURCHASE_COST_OUT_OF_RANGE,
      { field },
    );
  }
  return value;
}

/** The same, for a required field: absence is `PURCHASE_COST_REQUIRED`. */
export function requirePurchaseCost(raw: unknown, field = 'unitCost'): bigint {
  const value = parsePurchaseCost(raw, field);
  if (value === undefined) {
    throw costingError.badRequest(CostingErrorCodes.PURCHASE_COST_REQUIRED, {
      field,
    });
  }
  return value;
}

/**
 * Parses an AGGREGATE cost — the total value of many units (the legacy
 * valuation's `totalValue`) — that arrived over HTTP.
 *
 * WHY NOT `parsePurchaseCost`. That bounds a UNIT cost at MAX_RIAL, which is
 * right for one unit and wrong for a total: 1 000 legacy units at a unit cost
 * near MAX_RIAL are a legitimate valuation far above it. The ceiling here is
 * the column's own, INT8_MAX; whether the pool can absorb the value on top of
 * what it already holds is `assertPool`'s decision, answered with the same
 * `PURCHASE_COST_OUT_OF_RANGE`.
 *
 * Same shapes, same refusals, same stable codes as `parsePurchaseCost`. A JSON
 * number is accepted only as a SAFE integer — a total above 2^53 must arrive
 * as a string, because a JSON number that large has already lost digits
 * before this function sees it.
 */
export function parseCostTotal(
  raw: unknown,
  field = 'totalValue',
): bigint | undefined {
  if (raw === undefined) return undefined;

  let value: bigint;
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) {
      throw costingError.badRequest(CostingErrorCodes.PURCHASE_COST_INVALID, {
        field,
      });
    }
    value = BigInt(raw);
  } else if (typeof raw === 'string' && /^-?(0|[1-9][0-9]*)$/.test(raw)) {
    value = BigInt(raw);
  } else {
    throw costingError.badRequest(CostingErrorCodes.PURCHASE_COST_INVALID, {
      field,
    });
  }

  if (value < 0n || value > INT8_MAX) {
    throw costingError.badRequest(
      CostingErrorCodes.PURCHASE_COST_OUT_OF_RANGE,
      { field },
    );
  }
  return value;
}
