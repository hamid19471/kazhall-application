import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ============================================================================
 * 0030 — WHERE A PRODUCT IS OFFERED. Channel and branch visibility.
 *
 * WHAT DID NOT EXIST BEFORE
 * -------------------------
 * Nothing. A product was offered EVERYWHERE, unconditionally: every storefront
 * listing and every till saw every row in `products`. `products` has no
 * `isActive` column at all (see `inventory/availability.projection.ts:44-50`) —
 * withdrawing a product meant retiring each of its variants one at a time, and
 * even that could not express "sell this in the shops but not on the website".
 *
 * ---------------------------------------------------------------------------
 * THIS IS VISIBILITY. IT IS NOT PER-BRANCH INVENTORY.
 * ---------------------------------------------------------------------------
 * No column below splits stock. `product_variants.stock` stays a single global
 * number, `stock_reservations` stays branch-less, order allocations stay
 * global, and POS displacement priority is untouched. Selecting three branches
 * says WHERE THE PRODUCT MAY BE SOLD FROM; all three still sell out of the
 * same one quantity, and two of their cashiers racing for the last unit
 * resolve exactly as two cashiers in one branch do today.
 *
 * This is stated here, in `src/common/catalogue/product-visibility.ts`, in the
 * Admin UI in Persian and in `docs/FRONTEND-API-CONTRACT.md`, because "my
 * branch is selected, so my branch has its own stock" is the single most
 * likely wrong inference from this feature.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE — two independent dimensions, not one six-valued enum
 * ---------------------------------------------------------------------------
 *   products."visibleOnSite"     boolean
 *   products."branchVisibility"  'none' | 'all' | 'selected'
 *   product_branch_visibility    (productId, branchId) — only when 'selected'
 *
 * The owner asked for six cases; they are the PRODUCT of two smaller
 * decisions, and modelling them as one enum makes the seventh case
 * unrepresentable. See the table in `product-visibility.ts`.
 *
 * ---------------------------------------------------------------------------
 * 'all' IS A MODE, NOT A MATERIALISED ROW SET — deliberately
 * ---------------------------------------------------------------------------
 * "All branches" is NOT one row per current branch. A branch opened next month
 * must sell an "all branches" product on its first day without anyone
 * revisiting the catalogue, and a snapshot of today's branches cannot do that.
 * It is evaluated at read time so it stays true for branches that do not exist
 * yet. `selected` is the exact opposite by design: a new branch sells nothing
 * that was explicitly scoped before it existed.
 *
 * ---------------------------------------------------------------------------
 * THE BACKFILL — every existing product becomes "everywhere"
 * ---------------------------------------------------------------------------
 * `visibleOnSite = true`, `branchVisibility = 'all'`.
 *
 * This is the ONLY honest choice. Before this migration every product WAS on
 * the website and WAS sellable at every till, so "everywhere" is not a guess
 * about intent — it is a description of the state being migrated. Any other
 * default would silently withdraw live products from sale at the moment of
 * deploy, which is a catalogue-wide outage dressed up as a schema change.
 *
 * The COLUMN DEFAULTS are the opposite (`false` / `'none'`, i.e. hidden/draft)
 * and that is also deliberate: a row inserted by a future code path that
 * forgets to set visibility must be invisible, not accidentally published.
 * Existing data is migrated to what it already was; new data is born hidden.
 *
 * ---------------------------------------------------------------------------
 * THE INVALID COMBINATIONS ARE UNREPRESENTABLE, NOT MERELY UNWRITTEN
 * ---------------------------------------------------------------------------
 * Two states must never commit:
 *
 *   'selected' with ZERO mapping rows   — "selected branches: none", which is
 *                                          silently identical to 'none' but
 *                                          reads on screen as a real choice;
 *   NOT 'selected' with mapping rows    — orphaned selections that reappear if
 *                                          the mode is ever switched back.
 *
 * A CHECK constraint cannot express either: both span two tables. A DEFERRABLE
 * CONSTRAINT TRIGGER can, and DEFERRABLE INITIALLY DEFERRED is load-bearing —
 * moving a product from 'all' to 'selected' is necessarily two statements, and
 * whichever order you write them in, the intermediate state is invalid.
 * Deferring to COMMIT lets the service write naturally and still makes an
 * invalid PAIR impossible to commit.
 *
 * Duplicate branch mappings are impossible by the composite PRIMARY KEY, not
 * by the service remembering to de-duplicate.
 *
 * ---------------------------------------------------------------------------
 * BRANCH LIFECYCLE
 * ---------------------------------------------------------------------------
 * Deactivating a branch does NOT delete its mappings. A deactivated branch
 * exposes nothing (enforced where the branch is resolved), and REACTIVATING it
 * restores exactly the visibility it had, with no administrative replay. The
 * FK is `ON DELETE CASCADE` so that even a hard branch delete — which
 * `branches`' other foreign keys already make practically impossible — cannot
 * leave a mapping row pointing at nothing.
 * ============================================================================
 */

/** Matches `BRANCH_VISIBILITY_ENUM` in `common/catalogue/product-visibility.ts`. */
const ENUM_NAME = 'products_branchvisibility_enum';
const TABLE = 'product_branch_visibility';
const FN = 'assert_product_branch_visibility_consistent';

export class ProductChannelVisibility1757000000030 implements MigrationInterface {
  name = 'ProductChannelVisibility1757000000030';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // -----------------------------------------------------------------------
    // 1. The retail-channel dimension.
    // -----------------------------------------------------------------------
    await queryRunner.query(
      `CREATE TYPE "public"."${ENUM_NAME}" AS ENUM('none', 'all', 'selected')`,
    );

