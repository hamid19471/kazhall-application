/**
 * ===========================================================================
 * THE ONE PLACE THAT DECIDES WHAT EACH CHANNEL CAN SELL
 * ===========================================================================
 *
 * Before this module there were FIVE live, mutually incompatible definitions of
 * "in stock", and which one you got depended on which endpoint you asked:
 *
 *   1. physical only              `v.stock > 0`
 *   2. physical + active          `v."isActive" AND v.stock > 0`
 *   3. committed balance only     `balanceAfter > 0`   (ignored `isActive`)
 *   4. web-available              `availableForBasket > 0`
 *   5. POS-available              `availableForPos > 0`
 *
 * The visible consequences were not subtle. `GET /products` answered
 * `inStock: true` for a variant whose every unit was held by other customers'
 * baskets, while `GET /products/:id` answered `inStock: false` for the same
 * variant in the same second — definitions 2 and 4 disagreeing about one row.
 * And a void or a return restoring units to a RETIRED variant announced
 * `inStock: true`, because the reversal paths used definition 3.
 *
 * So the arithmetic lives here once, and every channel derives its answer from
 * the same {@link AvailabilityFacts}.
 *
 * ## The two sellability questions are genuinely different
 *
 * They are not two renderings of one number, which is why a single `inStock`
 * boolean could never have been correct for both:
 *
 *  - **Online** sellability subtracts basket reservations AND order
 *    allocations. A unit another customer is holding is not one this customer
 *    can buy.
 *  - **In-store** sellability subtracts ONLY order allocations. A cashier at
 *    the counter outranks a basket hold — that is the POS-priority rule the
 *    whole inventory design is built on — so a basket reservation must never
 *    make a variant look unsellable to the till. An order ALLOCATION is
 *    different: it belongs to a paid or checking-out order and POS may not take
 *    it (`pos-displacement.int-spec.ts` pins this).
 *
 * ## `isActive` participates, and `products` has no say
 *
 * A retired variant sells through neither channel however many units sit on the
 * shelf. `product_variants.isActive` is therefore part of both answers.
 *
 * There is deliberately NO product-level term: `products` has no `isActive` and
 * no `deactivatedAt` column in this schema (see `product.entity.ts`), so
 * product-level deactivation does not exist and cannot be consulted. Retiring
 * every variant is how a product is withdrawn. If a product-level flag is ever
 * added, {@link deriveAvailability} is the one function that has to learn about
 * it.
 *
 * ## What this module does NOT do
 *
 * It does not change the GATES. `InventoryService` decides what may be
 * reserved, sold or adjusted under a row lock, using the raw unclamped
 * arithmetic, and those decisions are pinned by the concurrency and
 * displacement suites. This module renders the same facts for REPORTING and
 * for INVALIDATION, where clamping at zero and honouring `isActive` are what a
 * caller actually wants. Keeping the two apart is why centralising the
 * booleans could be done without touching a single gate.
 */

/**
 * The raw, committed facts about one variant. Every field comes from the
 * database; nothing here is derived.
 */
export interface AvailabilityFacts {
  variantId: number;
  productId: number;
  /** `product_variants.isActive` — a retired variant sells nowhere. */
  isActive: boolean;
  /** `product_variants.stock` — units physically on the shelf. */
  physicalStock: number;
  /** Sum of ACTIVE, UNEXPIRED `kind='basket'` reservations. */
  basketReserved: number;
  /** Sum of ACTIVE, UNEXPIRED `kind='order'` reservations. */
  orderAllocated: number;
}

/** What each channel may sell, plus the facts it was derived from. */
export interface AvailabilityProjection extends AvailabilityFacts {
  /** Units a storefront customer may add to a basket. Never negative. */
  availableForBasket: number;
  /** Units a cashier may sell right now. Never negative. POS outranks baskets. */
  availableForPos: number;
  /** Storefront sellability. THE online `inStock`. */
  sellableOnline: boolean;
  /** In-store sellability. THE POS `inStock`. */
  sellableInStore: boolean;
}

