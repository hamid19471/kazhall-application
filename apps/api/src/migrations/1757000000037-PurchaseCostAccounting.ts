import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ============================================================================
 * 0037 — purchase cost, inventory valuation and gross-profit evidence.
 * ============================================================================
 *
 * The contract is docs/PURCHASE-COST-ACCOUNTING.md; this migration is its
 * schema. Forward-only in spirit: `down()` exists for the up/down/up harness and
 * REFUSES once real cost data exists, because dropping it would destroy the
 * only evidence of what stock cost.
 *
 * WHAT IS BACKFILLED, AND WHY NOTHING IS INVENTED
 * -----------------------------------------------
 *  - A variant with `stock = 0` becomes valued at 0. The value of zero units is
 *    a fact, not a guess.
 *  - A variant with `stock > 0` gets `unvaluedQuantity = stock` — its units'
 *    cost is UNKNOWN, which is not the same as zero and is never reported as
 *    zero.
 *  - An existing order line whose goods have left is `unknown` cost; a line
 *    still waiting for stock is `pending` and will be costed normally when it
 *    is fulfilled.
 *  - An existing voided-after-payment or refunded order gets one `legacy`
 *    adjustment row per line recording the revenue that was reversed; what was
 *    restocked and at what cost is left NULL because it was never recorded.
 *
 * The migration REFUSES to run on negative physical stock: there is no correct
 * valuation of a negative count, and guessing one would be worse than stopping.
 */

const REASONS_BEFORE =
  "'pos_sale', 'online_fulfillment', 'cancellation_restore', 'return_restore', 'manual_adjustment', 'initial_stock'";
const REASONS_AFTER = `${REASONS_BEFORE}, 'stock_receipt', 'inventory_correction', 'valuation_initialization'`;

const SCOPES_BEFORE =
  "'pos_sale', 'online_order', 'payment_verify', 'payment_reconciliation'";
const SCOPES_AFTER = `${SCOPES_BEFORE}, 'stock_receipt', 'inventory_correction', 'inventory_valuation', 'order_line_adjustment'`;

export class PurchaseCostAccounting1757000000037 implements MigrationInterface {
  name = 'PurchaseCostAccounting1757000000037';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------------------------------------------------------- refusals
    const [{ negative }] = (await queryRunner.query(
      `SELECT count(*)::int AS negative FROM "product_variants" WHERE "stock" < 0`,
    )) as Array<{ negative: number }>;
    if (negative > 0) {
      throw new Error(
        `${this.name}: ${negative} variant(s) have negative physical stock. ` +
          `A negative count has no valuation; correct those rows deliberately ` +
          `before running this migration.`,
      );
    }
    const [{ zeroDelta }] = (await queryRunner.query(
      `SELECT count(*)::int AS "zeroDelta" FROM "stock_movements" WHERE "delta" = 0`,
    )) as Array<{ zeroDelta: number }>;
    if (zeroDelta > 0) {
      throw new Error(
        `${this.name}: ${zeroDelta} stock movement(s) have delta = 0, which the ` +
          `ledger has always documented as impossible. Investigate them first.`,
      );
    }