    // -----------------------------------------------------------------------
    // 2. The two columns. Defaults are HIDDEN/DRAFT — see the header.
    // -----------------------------------------------------------------------
    await queryRunner.query(
      `ALTER TABLE "products"
         ADD COLUMN "visibleOnSite" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "products"
         ADD COLUMN "branchVisibility" "public"."${ENUM_NAME}"
         NOT NULL DEFAULT 'none'`,
    );

    // -----------------------------------------------------------------------
    // 3. BACKFILL: describe what was already true. Every pre-existing product
    //    was on the site and sellable at every till, so it becomes exactly
    //    that. Deploying this must not withdraw anything from sale.
    // -----------------------------------------------------------------------
    await queryRunner.query(
      `UPDATE "products"
          SET "visibleOnSite" = true,
              "branchVisibility" = 'all'`,
    );

    // -----------------------------------------------------------------------
    // 4. The selected-branch mapping.
    // -----------------------------------------------------------------------
    await queryRunner.query(
      `CREATE TABLE "${TABLE}" (
         "productId" integer NOT NULL,
         "branchId" integer NOT NULL,
         "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "pk_product_branch_visibility"
           PRIMARY KEY ("productId", "branchId"),
         CONSTRAINT "fk_pbv_product" FOREIGN KEY ("productId")
           REFERENCES "products"("id") ON DELETE CASCADE,
         CONSTRAINT "fk_pbv_branch" FOREIGN KEY ("branchId")
           REFERENCES "branches"("id") ON DELETE CASCADE
       )`,
    );

    /*
     * The composite PK already indexes (productId, branchId), which serves
     * "which branches for this product". The reverse question — "which
     * products for this branch", asked by every POS catalogue page — needs its
     * own index.
     */
    await queryRunner.query(
      `CREATE INDEX "idx_pbv_branch" ON "${TABLE}" ("branchId")`,
    );

    // Partial: the storefront only ever asks for the `true` side, and a
    // catalogue skewed heavily to one value makes the full index dead weight.
    await queryRunner.query(
      `CREATE INDEX "idx_products_visible_on_site"
         ON "products" ("id") WHERE "visibleOnSite" = true`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_products_branch_visibility"
         ON "products" ("branchVisibility")`,
    );

    // -----------------------------------------------------------------------
    // 5. The consistency trigger. See the header for why this is not a CHECK.
    // -----------------------------------------------------------------------
    await queryRunner.query(
      `CREATE FUNCTION "${FN}"() RETURNS trigger
         LANGUAGE plpgsql
       AS $fn$
       DECLARE
         v_product_id integer;
         v_mode text;
         v_count integer;
       BEGIN
         IF TG_TABLE_NAME = 'products' THEN
           v_product_id := NEW."id";
         ELSE
           v_product_id := COALESCE(NEW."productId", OLD."productId");
         END IF;

         SELECT "branchVisibility"::text INTO v_mode
           FROM "products" WHERE "id" = v_product_id;

         -- The product is gone (ON DELETE CASCADE removed the mapping rows
         -- alongside it). There is nothing left to be inconsistent with.
         IF v_mode IS NULL THEN
           RETURN NULL;
         END IF;

         SELECT count(*) INTO v_count
           FROM "${TABLE}" WHERE "productId" = v_product_id;

         IF v_mode = 'selected' AND v_count = 0 THEN
           RAISE EXCEPTION
             'product % has branchVisibility=selected but no selected branches',
             v_product_id
             USING ERRCODE = 'check_violation',
                   CONSTRAINT = 'trg_product_branch_visibility_consistent';
         END IF;

         IF v_mode <> 'selected' AND v_count > 0 THEN
           RAISE EXCEPTION
             'product % has branchVisibility=% but % selected branch row(s)',
             v_product_id, v_mode, v_count
             USING ERRCODE = 'check_violation',
                   CONSTRAINT = 'trg_product_branch_visibility_consistent';
         END IF;

         RETURN NULL;
       END
       $fn$`,
    );

    await queryRunner.query(
      `CREATE CONSTRAINT TRIGGER "trg_product_branch_visibility_consistent"
         AFTER INSERT OR UPDATE OF "branchVisibility" ON "products"
         DEFERRABLE INITIALLY DEFERRED
         FOR EACH ROW EXECUTE FUNCTION "${FN}"()`,
    );

    await queryRunner.query(
      `CREATE CONSTRAINT TRIGGER "trg_product_branch_visibility_consistent"
         AFTER INSERT OR UPDATE OR DELETE ON "${TABLE}"
         DEFERRABLE INITIALLY DEFERRED
         FOR EACH ROW EXECUTE FUNCTION "${FN}"()`,
    );
  }

  /**
   * Reverses `up()` in dependency order. The triggers depend on the function,
   * the function reads the table and the column, so they go first.
   *
   * The backfill is NOT undone, because it cannot be: the pre-migration state
   * had no way to express visibility, so there is nothing to restore it to.
   * Dropping the columns discards the configuration entirely, which is the
   * honest inverse — re-running `up()` afterwards will once again describe
   * every surviving product as "everywhere".
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER "trg_product_branch_visibility_consistent" ON "${TABLE}"`,
    );
    await queryRunner.query(
      `DROP TRIGGER "trg_product_branch_visibility_consistent" ON "products"`,
    );
    await queryRunner.query(`DROP FUNCTION "${FN}"()`);

    await queryRunner.query(
      `DROP INDEX "public"."idx_products_branch_visibility"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_products_visible_on_site"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_pbv_branch"`);
    await queryRunner.query(`DROP TABLE "${TABLE}"`);

    await queryRunner.query(
      `ALTER TABLE "products" DROP COLUMN "branchVisibility"`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" DROP COLUMN "visibleOnSite"`,
    );
    await queryRunner.query(`DROP TYPE "public"."${ENUM_NAME}"`);
  }
}
