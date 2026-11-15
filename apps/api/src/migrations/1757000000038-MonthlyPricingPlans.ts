import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ============================================================================
 * 0038 — MONTHLY COST-RECOVERY PRICING PLANS (docs/MONTHLY-PRICING.md)
 * ============================================================================
 *
 * A super_admin enters a month's operating costs, a revenue target, a tax rate
 * and a profit margin; the system proposes a selling price for every variant
 * from its exact weighted-average purchase cost. Nothing here changes a price
 * by itself: prices move only when a reviewed, approved plan is APPLIED, and
 * every applied change can be rolled back.
 *
 * Five additive tables, no change to any existing table:
 *
 *   pricing_plans               the plan: inputs, review rules, lifecycle state
 *   pricing_plan_cost_entries   the plan's monthly cost lines (editable drafts)
 *   pricing_plan_runs           one durable row per calculate / apply / rollback,
 *                               carrying its idempotency key, progress and the
 *                               IMMUTABLE input snapshot a calculation used
 *   pricing_plan_items          the persisted, paginated preview: one row per
 *                               variant, with immutable snapshots + review decisions
 *   pricing_price_changes       the append-only price history: every price the
 *                               feature wrote or restored, old → new
 *
 * MONEY is integer Rial in `bigint`; RATES are integer basis points in
 * `integer` (1 bp = 0.01 %). The only non-integer column is the display-only
 * raw price, `numeric(30,4)`, rounded UP at 4 dp by the application.
 *
 * STATES are `varchar` + CHECK rather than PostgreSQL enums, so a future
 * method (`PRODUCT_SALES_FORECAST`) or state is a one-line constraint change
 * and `down()` leaves no type behind.
 *
 * WHY variantId / productId CARRY NO FOREIGN KEY on items and history: they
 * are SNAPSHOTS. A historical plan must keep explaining the price it wrote
 * even if the catalogue row is later removed — the same reason `order_items`
 * snapshots titles and codes. They are indexed for lookup instead.
 *
 * WHY users are referenced by id + display snapshot, without FK: exactly the
 * `admin_audit_log` rule — the record of who changed a price must outlive the
 * account.
 * ============================================================================
 */
export class MonthlyPricingPlans1757000000038 implements MigrationInterface {
  name = 'MonthlyPricingPlans1757000000038';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ------------------------------------------------------------- plans
    await queryRunner.query(
      `CREATE TABLE "pricing_plans" (
         "id" SERIAL NOT NULL,
         "title" character varying(120) NOT NULL,
         "effectiveYear" smallint NOT NULL,
         "effectiveMonth" smallint NOT NULL,
         "calculationMethod" character varying(32) NOT NULL DEFAULT 'TARGET_REVENUE',
         "formulaVersion" smallint NOT NULL DEFAULT 1,
         "status" character varying(24) NOT NULL DEFAULT 'DRAFT',
         "targetMonthlyRevenueRial" bigint,
         "taxRateBps" integer,
         "targetProfitMarginBps" integer,
         "roundingStepRial" bigint NOT NULL DEFAULT 1000,
         "reviewMaxIncreaseBps" integer NOT NULL DEFAULT 2000,
         "reviewDecreases" boolean NOT NULL DEFAULT true,
         "notes" character varying(1000),
         "copiedFromPlanId" integer,
         "lastErrorCode" character varying(64),
         "createdByUserId" integer NOT NULL,
         "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         "calculatedAt" TIMESTAMP WITH TIME ZONE,
         "approvedAt" TIMESTAMP WITH TIME ZONE,
         "approvedByUserId" integer,
         "appliedAt" TIMESTAMP WITH TIME ZONE,
         "appliedByUserId" integer,
         "rolledBackAt" TIMESTAMP WITH TIME ZONE,
         "rolledBackByUserId" integer,
         CONSTRAINT "pk_pricing_plans" PRIMARY KEY ("id"),
         CONSTRAINT "fk_pricing_plans_copied_from" FOREIGN KEY ("copiedFromPlanId")
           REFERENCES "pricing_plans"("id") ON DELETE SET NULL,
         CONSTRAINT "chk_pricing_plans_title" CHECK (length(btrim("title")) > 0),
         CONSTRAINT "chk_pricing_plans_month" CHECK ("effectiveMonth" BETWEEN 1 AND 12),
         CONSTRAINT "chk_pricing_plans_year" CHECK ("effectiveYear" BETWEEN 1300 AND 1700),
         CONSTRAINT "chk_pricing_plans_method" CHECK ("calculationMethod" IN ('TARGET_REVENUE')),
         CONSTRAINT "chk_pricing_plans_formula_version" CHECK ("formulaVersion" >= 1),
         CONSTRAINT "chk_pricing_plans_status" CHECK ("status" IN (
           'DRAFT', 'CALCULATING', 'READY_FOR_REVIEW', 'APPROVED',
           'APPLYING', 'APPLIED', 'FAILED', 'ROLLED_BACK')),
         CONSTRAINT "chk_pricing_plans_revenue" CHECK (
           "targetMonthlyRevenueRial" IS NULL
           OR "targetMonthlyRevenueRial" BETWEEN 0 AND 1000000000000000),
         CONSTRAINT "chk_pricing_plans_tax" CHECK (
           "taxRateBps" IS NULL OR "taxRateBps" BETWEEN 0 AND 9999),
         CONSTRAINT "chk_pricing_plans_profit" CHECK (
           "targetProfitMarginBps" IS NULL OR "targetProfitMarginBps" BETWEEN 0 AND 9999),
         CONSTRAINT "chk_pricing_plans_rounding" CHECK (
           "roundingStepRial" BETWEEN 1 AND 10000000),
         CONSTRAINT "chk_pricing_plans_review_increase" CHECK (
           "reviewMaxIncreaseBps" BETWEEN 0 AND 1000000)
       )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_pricing_plans_status" ON "pricing_plans" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_pricing_plans_list"
         ON "pricing_plans" ("effectiveYear" DESC, "effectiveMonth" DESC, "id" DESC)`,
    );