    // ------------------------------------------------- the valuation pool
    await queryRunner.query(
      `ALTER TABLE "product_variants"
         ADD "unvaluedQuantity" integer NOT NULL DEFAULT 0,
         ADD "inventoryCostValue" bigint NOT NULL DEFAULT 0,
         ADD "lastPurchaseUnitCost" bigint`,
    );
    await queryRunner.query(
      `UPDATE "product_variants" SET "unvaluedQuantity" = "stock" WHERE "stock" > 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants"
         ADD "costStatus" character varying(16) GENERATED ALWAYS AS (
           CASE WHEN "unvaluedQuantity" = 0 THEN 'valued' ELSE 'unvalued' END
         ) STORED`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants"
         ADD CONSTRAINT "ck_variant_stock_non_negative" CHECK ("stock" >= 0),
         ADD CONSTRAINT "ck_variant_unvalued_quantity_range"
           CHECK ("unvaluedQuantity" >= 0 AND "unvaluedQuantity" <= "stock"),
         ADD CONSTRAINT "ck_variant_inventory_value_non_negative"
           CHECK ("inventoryCostValue" >= 0),
         ADD CONSTRAINT "ck_variant_empty_pool_has_no_value"
           CHECK ("stock" - "unvaluedQuantity" > 0 OR "inventoryCostValue" = 0),
         ADD CONSTRAINT "ck_variant_last_purchase_cost_non_negative"
           CHECK ("lastPurchaseUnitCost" IS NULL OR "lastPurchaseUnitCost" >= 0)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_variant_unvalued" ON "product_variants" ("id")
         WHERE "unvaluedQuantity" > 0`,
    );
    /*
     * THE POOL HAS ONE WRITER, AND THE DATABASE KNOWS WHICH.
     *
     * `InventoryService.writePool` sets the transaction-local flag
     * `kazhal.valuation_writer = on` around its compare-and-set and clears it
     * again. Any other UPDATE that changes stock or cost — a raw fixture, an
     * ops script, a future shortcut — is refused, because a stock change that
     * bypassed the pool would either value units at zero or lose their cost.
     *
     * An INSERT carrying stock (a raw fixture; application code inserts every
     * variant at 0 and then records a valued opening movement) cannot state a
     * cost, so its units are recorded as UNVALUED — unknown, never zero.
     */
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION "public"."product_variants_pool_guard"()
         RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF TG_OP = 'INSERT' THEN
           IF NEW."stock" > 0 AND NEW."unvaluedQuantity" = 0 AND NEW."inventoryCostValue" = 0 THEN
             NEW."unvaluedQuantity" := NEW."stock";
           END IF;
           RETURN NEW;
         END IF;
         IF (NEW."stock" IS DISTINCT FROM OLD."stock"
             OR NEW."unvaluedQuantity" IS DISTINCT FROM OLD."unvaluedQuantity"
             OR NEW."inventoryCostValue" IS DISTINCT FROM OLD."inventoryCostValue")
            AND current_setting('kazhal.valuation_writer', true) IS DISTINCT FROM 'on' THEN
           RAISE EXCEPTION 'product_variants %: stock and inventory value change only through the valuation writer', OLD."id"
             USING ERRCODE = '23514';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "trg_product_variants_pool_guard"
         BEFORE INSERT OR UPDATE ON "product_variants"
         FOR EACH ROW EXECUTE FUNCTION "public"."product_variants_pool_guard"()`,
    );

    // ------------------------------------------------- movement cost evidence
    await queryRunner.query(
      `ALTER TYPE "public"."stock_movements_reason_enum"
         RENAME TO "stock_movements_reason_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."stock_movements_reason_enum" AS ENUM(${REASONS_AFTER})`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements"
         ALTER COLUMN "reason" TYPE "public"."stock_movements_reason_enum"
         USING "reason"::text::"public"."stock_movements_reason_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."stock_movements_reason_enum_old"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements"
         ADD "unitCost" bigint,
         ADD "costDelta" bigint,
         ADD "inventoryValueAfter" bigint,
         ADD "unvaluedQuantityDelta" integer,
         ADD "unvaluedQuantityAfter" integer,
         ADD "supplierReference" character varying(120)`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements"
         ADD CONSTRAINT "ck_movement_delta_non_zero"
           CHECK ("delta" <> 0 OR "reason" = 'valuation_initialization'),
         ADD CONSTRAINT "ck_movement_cost_evidence_complete"
           CHECK ((("costDelta" IS NULL) = ("inventoryValueAfter" IS NULL))
              AND (("costDelta" IS NULL) = ("unvaluedQuantityAfter" IS NULL))
              AND (("costDelta" IS NULL) = ("unvaluedQuantityDelta" IS NULL))),
         ADD CONSTRAINT "ck_movement_cost_evidence_sane"
           CHECK (("unitCost" IS NULL OR "unitCost" >= 0)
              AND ("inventoryValueAfter" IS NULL OR "inventoryValueAfter" >= 0)
              AND ("unvaluedQuantityAfter" IS NULL OR "unvaluedQuantityAfter" >= 0)),
         ADD CONSTRAINT "ck_movement_new_reasons_carry_cost"
           CHECK ("reason" NOT IN ('stock_receipt', 'inventory_correction', 'valuation_initialization')
                  OR "costDelta" IS NOT NULL),
         ADD CONSTRAINT "ck_movement_supplier_reference_not_blank"
           CHECK ("supplierReference" IS NULL OR char_length(btrim("supplierReference")) >= 1)`,
    );

