/**
 * Money helpers for the admin console.
 *
 * THESE NOW LIVE IN `@kazhal/ui`. They used to be implemented here, which meant
 * `apps/store` could not reach them: the POS therefore re-implemented report
 * formatting on `number` and lost exactly the precision the API had gone to the
 * trouble of preserving. One implementation, two applications.
 *
 * This module stays as a re-export so that the ~30 existing
 * `from "@/lib/money"` imports in this app keep working unchanged, and so that
 * there is still an obvious place to put an admin-only money helper.
 *
 * The contract is unchanged: every aggregate money figure from the API is
 * INTEGER RIAL AS A STRING (`bigint` columns and `SUM()`s over them, which
 * node-postgres keeps as strings so nothing rounds). Never `Number()` one;
 * format the digits directly. Never append or remove a zero to convert between
 * Rial and Toman.
 */
export {
  addRialStrings,
  compareRialStrings,
  formatRialString,
  isZeroRialString,
  toPersianDigits,
  type RialStringOptions,
} from "@kazhal/ui";