/** Clamp to a non-negative integer. Over-reservation is a bug, not a negative. */
function atLeastZero(value: number): number {
  return value > 0 ? value : 0;
}

/**
 * THE derivation. Every reported availability number and every sellability
 * boolean in this application comes from this function.
 */
export function deriveAvailability(
  facts: AvailabilityFacts,
): AvailabilityProjection {
  // A retired variant is unsellable through every channel regardless of stock,
  // so the quantities are reported as zero rather than as "stock you cannot
  // have" — a caller rendering the number must not have to know the rule.
  const basket = facts.isActive
    ? atLeastZero(
        facts.physicalStock - facts.basketReserved - facts.orderAllocated,
      )
    : 0;
  const pos = facts.isActive
    ? atLeastZero(facts.physicalStock - facts.orderAllocated)
    : 0;

  return {
    ...facts,
    availableForBasket: basket,
    availableForPos: pos,
    sellableOnline: basket > 0,
    sellableInStore: pos > 0,
  };
}

/**
 * The SQL that produces {@link AvailabilityFacts} for a set of variant ids.
 *
 * Exported as a string so the public catalogue list can ask the SAME question
 * in its own query instead of re-implementing it. `$1` is an `int[]` of variant
 * ids; `$2` is the instant reservations are measured against.
 *
 * `r."expiresAt" > $2` is load-bearing and not merely an optimisation: a
 * reservation whose deadline has passed must not count against availability
 * even when no sweep has released it yet. That is what makes availability
 * correct without depending on a background worker.
 */
export const AVAILABILITY_FACTS_SQL = `
  SELECT v.id                                                                 AS "variantId",
         v."productId"                                                        AS "productId",
         v."isActive"                                                         AS "isActive",
         v.stock                                                              AS "physicalStock",
         COALESCE(SUM(r.quantity) FILTER (WHERE r.kind = 'basket'), 0)        AS "basketReserved",
         COALESCE(SUM(r.quantity) FILTER (WHERE r.kind = 'order'), 0)         AS "orderAllocated"
    FROM product_variants v
    LEFT JOIN stock_reservations r
           ON r."variantId" = v.id
          AND r.status = 'active'
          AND r."expiresAt" > $2
   WHERE v.id = ANY($1::int[])
   GROUP BY v.id, v."productId", v."isActive", v.stock
`;

/**
 * "Does this product have at least one variant a storefront customer could buy
 * right now?" — as a correlated SQL predicate over `products p`.
 *
 * This exists because `GET /products` cannot use {@link deriveAvailability}: it
 * is a paginated list and must answer for every row in one query. Before this,
 * the list used a reservation-BLIND predicate, so a product whose only units
 * were all reserved advertised itself as available on the listing and then
 * revealed itself as sold out on the detail page. Same rule, expressed twice —
 * once in TypeScript for a single variant, once in SQL for a page of them —
 * and `catalogue-availability.int-spec.ts` asserts the two agree.
 *
 * The measuring instant is a PARAMETER whose placeholder the caller supplies,
 * because the two callers speak different dialects: `AVAILABILITY_FACTS_SQL`
 * runs as a raw query with positional `$n`, while the catalogue list is a
 * TypeORM query builder with named `:params`. Passing the placeholder in is
 * what lets one rule serve both without either side hardcoding the other's
 * syntax — and without anybody reaching for string concatenation of a date.
 *
 * @param nowPlaceholder e.g. `'$1'` or `':availabilityAt'`
 * @param productAlias   the `products` alias in the caller's query (default `p`)
 */
export function productSellableOnlineSql(
  nowPlaceholder: string,
  productAlias = 'p',
): string {
  return `EXISTS (
    SELECT 1
      FROM "product_variants" sv
     WHERE sv."productId" = "${productAlias}"."id"
       AND sv."isActive" = true
       AND sv."stock" - COALESCE((
             SELECT SUM(sr."quantity")
               FROM "stock_reservations" sr
              WHERE sr."variantId" = sv."id"
                AND sr."status" = 'active'
                AND sr."expiresAt" > ${nowPlaceholder}
           ), 0) > 0
  )`;
}