    // ------------------------------------------------------ cost entries
    await queryRunner.query(
      `CREATE TABLE "pricing_plan_cost_entries" (
         "id" SERIAL NOT NULL,
         "planId" integer NOT NULL,
         "title" character varying(120) NOT NULL,
         "amountRial" bigint NOT NULL,
         "scope" character varying(16) NOT NULL DEFAULT 'general',
         "branchId" integer,
         "note" character varying(500),
         "isActive" boolean NOT NULL DEFAULT true,
         "sortOrder" integer NOT NULL,
         "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "pk_pricing_plan_cost_entries" PRIMARY KEY ("id"),
         CONSTRAINT "fk_pricing_plan_cost_entries_plan" FOREIGN KEY ("planId")
           REFERENCES "pricing_plans"("id") ON DELETE CASCADE,
         CONSTRAINT "fk_pricing_plan_cost_entries_branch" FOREIGN KEY ("branchId")
           REFERENCES "branches"("id") ON DELETE RESTRICT,
         CONSTRAINT "chk_pricing_plan_cost_entries_title" CHECK (length(btrim("title")) > 0),
         CONSTRAINT "chk_pricing_plan_cost_entries_amount" CHECK (
           "amountRial" BETWEEN 0 AND 1000000000000000),
         CONSTRAINT "chk_pricing_plan_cost_entries_scope" CHECK (
           ("scope" = 'general' AND "branchId" IS NULL)
           OR ("scope" = 'branch' AND "branchId" IS NOT NULL))
       )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_pricing_plan_cost_entries_order"
         ON "pricing_plan_cost_entries" ("planId", "sortOrder", "id")`,
    );

