import { ValueTransformer } from 'typeorm';

/**
 * PostgreSQL `bigint` is returned by node-postgres as a *string* to avoid
 * silent precision loss. Every money column in this codebase is typed
 * `number` in TypeScript, so without a transformer the runtime type and the
 * declared type disagree and `+` silently concatenates.
 *
 * MONEY UNIT: all money columns store **integer Rial** (see docs/ARCHITECTURE.md).
 *
 * THE TWO DIRECTIONS ARE NOT SYMMETRICAL, AND `to` WAS THE UNGUARDED ONE.
 * `from` has always thrown above `Number.MAX_SAFE_INTEGER`, because a value
 * READ back that large means the `number` typing was a lie. `to` did
 * `Math.trunc(value)` and nothing else, which is precisely the write that
 * creates such a row:
 *
 *   - `Math.trunc(9007199254740993.5)` -> 9007199254740992, silently, and the
 *     column now holds a figure nobody asked for;
 *   - `Math.trunc(1234.56)` -> 1234, so a fractional Rial — which can only mean
 *     the producer was working in a DIFFERENT UNIT (Toman, or a percentage
 *     applied without rounding being decided) — was accepted and the 0.56 was
 *     discarded with no record that it existed;
 *   - `Math.trunc(NaN)` -> NaN, which node-postgres sends as the literal string
 *     `NaN` to a `bigint` column and fails there, far from the cause.
 *
 * Truncation is the failure mode, not the remedy: rounding money without being
 * asked to is how a total stops reconciling with the lines that produced it.
 * So `to` now REJECTS what it used to round. A caller that genuinely holds a
 * fraction has to decide what to do about it at the point where the fraction
 * was created, where the domain knows which way it should go.
 *
 * THE BOUND HERE IS `Number.MAX_SAFE_INTEGER`, NOT `MAX_RIAL`. `MAX_RIAL`
 * (src/common/money/rial.ts) bounds a SINGLE UNIT PRICE arriving over HTTP;
 * the columns this transformer serves also hold ORDER TOTALS, which are
 * legitimately up to `MAX_ORDER_RIAL` — 200 000 times larger. The only
 * invariant every one of them shares is exact representability, so that is the
 * only one asserted here. Per-field ceilings belong on the DTOs.
 */
export const bigIntTransformer: ValueTransformer = {
  to: (value?: number | null): number | null => {
    if (value === undefined || value === null) return null;
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `bigIntTransformer: refusing to write ${String(value)} to a bigint ` +
          `money column. Money is INTEGER RIAL and must be exactly ` +
          `representable; a fraction, NaN, Infinity or a magnitude above ` +
          `Number.MAX_SAFE_INTEGER would be silently rounded on the way in.`,
      );
    }
    return value;
  },
  from: (value?: string | number | null): number | null => {
    if (value === undefined || value === null) return null;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(n)) {
      throw new Error(
        `bigIntTransformer: value ${String(value)} exceeds Number.MAX_SAFE_INTEGER`,
      );
    }
    return n;
  },
};
