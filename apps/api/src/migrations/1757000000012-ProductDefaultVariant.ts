import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0012 — `product_variants."isDefault"` + a DEFAULT VARIANT for every
 * option-less product (workstream D).
 *
 * ---------------------------------------------------------------------------
 * WHY. The previous model allowed a product to have ZERO variants and be sold
 * anyway: `CartService` took an explicit `variantId === null` branch that
 * skipped `lockVariants`, skipped the reservation entirely and just wrote a
 * quantity ("nothing to reserve, stock is not tracked at product level"), and
 * `OrdersService.create` filtered those lines out before allocating. A
 * variant-less product could therefore be added to any number of baskets in
 * any quantity, took part in NO stock check, got NO four-hour hold, could not
 * be displaced by a POS sale, and was sold at `products.basePrice` with no
 * allocation at checkout. That is a hole straight through "one shared,
 * authoritative inventory".
 *
 * The fix is a UNIFORM SELLABLE-SKU MODEL: `product_variants` is the ONLY
 * sellable unit, and an option-less ("simple") product carries exactly one
 * variant flagged `isDefault`. There is then no second code path to bypass,
 * because there is no second kind of sellable thing.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE BACKFILL CANNOT KNOW — READ THIS BEFORE CHANGING IT.
 *
 * A backfilled default variant is created with **stock = 0**, deliberately.
 * Nobody has ever counted these products: the old model had no stock column
 * that applied to them, so there is no number to migrate. Zero is the only
 * honest value. Inventing an opening stock here would manufacture sellable
 * units out of nothing and would be indistinguishable, downstream, from a real
 * stock count.
 *
 * A 0-stock default is NOT hidden from customers. It is `isActive = true`, so
 * the storefront lists it with `availability.inStock = false` — "out of stock"
 * rather than "gone". Opening stock is entered afterwards through
 * `POST /products/variants/:id/stock/adjust`, which records a `stock_movements`
 * row with a `balanceAfter`, so the first real count is auditable.
 *
 * ---------------------------------------------------------------------------
 * PRICE. `products.basePrice` and `product_variants.price` are BOTH `bigint`
 * INTEGER RIAL. Verified, not assumed:
 *   - migration 0001 declares both columns `bigint`;
 *   - both entity properties carry `bigIntTransformer`, whose header states
 *     "all money columns store integer Rial";
 *   - `ProductsService.EFFECTIVE_PRICE_SQL` already does
 *     `COALESCE(MIN(variant.price), p."basePrice")` and feeds the single result
 *     to the same minPrice/maxPrice filter and price sort;
 *   - `OrdersService.create` already does `cart.variant?.price ?? basePrice`
 *     into `order_items.unit_price` (also bigint).
 * The units genuinely match, so `basePrice` is copied verbatim — no conversion,
 * no scaling. A product with a NULL basePrice gets price 0 (the same value the
 * application uses for a variant created without a price).
 *
 * `products.basePrice` is NOT removed here and stays readable. INTENDED
 * DIRECTION (for the lead): once every product has at least one variant,
 * `basePrice` is display-only — a "from" price for the list card — and the
 * authoritative money for a sale is `product_variants.price`. The remaining
 * `?? basePrice` fallback in `OrdersService.create` is the last place that
 * treats it as authoritative and should go (see the workstream D report).
 *
 * ---------------------------------------------------------------------------
 * SKU. `product_variants.sku` carries a plain UNIQUE constraint
 * (`UQ_46f236f21640f9da218a063a866`, migration 0001), so a backfilled SKU must
 * be globally unique, not merely unique per product. `DEFAULT-P<productId>` is
 * deterministic and collision-free by construction (product ids are unique);
 * the loop below still probes for a hand-written SKU that happens to occupy
 * the name and appends `-1`, `-2`, ... rather than aborting the deployment.
 *
 * ---------------------------------------------------------------------------
 * `isDefault` is marked with a PARTIAL unique index rather than a plain one:
 * at most one default per product, while any number of ordinary variants
 * coexist. A product with real option variants has NO default — the customer
 * must choose — which is what keeps `VARIANT_REQUIRED_FOR_PRODUCT` meaningful.
 */
export class ProductDefaultVariant1757000000012 implements MigrationInterface {
  name = 'ProductDefaultVariant1757000000012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "product_variants" ADD "isDefault" boolean NOT NULL DEFAULT false`,
    );

    // At most one default per product. Partial, so the (many) non-default
    // variants of an option-bearing product do not collide with each other.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_variant_one_default_per_product"
         ON "product_variants" ("productId")
       WHERE "isDefault" = true`,
    );

    // ---------------------------------------------------------------------
    // BACKFILL. One default variant per variant-less product.
    // stock = 0 ALWAYS. See the header: nobody counted these.
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      DO $$
      DECLARE
        p RECORD;
        candidate text;
        suffix int;
      BEGIN
        FOR p IN
          SELECT pr."id" AS id, pr."basePrice" AS base_price
            FROM "products" pr
           WHERE NOT EXISTS (
                   SELECT 1 FROM "product_variants" v
                    WHERE v."productId" = pr."id"
                 )
           ORDER BY pr."id"
        LOOP
          candidate := 'DEFAULT-P' || p.id::text;
          suffix := 0;
          WHILE EXISTS (SELECT 1 FROM "product_variants" v WHERE v."sku" = candidate) LOOP
            suffix := suffix + 1;
            candidate := 'DEFAULT-P' || p.id::text || '-' || suffix::text;
          END LOOP;

          INSERT INTO "product_variants"
            ("price", "stock", "sku", "productId", "isActive", "isDefault")
          VALUES (COALESCE(p.base_price, 0), 0, candidate, p.id, true, true);
        END LOOP;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // LOSSY BY NATURE — the same trade-off migration 0005's down() makes.
    // The backfilled defaults only exist because of this migration, so the
    // honest reverse is to delete them. They are identified by BOTH the
    // `isDefault` flag AND the generated SKU shape, so a default variant an
    // operator created by hand under a different SKU survives.
    //
    // Cascades are relied upon deliberately: `cart_items.variantId` and
    // `stock_reservations.variantId` are ON DELETE CASCADE, and
    // `order_items.variantId` is ON DELETE SET NULL. Migration 0013's down()
    // runs first and detaches the cart rows it repointed, so in the normal
    // revert order nothing customer-visible is destroyed here.
    await queryRunner.query(
      `DELETE FROM "product_variants"
        WHERE "isDefault" = true
          AND "sku" ~ '^DEFAULT-P[0-9]+(-[0-9]+)?$'`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."uq_variant_one_default_per_product"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" DROP COLUMN "isDefault"`,
    );
  }
}
