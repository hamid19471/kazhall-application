/**
 * Basket-level notice de-duplication.
 *
 * Lives here rather than in `components/cart/cart-view.tsx` for one reason: it
 * is pure, it is the thing that decides whether a customer is told their units
 * were sold in store, and `node --test` cannot import a `.tsx` module. The
 * same argument that put `reservation-clock.ts` in `lib/`.
 */

import type { CartLine, CartLineChange } from "@kazhal/api-client";

/**
 * Drop a basket-level notice that an ACTIVE line is already reporting.
 *
 * ## A notice is a LINE, not a change
 *
 * `GET /cart` builds `notices` as `views.filter((v) => v.change !== null)` —
 * the same `CartLineView` objects as `data`, filtered differently. This
 * function used to read `notice.reason` and `notice.at` directly, which are
 * both `undefined` on a line, so:
 *
 *  - every notice fell into one bucket keyed `undefined|undefined` and
 *    de-duplicated down to exactly one, whatever had actually happened;
 *  - nothing was ever matched against an active line, so the duplicate this
 *    function exists to remove was never removed;
 *  - and the renderer printed `formatInteger(undefined)`.
 *
 * It stayed invisible because a PARTIALLY displaced line is still in `data` and
 * shows its own `line.change`, so the broken basket-level copy was cosmetic
 * noise beside a correct message. A FULLY displaced line is not in `data` at
 * all, and then this is the only path that can tell the customer anything.
 *
 * ## The rules
 *
 * Two notices are the same event when they agree on the reason and the instant.
 * A notice with no `at` cannot be matched that way, so it is kept — losing a
 * real "your reservation expired" is worse than showing it twice.
 */
export function dedupeNotices(notices: CartLine[], lines: CartLine[]): CartLine[] {
  const activeIds = new Set(lines.map((line) => line.id));
  const onLines = new Set(
    lines
      .map((line) => line.change)
      .filter((change): change is CartLineChange => change !== null && change.at !== null)
      .map((change) => `${change.reason}|${change.at}`),
  );

  const seen = new Set<string>();
  return notices.filter((notice) => {
    const change = notice.change;
    // A notice without a change carries nothing; the server does not send one,
    // but the array is typed as lines and this keeps the renderer total.
    if (!change) return false;
    // The same LINE is already on screen rendering this exact change.
    if (activeIds.has(notice.id)) return false;
    if (change.at === null) return true;
    const key = `${change.reason}|${change.at}`;
    if (onLines.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