    // --------------------------------------------------------------- runs
    await queryRunner.query(
      `CREATE TABLE "pricing_plan_runs" (
         "id" SERIAL NOT NULL,
         "planId" integer NOT NULL,
         "kind" character varying(16) NOT NULL,
         "status" character varying(16) NOT NULL DEFAULT 'queued',
         "idempotencyKey" character varying(200) NOT NULL,
         "requestHash" character(64) NOT NULL,
         "calculationMethod" character varying(32) NOT NULL,
         "formulaVersion" smallint NOT NULL,
         "inputsSnapshot" jsonb,
         "expectedChangeCount" integer,
         "phase" character varying(24),
         "totalItems" integer NOT NULL DEFAULT 0,
         "processedItems" integer NOT NULL DEFAULT 0,
         "result" jsonb,
         "errorCode" character varying(64),
         "requestedByUserId" integer NOT NULL,
         "requestedByDisplay" character varying(160) NOT NULL,
         "queuedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         "startedAt" TIMESTAMP WITH TIME ZONE,
         "heartbeatAt" TIMESTAMP WITH TIME ZONE,
         "finishedAt" TIMESTAMP WITH TIME ZONE,
         CONSTRAINT "pk_pricing_plan_runs" PRIMARY KEY ("id"),
         CONSTRAINT "fk_pricing_plan_runs_plan" FOREIGN KEY ("planId")
           REFERENCES "pricing_plans"("id") ON DELETE CASCADE,
         CONSTRAINT "uq_pricing_plan_runs_key" UNIQUE ("planId", "kind", "idempotencyKey"),
         CONSTRAINT "chk_pricing_plan_runs_kind" CHECK ("kind" IN ('calculate', 'apply', 'rollback')),
         CONSTRAINT "chk_pricing_plan_runs_status" CHECK (
           "status" IN ('queued', 'running', 'succeeded', 'failed')),
         CONSTRAINT "chk_pricing_plan_runs_progress" CHECK (
           "totalItems" >= 0 AND "processedItems" >= 0 AND "processedItems" <= "totalItems"),
         CONSTRAINT "chk_pricing_plan_runs_inputs" CHECK (
           ("kind" = 'calculate') = ("inputsSnapshot" IS NOT NULL))
       )`,
    );
    /*
     * AT MOST ONE ACTIVE RUN PER PLAN, enforced by the database: a second
     * calculate/apply/rollback on the same plan fails its INSERT rather than
     * racing the first.
     */
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_pricing_plan_runs_one_active"
         ON "pricing_plan_runs" ("planId")
         WHERE "status" IN ('queued', 'running')`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_pricing_plan_runs_claim"
         ON "pricing_plan_runs" ("id")
         WHERE "status" IN ('queued', 'running')`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_pricing_plan_runs_plan" ON "pricing_plan_runs" ("planId", "id" DESC)`,
    );
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION "public"."pricing_plan_runs_inputs_immutable"()
         RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW."inputsSnapshot" IS DISTINCT FROM OLD."inputsSnapshot"
            OR NEW."kind" IS DISTINCT FROM OLD."kind"
            OR NEW."planId" IS DISTINCT FROM OLD."planId"
            OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
            OR NEW."requestHash" IS DISTINCT FROM OLD."requestHash"
            OR NEW."formulaVersion" IS DISTINCT FROM OLD."formulaVersion"
            OR NEW."calculationMethod" IS DISTINCT FROM OLD."calculationMethod" THEN
           RAISE EXCEPTION 'pricing_plan_runs: identity and input snapshot are immutable'
             USING ERRCODE = 'check_violation';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "trg_pricing_plan_runs_inputs_immutable"
         BEFORE UPDATE ON "pricing_plan_runs"
         FOR EACH ROW EXECUTE FUNCTION "public"."pricing_plan_runs_inputs_immutable"()`,
    );

    // ------------------------------------------------------------- items
    await queryRunner.query(
      `CREATE TABLE "pricing_plan_items" (
         "id" SERIAL NOT NULL,
         "planId" integer NOT NULL,
         "calculationRunId" integer NOT NULL,
         "variantId" integer NOT NULL,
         "productId" integer NOT NULL,
         "productTitle" character varying(255) NOT NULL,
         "productCode" character varying(32) NOT NULL,
         "variantCode" character varying(64) NOT NULL,
         "sku" character varying(255) NOT NULL,
         "isDefaultVariant" boolean NOT NULL,
         "categoryIds" integer[] NOT NULL DEFAULT '{}',
         "visibleOnSite" boolean NOT NULL,
         "branchVisibility" character varying(16) NOT NULL,
         "variantActive" boolean NOT NULL,
         "stock" integer NOT NULL,
         "unvaluedQuantity" integer NOT NULL,
         "inventoryCostValue" bigint NOT NULL,
         "costBasisRial" bigint,
         "currentPriceRial" bigint,
         "rawPrice" numeric(30,4),
         "proposedPriceRial" bigint,
         "overridePriceRial" bigint,
         "overriddenByUserId" integer,
         "overriddenAt" TIMESTAMP WITH TIME ZONE,
         "finalPriceRial" bigint GENERATED ALWAYS AS (
           COALESCE("overridePriceRial", "proposedPriceRial")) STORED,
         "changeRial" bigint GENERATED ALWAYS AS (
           COALESCE("overridePriceRial", "proposedPriceRial") - "currentPriceRial") STORED,
         "changePercent" numeric(14,2) GENERATED ALWAYS AS (
           CASE WHEN "currentPriceRial" > 0
                     AND COALESCE("overridePriceRial", "proposedPriceRial") IS NOT NULL
                THEN round(
                  ((COALESCE("overridePriceRial", "proposedPriceRial") - "currentPriceRial")::numeric
                    * 100) / "currentPriceRial", 2)
           END) STORED,
         "status" character varying(16) NOT NULL,
         "reasons" text[] NOT NULL DEFAULT '{}',
         "included" boolean NOT NULL DEFAULT false,
         "reviewedByUserId" integer,
         "reviewedAt" TIMESTAMP WITH TIME ZONE,
         "stale" boolean NOT NULL DEFAULT false,
         "staleReason" character varying(32),
         "calculationMethod" character varying(32) NOT NULL,
         "formulaVersion" smallint NOT NULL,
         "calculatedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
         CONSTRAINT "pk_pricing_plan_items" PRIMARY KEY ("id"),
         CONSTRAINT "fk_pricing_plan_items_plan" FOREIGN KEY ("planId")
           REFERENCES "pricing_plans"("id") ON DELETE CASCADE,
         CONSTRAINT "fk_pricing_plan_items_run" FOREIGN KEY ("calculationRunId")
           REFERENCES "pricing_plan_runs"("id") ON DELETE CASCADE,
         CONSTRAINT "uq_pricing_plan_items_variant" UNIQUE ("planId", "variantId"),
         CONSTRAINT "chk_pricing_plan_items_status" CHECK (
           "status" IN ('READY', 'UNCHANGED', 'NEEDS_REVIEW', 'BLOCKED')),
         CONSTRAINT "chk_pricing_plan_items_money" CHECK (
           ("costBasisRial" IS NULL OR "costBasisRial" >= 0)
           AND ("currentPriceRial" IS NULL OR "currentPriceRial" >= 0)
           AND ("proposedPriceRial" IS NULL OR "proposedPriceRial" >= 0)
           AND ("overridePriceRial" IS NULL OR "overridePriceRial" > 0)),
         CONSTRAINT "chk_pricing_plan_items_blocked_excluded" CHECK (
           NOT ("included" AND ("status" = 'BLOCKED' OR "stale"))),
         CONSTRAINT "chk_pricing_plan_items_override_actor" CHECK (
           ("overridePriceRial" IS NULL) = ("overriddenByUserId" IS NULL))
       )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_pricing_plan_items_status" ON "pricing_plan_items" ("planId", "status", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_pricing_plan_items_change" ON "pricing_plan_items" ("planId", "changePercent", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_pricing_plan_items_title" ON "pricing_plan_items" ("planId", "productTitle", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_pricing_plan_items_included"
         ON "pricing_plan_items" ("planId", "id") WHERE "included"`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_pricing_plan_items_categories"
         ON "pricing_plan_items" USING GIN ("categoryIds")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_pricing_plan_items_variant" ON "pricing_plan_items" ("variantId")`,
    );
    /*
     * The SNAPSHOT half of a row is written once, by the calculation, and never
     * again. Only the REVIEW half (included / override / reviewed / stale) may
     * change, so an approved plan can always be explained from its own rows.
     */
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION "public"."pricing_plan_items_snapshot_immutable"()
         RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF ROW(NEW."planId", NEW."calculationRunId", NEW."variantId", NEW."productId",
                NEW."productTitle", NEW."productCode", NEW."variantCode", NEW."sku",
                NEW."isDefaultVariant", NEW."categoryIds", NEW."visibleOnSite",
                NEW."branchVisibility", NEW."variantActive", NEW."stock",
                NEW."unvaluedQuantity", NEW."inventoryCostValue", NEW."costBasisRial",
                NEW."currentPriceRial", NEW."rawPrice", NEW."proposedPriceRial",
                NEW."status", NEW."reasons", NEW."calculationMethod",
                NEW."formulaVersion", NEW."calculatedAt")
            IS DISTINCT FROM
            ROW(OLD."planId", OLD."calculationRunId", OLD."variantId", OLD."productId",
                OLD."productTitle", OLD."productCode", OLD."variantCode", OLD."sku",
                OLD."isDefaultVariant", OLD."categoryIds", OLD."visibleOnSite",
                OLD."branchVisibility", OLD."variantActive", OLD."stock",
                OLD."unvaluedQuantity", OLD."inventoryCostValue", OLD."costBasisRial",
                OLD."currentPriceRial", OLD."rawPrice", OLD."proposedPriceRial",
                OLD."status", OLD."reasons", OLD."calculationMethod",
                OLD."formulaVersion", OLD."calculatedAt") THEN
           RAISE EXCEPTION 'pricing_plan_items: calculation snapshot is immutable'
             USING ERRCODE = 'check_violation';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "trg_pricing_plan_items_snapshot_immutable"
         BEFORE UPDATE ON "pricing_plan_items"
         FOR EACH ROW EXECUTE FUNCTION "public"."pricing_plan_items_snapshot_immutable"()`,
    );

    // ------------------------------------------------------ price history
    await queryRunner.query(
      `CREATE TABLE "pricing_price_changes" (
         "id" SERIAL NOT NULL,
         "planId" integer NOT NULL,
         "runId" integer NOT NULL,
         "itemId" integer,
         "variantId" integer NOT NULL,
         "productId" integer NOT NULL,
         "kind" character varying(16) NOT NULL,
         "oldPriceRial" bigint,
         "newPriceRial" bigint,
         "revertsChangeId" integer,
         "calculationMethod" character varying(32) NOT NULL,
         "formulaVersion" smallint NOT NULL,
         "changedByUserId" integer NOT NULL,
         "changedByDisplay" character varying(160) NOT NULL,
         "changedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "pk_pricing_price_changes" PRIMARY KEY ("id"),
         CONSTRAINT "fk_pricing_price_changes_plan" FOREIGN KEY ("planId")
           REFERENCES "pricing_plans"("id") ON DELETE RESTRICT,
         CONSTRAINT "fk_pricing_price_changes_run" FOREIGN KEY ("runId")
           REFERENCES "pricing_plan_runs"("id") ON DELETE RESTRICT,
         CONSTRAINT "fk_pricing_price_changes_item" FOREIGN KEY ("itemId")
           REFERENCES "pricing_plan_items"("id") ON DELETE RESTRICT,
         CONSTRAINT "fk_pricing_price_changes_reverts" FOREIGN KEY ("revertsChangeId")
           REFERENCES "pricing_price_changes"("id") ON DELETE RESTRICT,
         CONSTRAINT "uq_pricing_price_changes_reverts" UNIQUE ("revertsChangeId"),
         CONSTRAINT "chk_pricing_price_changes_kind" CHECK ("kind" IN ('apply', 'rollback')),
         CONSTRAINT "chk_pricing_price_changes_link" CHECK (
           ("kind" = 'rollback') = ("revertsChangeId" IS NOT NULL)),
         CONSTRAINT "chk_pricing_price_changes_money" CHECK (
           ("oldPriceRial" IS NULL OR "oldPriceRial" >= 0)
           AND ("newPriceRial" IS NULL OR "newPriceRial" >= 0))
       )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_pricing_price_changes_plan" ON "pricing_price_changes" ("planId", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_pricing_price_changes_variant"
         ON "pricing_price_changes" ("variantId", "changedAt" DESC)`,
    );
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION "public"."pricing_price_changes_append_only"()
         RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         RAISE EXCEPTION 'pricing_price_changes is append-only'
           USING ERRCODE = 'check_violation';
       END $$`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "trg_pricing_price_changes_append_only"
         BEFORE UPDATE OR DELETE ON "pricing_price_changes"
         FOR EACH ROW EXECUTE FUNCTION "public"."pricing_price_changes_append_only"()`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_pricing_price_changes_append_only" ON "pricing_price_changes"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "public"."pricing_price_changes_append_only"()`,
    );
    await queryRunner.query(`DROP TABLE "pricing_price_changes"`);

    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_pricing_plan_items_snapshot_immutable" ON "pricing_plan_items"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "public"."pricing_plan_items_snapshot_immutable"()`,
    );
    await queryRunner.query(`DROP TABLE "pricing_plan_items"`);

    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_pricing_plan_runs_inputs_immutable" ON "pricing_plan_runs"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "public"."pricing_plan_runs_inputs_immutable"()`,
    );
    await queryRunner.query(`DROP TABLE "pricing_plan_runs"`);

    await queryRunner.query(`DROP TABLE "pricing_plan_cost_entries"`);
    await queryRunner.query(`DROP TABLE "pricing_plans"`);
  }
}