    // ------------------------------------------------- order-line snapshots
    await queryRunner.query(
      `ALTER TABLE "order_items"
         ADD "costStatus" character varying(16) NOT NULL DEFAULT 'pending',
         ADD "cogsTotal" bigint,
         ADD "costKnownQuantity" integer,
         ADD "costUnknownQuantity" integer,
         ADD "costAllocatedAt" TIMESTAMP WITH TIME ZONE`,
    );
    /*
     * Goods have left (so the cost is UNKNOWN, not pending) when a consumption
     * movement exists for this order and variant, or the order is in a state
     * that only exists after hand-over.
     */
    await queryRunner.query(
      `UPDATE "order_items" oi
          SET "costStatus" = 'unknown'
         FROM "orders" o
        WHERE o."id" = oi."orderId"
          AND (
            EXISTS (SELECT 1 FROM "stock_movements" m
                     WHERE m."orderId" = oi."orderId"
                       AND m."delta" < 0
                       AND (m."variantId" = oi."variantId" OR oi."variantId" IS NULL))
            OR o."status"::text IN ('processing', 'shipped', 'delivered')
            OR (o."status"::text = 'paid'
                AND o."fulfillmentState"::text NOT IN ('pending', 'awaiting_stock'))
          )`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items"
         ADD CONSTRAINT "ck_order_item_cost_status"
           CHECK ("costStatus" IN ('pending', 'known', 'unknown')),
         ADD CONSTRAINT "ck_order_item_cost_shape" CHECK (
           ("costStatus" = 'pending'
              AND "cogsTotal" IS NULL AND "costKnownQuantity" IS NULL
              AND "costUnknownQuantity" IS NULL AND "costAllocatedAt" IS NULL)
           OR ("costStatus" = 'known'
              AND "cogsTotal" >= 0 AND "costKnownQuantity" = "quantity"
              AND "costUnknownQuantity" = 0 AND "costAllocatedAt" IS NOT NULL)
           OR ("costStatus" = 'unknown' AND (
                 ("cogsTotal" IS NULL AND "costKnownQuantity" IS NULL
                   AND "costUnknownQuantity" IS NULL AND "costAllocatedAt" IS NULL)
              OR ("cogsTotal" >= 0 AND "costKnownQuantity" >= 0
                   AND "costUnknownQuantity" > 0
                   AND "costKnownQuantity" + "costUnknownQuantity" = "quantity"
                   AND "costAllocatedAt" IS NOT NULL))))`,
    );
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION "public"."order_items_cost_snapshot_immutable"()
         RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF OLD."costStatus" <> 'pending' AND (
              NEW."costStatus" IS DISTINCT FROM OLD."costStatus"
           OR NEW."cogsTotal" IS DISTINCT FROM OLD."cogsTotal"
           OR NEW."costKnownQuantity" IS DISTINCT FROM OLD."costKnownQuantity"
           OR NEW."costUnknownQuantity" IS DISTINCT FROM OLD."costUnknownQuantity"
           OR NEW."costAllocatedAt" IS DISTINCT FROM OLD."costAllocatedAt"
           OR NEW."quantity" IS DISTINCT FROM OLD."quantity"
           OR NEW."total_price" IS DISTINCT FROM OLD."total_price") THEN
           RAISE EXCEPTION 'order_items %: the cost snapshot is immutable once recognised', OLD."id"
             USING ERRCODE = '23514';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "trg_order_items_cost_snapshot_immutable"
         BEFORE UPDATE ON "order_items"
         FOR EACH ROW EXECUTE FUNCTION "public"."order_items_cost_snapshot_immutable"()`,
    );

