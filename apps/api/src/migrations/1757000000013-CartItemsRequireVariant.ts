import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0013 — `cart_items."variantId"` becomes NOT NULL (workstream D).
 *
 * ---------------------------------------------------------------------------
 * WHY. Migration 0012 gave every option-less product a default variant, so
 * `product_variants` is now the only sellable unit. This migration makes that
 * STRUCTURAL for the basket: a line that names no SKU can no longer be stored
 * at all. Application checks alone were what failed last time — `CartService`
 * had a `variantId === null` branch that skipped locking and reservation, and
 * nothing in the schema said that was wrong. A NOT NULL constraint cannot be
 * bypassed by a future code path, an admin script or a seeder.
 *
 * It also retires a caveat that migration 0005 had to leave standing:
 * PostgreSQL treats NULLs as distinct, so `uq_cart_items_active_line` could
 * not stop a customer holding two active lines for the same variant-less
 * product. With NOT NULL the partial unique index is finally total.
 *
 * ---------------------------------------------------------------------------
 * EXISTING ROWS — WHAT THE CUSTOMER SEES.
 *
 * A pre-existing `variantId IS NULL` line has no backing reservation, because
 * under the old model none was ever created for it. Its product's new default
 * variant has **stock 0** (0012 refuses to invent a count), so there is no
 * honest way to give the line a reservation now: doing so would hand out units
 * that do not exist and that a POS sale would then be unable to sell.
 *
 * So the line is repointed at the default variant AND soft-removed through the
 * mechanism migration 0005 already built for exactly this situation — a hold
 * disappearing underneath a customer:
 *
 *     status              'removed'
 *     quantity            0
 *     lastChangeReason    'stock_not_counted'
 *     lastChangeQtyDelta  -(previous quantity)
 *
 * `GET /cart` shows a soft-removed line with a reason EXACTLY ONCE, as a
 * notice, and then clears the reason while keeping the tombstone (so the
 * partial unique index still lets the customer re-add the product). The
 * customer therefore sees, once:
 *
 *   "This product is now tracked as a stock-keeping unit. We have no counted
 *    stock for it yet, so we could not keep it in your basket — please add it
 *    again once it is back in stock."
 *
 * and then the line is gone from `items`. They are TOLD; the line does not
 * silently become unbuyable, and it does not silently become free stock.
 *
 * `stock_not_counted` is a CART-LINE change reason, not a
 * `ReservationReleaseReason`: no reservation was released, because none ever
 * existed. `cart_items."lastChangeReason"` is a plain `character varying`
 * (migration 0005), so this needs no enum change and cannot leak into
 * `stock_reservations."releaseReason"`, where it would be a lie.
 *
 * The reason column doubles as the marker `down()` uses to identify exactly
 * the rows this migration changed.
 */
export class CartItemsRequireVariant1757000000013 implements MigrationInterface {
  name = 'CartItemsRequireVariant1757000000013';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // A variant-less line whose product has NO default variant cannot be
    // repointed without inventing a SKU for it. The only products without a
    // default after 0012 are ones that already had real option variants, and
    // the shipped `CartService.resolveTarget` rejected a product-only request
    // for those — so such a row can only come from hand-edited data. It names
    // nothing sellable, so it goes rather than being pointed at an arbitrary
    // option the customer never chose.
    await queryRunner.query(`
      DELETE FROM "cart_items" ci
       WHERE ci."variantId" IS NULL
         AND NOT EXISTS (
               SELECT 1 FROM "product_variants" v
                WHERE v."productId" = ci."productId"
                  AND v."isDefault" = true
             )
    `);

    // Repoint every remaining variant-less line at its product's default
    // variant, and tell the ACTIVE ones what happened. Rows that were already
    // soft-removed keep whatever notice they carried: they are tombstones, and
    // overwriting their reason would re-explain a change that already had its
    // own explanation.
    await queryRunner.query(`
      UPDATE "cart_items" ci
         SET "variantId"          = v."id",
             "quantity"           = CASE WHEN ci."status" = 'active' THEN 0 ELSE ci."quantity" END,
             "status"             = CASE WHEN ci."status" = 'active' THEN 'removed'::"public"."cart_items_status_enum" ELSE ci."status" END,
             "lastChangeReason"   = CASE WHEN ci."status" = 'active' THEN 'stock_not_counted' ELSE ci."lastChangeReason" END,
             "lastChangeAt"       = CASE WHEN ci."status" = 'active' THEN now() ELSE ci."lastChangeAt" END,
             "lastChangeQtyDelta" = CASE WHEN ci."status" = 'active' THEN -ci."quantity" ELSE ci."lastChangeQtyDelta" END
        FROM "product_variants" v
       WHERE ci."variantId" IS NULL
         AND v."productId" = ci."productId"
         AND v."isDefault" = true
    `);

    await queryRunner.query(
      `ALTER TABLE "cart_items" ALTER COLUMN "variantId" SET NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "cart_items" ALTER COLUMN "variantId" DROP NOT NULL`,
    );

    // Restore exactly the rows up() changed, identified by the marker reason.
    // BEST EFFORT for data, EXACT for schema: `GET /cart` clears
    // `lastChangeReason` once the customer has been shown the notice, so a
    // line the customer already saw can no longer be identified here. Such a
    // row simply stays pointed at the default variant, which is a valid state
    // under the (now nullable again) column.
    await queryRunner.query(`
      UPDATE "cart_items"
         SET "variantId"          = NULL,
             "quantity"           = COALESCE(-"lastChangeQtyDelta", "quantity"),
             "status"             = 'active'::"public"."cart_items_status_enum",
             "lastChangeReason"   = NULL,
             "lastChangeAt"       = NULL,
             "lastChangeQtyDelta" = NULL
       WHERE "lastChangeReason" = 'stock_not_counted'
    `);
  }
}
