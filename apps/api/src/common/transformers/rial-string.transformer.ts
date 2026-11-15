import { ValueTransformer } from 'typeorm';
import { toRial } from 'src/common/money/rial';

/**
 * A `bigint` money column read and written as an exact base-10 STRING.
 *
 * `bigIntTransformer` narrows to a JavaScript `number` and throws above
 * `Number.MAX_SAFE_INTEGER`. That is right for a unit price, which is bounded
 * by MAX_RIAL, and wrong for an inventory VALUE, which is a total over up to
 * MAX_STOCK_UNITS units and can legitimately exceed 2^53 − 1 while still
 * fitting PostgreSQL `bigint`. Cost columns therefore never become a `number`
 * at all: arithmetic on them is `BigInt` in `valuation.ts`, and this
 * transformer only normalises the string on the way in and out.
 */
export const rialStringTransformer: ValueTransformer = {
  to: (value?: string | bigint | number | null): string | null | undefined => {
    // UNSET STAYS UNSET. Returning null here would make TypeORM write an
    // explicit NULL instead of letting the column DEFAULT apply — which for
    // `inventoryCostValue` is a NOT NULL violation, and for a nullable cost
    // column would be indistinguishable from "deliberately cleared".
    if (value === undefined) return undefined;
    if (value === null) return null;
    return toRial(value);
  },
  from: (value?: string | number | null): string | null => {
    if (value === undefined || value === null) return null;
    return toRial(value);
  },
};