    // ------------------------------------------------- reversal ledger
    await queryRunner.query(
      `CREATE TABLE "order_item_adjustments" (
         "id" SERIAL NOT NULL,
         "orderId" integer NOT NULL,
         "orderItemId" integer NOT NULL,
         "kind" character varying(16) NOT NULL,
         "scope" character varying(8) NOT NULL,
         "revenueQuantity" integer NOT NULL DEFAULT 0,
         "revenueReversed" bigint NOT NULL DEFAULT 0,
         "restockedKnownQuantity" integer,
         "restockedUnknownQuantity" integer,
         "cogsReversed" bigint,
         "eventAt" TIMESTAMP WITH TIME ZONE,
         "actorUserId" integer,
         "actorDisplaySnapshot" character varying,
         "reason" character varying(500),
         "idempotencyKey" character varying(255),
         "stockMovementId" integer,
         "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "PK_order_item_adjustments" PRIMARY KEY ("id"),
         CONSTRAINT "FK_order_item_adjustments_order" FOREIGN KEY ("orderId")
           REFERENCES "orders"("id") ON DELETE RESTRICT,
         CONSTRAINT "FK_order_item_adjustments_item" FOREIGN KEY ("orderItemId")
           REFERENCES "order_items"("id") ON DELETE RESTRICT,
         CONSTRAINT "FK_order_item_adjustments_actor" FOREIGN KEY ("actorUserId")
           REFERENCES "users"("id") ON DELETE SET NULL,
         CONSTRAINT "FK_order_item_adjustments_movement" FOREIGN KEY ("stockMovementId")
           REFERENCES "stock_movements"("id") ON DELETE RESTRICT,
         CONSTRAINT "ck_adjustment_kind"
           CHECK ("kind" IN ('void', 'return_refund', 'refund_only', 'return_only')),
         CONSTRAINT "ck_adjustment_scope" CHECK ("scope" IN ('order', 'line', 'legacy')),
         CONSTRAINT "ck_adjustment_amounts_non_negative" CHECK (
           "revenueQuantity" >= 0 AND "revenueReversed" >= 0
           AND COALESCE("restockedKnownQuantity", 0) >= 0
           AND COALESCE("restockedUnknownQuantity", 0) >= 0
           AND COALESCE("cogsReversed", 0) >= 0),
         CONSTRAINT "ck_adjustment_evidence" CHECK (
           "scope" = 'legacy'
           OR ("restockedKnownQuantity" IS NOT NULL AND "restockedUnknownQuantity" IS NOT NULL
               AND "cogsReversed" IS NOT NULL AND "eventAt" IS NOT NULL)),
         CONSTRAINT "ck_adjustment_kind_shape" CHECK (
           "scope" = 'legacy'
           OR ("kind" = 'refund_only'
                 AND "restockedKnownQuantity" = 0 AND "restockedUnknownQuantity" = 0
                 AND "cogsReversed" = 0 AND "revenueQuantity" > 0)
           OR ("kind" = 'return_only' AND "revenueQuantity" = 0 AND "revenueReversed" = 0
                 AND "restockedKnownQuantity" + "restockedUnknownQuantity" > 0)
           OR ("kind" IN ('void', 'return_refund'))),
         CONSTRAINT "ck_adjustment_line_scope_keyed" CHECK (
           "scope" <> 'line' OR ("idempotencyKey" IS NOT NULL AND "actorUserId" IS NOT NULL)),
         CONSTRAINT "ck_adjustment_reason_not_blank"
           CHECK ("reason" IS NULL OR char_length(btrim("reason")) >= 1)
       )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_adjustment_item" ON "order_item_adjustments" ("orderItemId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_adjustment_order" ON "order_item_adjustments" ("orderId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_adjustment_event_at" ON "order_item_adjustments" ("eventAt")`,
    );
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION "public"."order_item_adjustments_append_only"()
         RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         RAISE EXCEPTION 'order_item_adjustments is append-only' USING ERRCODE = '23514';
       END $$`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "trg_order_item_adjustments_append_only"
         BEFORE UPDATE OR DELETE ON "order_item_adjustments"
         FOR EACH ROW EXECUTE FUNCTION "public"."order_item_adjustments_append_only"()`,
    );
    /*
     * THE CUMULATIVE BOUNDS, RE-ASSERTED BY THE DATABASE. The service computes
     * every row under the order lock; this refuses a row that would reverse
     * more revenue units, restock more units or give back more COGS than the
     * line ever recognised, whoever wrote it.
     */
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION "public"."order_item_adjustments_bounded"()
         RETURNS trigger LANGUAGE plpgsql AS $$
       DECLARE
         item RECORD;
         done RECORD;
       BEGIN
         SELECT "orderId", "quantity", "total_price", "cogsTotal", "costStatus",
                "costKnownQuantity", "costUnknownQuantity"
           INTO item FROM "order_items" WHERE "id" = NEW."orderItemId";
         IF item."orderId" IS DISTINCT FROM NEW."orderId" THEN
           RAISE EXCEPTION 'adjustment names order % but line % belongs to order %',
             NEW."orderId", NEW."orderItemId", item."orderId" USING ERRCODE = '23514';
         END IF;
         SELECT COALESCE(SUM("revenueQuantity"), 0) + NEW."revenueQuantity" AS rq,
                COALESCE(SUM("revenueReversed"), 0) + NEW."revenueReversed" AS rv,
                COALESCE(SUM("restockedKnownQuantity"), 0) + COALESCE(NEW."restockedKnownQuantity", 0) AS kq,
                COALESCE(SUM("restockedUnknownQuantity"), 0) + COALESCE(NEW."restockedUnknownQuantity", 0) AS uq,
                COALESCE(SUM("cogsReversed"), 0) + COALESCE(NEW."cogsReversed", 0) AS cv
           INTO done FROM "order_item_adjustments" WHERE "orderItemId" = NEW."orderItemId";
         IF done.rq > item."quantity" OR done.rv > item."total_price" THEN
           RAISE EXCEPTION 'line %: revenue reversal exceeds the sale', NEW."orderItemId"
             USING ERRCODE = '23514';
         END IF;
         IF NEW."scope" <> 'legacy' AND (
              done.kq > COALESCE(item."costKnownQuantity", 0)
           -- a pending line never left the shelf, so nothing can come back;
           -- a legacy unknown line (all NULL) may give back its whole quantity
           -- as unknown-cost units.
           OR done.uq > CASE WHEN item."costStatus" = 'pending' THEN 0
                             ELSE COALESCE(item."costUnknownQuantity", item."quantity") END
           OR done.cv > COALESCE(item."cogsTotal", 0)) THEN
           RAISE EXCEPTION 'line %: restock or COGS reversal exceeds what was recognised', NEW."orderItemId"
             USING ERRCODE = '23514';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "trg_order_item_adjustments_bounded"
         BEFORE INSERT ON "order_item_adjustments"
         FOR EACH ROW EXECUTE FUNCTION "public"."order_item_adjustments_bounded"()`,
    );
    // Legacy whole-order reversals, as the facts they were. Void wins when both
    // stamps exist (reverseOrder never produces both; a data fix might have).
    await queryRunner.query(
      `INSERT INTO "order_item_adjustments"
         ("orderId", "orderItemId", "kind", "scope", "revenueQuantity",
          "revenueReversed", "eventAt", "createdAt")
       SELECT oi."orderId", oi."id",
              CASE WHEN o."voidedAt" IS NOT NULL THEN 'void' ELSE 'return_refund' END,
              'legacy', oi."quantity", oi."total_price",
              CASE WHEN o."voidedAt" IS NOT NULL THEN o."voidedAt" ELSE o."refundedAt" END,
              now()
         FROM "order_items" oi
         JOIN "orders" o ON o."id" = oi."orderId"
        WHERE (o."voidedAt" IS NOT NULL AND o."paidAt" IS NOT NULL)
           OR o."status"::text = 'refunded'
        ORDER BY oi."id"`,
    );

    // ------------------------------------------------- idempotency scopes
    await queryRunner.query(
      `ALTER TYPE "public"."idempotency_keys_scope_enum" RENAME TO "idempotency_keys_scope_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."idempotency_keys_scope_enum" AS ENUM(${SCOPES_AFTER})`,
    );
    await queryRunner.query(
      `ALTER TABLE "idempotency_keys" ALTER COLUMN "scope" TYPE "public"."idempotency_keys_scope_enum" ` +
        `USING "scope"::text::"public"."idempotency_keys_scope_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."idempotency_keys_scope_enum_old"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [evidence] = (await queryRunner.query(
      `SELECT
         (SELECT count(*)::int FROM "stock_movements" WHERE "costDelta" IS NOT NULL) AS movements,
         (SELECT count(*)::int FROM "order_items" WHERE "costAllocatedAt" IS NOT NULL) AS lines,
         (SELECT count(*)::int FROM "order_item_adjustments" WHERE "scope" <> 'legacy') AS adjustments,
         (SELECT count(*)::int FROM "product_variants"
           WHERE "inventoryCostValue" <> 0 OR "lastPurchaseUnitCost" IS NOT NULL) AS variants`,
    )) as Array<Record<string, number>>;
    const recorded = Object.entries(evidence).filter(([, n]) => n > 0);
    if (recorded.length > 0) {
      throw new Error(
        `Refusing to revert ${this.name}: cost evidence exists (` +
          recorded.map(([k, n]) => `${n} ${k}`).join(', ') +
          `). Dropping it would destroy the only record of what stock cost.`,
      );
    }

    await queryRunner.query(
      `DELETE FROM "idempotency_keys" WHERE "scope"::text IN
         ('stock_receipt', 'inventory_correction', 'inventory_valuation', 'order_line_adjustment')`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."idempotency_keys_scope_enum" RENAME TO "idempotency_keys_scope_enum_new"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."idempotency_keys_scope_enum" AS ENUM(${SCOPES_BEFORE})`,
    );
    await queryRunner.query(
      `ALTER TABLE "idempotency_keys" ALTER COLUMN "scope" TYPE "public"."idempotency_keys_scope_enum" ` +
        `USING "scope"::text::"public"."idempotency_keys_scope_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."idempotency_keys_scope_enum_new"`,
    );

    await queryRunner.query(`DROP TABLE "order_item_adjustments"`);
    await queryRunner.query(
      `DROP FUNCTION "public"."order_item_adjustments_bounded"()`,
    );
    await queryRunner.query(
      `DROP FUNCTION "public"."order_item_adjustments_append_only"()`,
    );

    await queryRunner.query(
      `DROP TRIGGER "trg_order_items_cost_snapshot_immutable" ON "order_items"`,
    );
    await queryRunner.query(
      `DROP FUNCTION "public"."order_items_cost_snapshot_immutable"()`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items"
         DROP CONSTRAINT "ck_order_item_cost_shape",
         DROP CONSTRAINT "ck_order_item_cost_status",
         DROP COLUMN "costAllocatedAt",
         DROP COLUMN "costUnknownQuantity",
         DROP COLUMN "costKnownQuantity",
         DROP COLUMN "cogsTotal",
         DROP COLUMN "costStatus"`,
    );

    await queryRunner.query(
      `ALTER TABLE "stock_movements"
         DROP CONSTRAINT "ck_movement_supplier_reference_not_blank",
         DROP CONSTRAINT "ck_movement_new_reasons_carry_cost",
         DROP CONSTRAINT "ck_movement_cost_evidence_sane",
         DROP CONSTRAINT "ck_movement_cost_evidence_complete",
         DROP CONSTRAINT "ck_movement_delta_non_zero",
         DROP COLUMN "supplierReference",
         DROP COLUMN "unvaluedQuantityAfter",
         DROP COLUMN "unvaluedQuantityDelta",
         DROP COLUMN "inventoryValueAfter",
         DROP COLUMN "costDelta",
         DROP COLUMN "unitCost"`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."stock_movements_reason_enum"
         RENAME TO "stock_movements_reason_enum_new"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."stock_movements_reason_enum" AS ENUM(${REASONS_BEFORE})`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements"
         ALTER COLUMN "reason" TYPE "public"."stock_movements_reason_enum"
         USING "reason"::text::"public"."stock_movements_reason_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."stock_movements_reason_enum_new"`,
    );

    await queryRunner.query(
      `DROP TRIGGER "trg_product_variants_pool_guard" ON "product_variants"`,
    );
    await queryRunner.query(
      `DROP FUNCTION "public"."product_variants_pool_guard"()`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_variant_unvalued"`);
    await queryRunner.query(
      `ALTER TABLE "product_variants"
         DROP CONSTRAINT "ck_variant_last_purchase_cost_non_negative",
         DROP CONSTRAINT "ck_variant_empty_pool_has_no_value",
         DROP CONSTRAINT "ck_variant_inventory_value_non_negative",
         DROP CONSTRAINT "ck_variant_unvalued_quantity_range",
         DROP CONSTRAINT "ck_variant_stock_non_negative",
         DROP COLUMN "costStatus",
         DROP COLUMN "lastPurchaseUnitCost",
         DROP COLUMN "inventoryCostValue",
         DROP COLUMN "unvaluedQuantity"`,
    );
  }
}
