import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { MAX_RIAL } from 'src/common/money/rial';
import { CatalogCacheService } from 'src/database/cache.service';
import { AuditAction, AuditTarget } from 'src/modules/audit/audit.actions';
import { AuditActor, AuditService } from 'src/modules/audit/audit.service';
import { averageUnitCost } from 'src/modules/inventory/valuation/valuation';
import { RealtimeGateway } from 'src/modules/realtime/realtime.gateway';

import {
  PRICING_ITEM_STATUS,
  ReviewRules,
  TargetRevenueInputs,
  evaluateVariant,
} from './pricing-formula';
import {
  PricingErrorCode,
  PricingErrorCodes as E,
  PricingRunError,
} from './pricing.errors';
import { assertTransition } from './pricing-states';
import {
  APPLICABLE_SQL,
  PLAN_SELECT,
  PlanRow,
  RunRow,
  returned,
} from './pricing.sql';

/** Rows read or written per statement. Bounded so one statement stays small. */
const CHUNK = 500;

/** A `running` run whose heartbeat is older than this is presumed dead. */
const ABANDON_AFTER = '5 minutes';

/**
 * Every run transaction waits at most this long for a row lock (a concurrent
 * checkout, POS sale or product edit holding a variant). Waiting longer would
 * stall the till; failing is safe because the transaction wrote nothing.
 */
const LOCK_TIMEOUT = '10s';

interface CalculationSnapshot {
  calculationMethod: string;
  formulaVersion: number;
  targetMonthlyRevenueRial: string;
  monthlyCostsTotalRial: string;
  taxRateBps: number;
  targetProfitMarginBps: number;
  roundingStepRial: string;
  reviewRules: ReviewRules;
}

const DIGITS = /^(0|[1-9][0-9]*)$/;

/**
 * The calculation's input snapshot, read back from `jsonb` and checked field by
 * field. It was written by this module, but a run must never price from a
 * value it has not verified: a malformed snapshot fails the run (nothing is
 * written) instead of being trusted.
 */
function calculationSnapshotOf(raw: unknown): CalculationSnapshot {
  const bad = () => new PricingRunError(E.PRICING_RUN_FAILED);
  if (typeof raw !== 'object' || raw === null) throw bad();
  const snap: Record<string, unknown> = { ...raw };
  const text = (key: string): string => {
    const value = snap[key];
    if (typeof value !== 'string' || !DIGITS.test(value)) throw bad();
    return value;
  };
  const int = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isInteger(value)) throw bad();
    return value;
  };
  const rules = snap.reviewRules;
  if (typeof rules !== 'object' || rules === null) throw bad();
  const review: Record<string, unknown> = { ...rules };
  if (typeof review.reviewDecreases !== 'boolean') throw bad();
  if (typeof snap.calculationMethod !== 'string') throw bad();
  return {
    calculationMethod: snap.calculationMethod,
    formulaVersion: int(snap.formulaVersion),
    targetMonthlyRevenueRial: text('targetMonthlyRevenueRial'),
    monthlyCostsTotalRial: text('monthlyCostsTotalRial'),
    taxRateBps: int(snap.taxRateBps),
    targetProfitMarginBps: int(snap.targetProfitMarginBps),
    roundingStepRial: text('roundingStepRial'),
    reviewRules: {
      maxIncreaseBpsWithoutReview: int(review.maxIncreaseBpsWithoutReview),
      reviewDecreases: review.reviewDecreases,
    },
  };
}

interface VariantFactsRow {
  variantId: number;
  productId: number;
  productTitle: string;
  productCode: string;
  variantCode: string;
  sku: string;
  isDefault: boolean;
  isActive: boolean;
  price: string | null;
  stock: number;
  unvaluedQuantity: number;
  inventoryCostValue: string;
  visibleOnSite: boolean;
  branchVisibility: string;
  categoryIds: number[] | null;
}

const VARIANT_FACTS_SELECT = `
  SELECT v."id" AS "variantId", p."id" AS "productId", p."title" AS "productTitle",
         p."productCode", v."variantCode", v."sku", v."isDefault", v."isActive",
         v."price"::text AS "price", v."stock", v."unvaluedQuantity",
         v."inventoryCostValue"::text AS "inventoryCostValue",
         p."visibleOnSite", p."branchVisibility"::text AS "branchVisibility",
         (SELECT array_agg(pc."category_id" ORDER BY pc."category_id")
            FROM "product_category" pc WHERE pc."product_id" = p."id") AS "categoryIds"
    FROM "product_variants" v
    JOIN "products" p ON p."id" = v."productId"`;

interface Touched {
  variantIds: number[];
  productIds: number[];
}

function offered(row: {
  visibleOnSite: boolean;
  branchVisibility: string;
}): boolean {
  return row.visibleOnSite === true || row.branchVisibility !== 'none';
}

/** The EXISTING weighted average (valuation.ts), never re-derived here. */
function averageOf(row: {
  stock: number;
  unvaluedQuantity: number;
  inventoryCostValue: string;
}) {
  return averageUnitCost({
    stock: Number(row.stock),
    unvaluedQuantity: Number(row.unvaluedQuantity),
    value: BigInt(row.inventoryCostValue),
  });
}

function actorOf(run: RunRow): AuditActor {
  return {
    userId: Number(run.requestedByUserId),
    display: run.requestedByDisplay,
    audience: 'admin',
    requestId: null,
  };
}

/**
 * Executes calculate / apply / rollback runs (docs/MONTHLY-PRICING.md §6).
 *
 * Kazhal has no queue system; its background work is DB-backed rows claimed
 * with `FOR UPDATE SKIP LOCKED` by an in-process worker (object deletion,
 * fulfilment recovery, the reservation sweeper). This follows the same shape:
 *
 *  - the HTTP request commits a `queued` run and returns 202 at once;
 *  - `kick()` drains the queue in this process immediately, and an unref'd
 *    interval picks up anything a crashed process left behind;
 *  - each run executes in ONE transaction, so it either completes entirely or
 *    changes nothing;
 *  - progress is written on a SEPARATE connection, so the console can poll it
 *    while the run's transaction is still open (the run transaction never
 *    touches the run row until its final statement, so the two never wait on
 *    each other).
 */
@Injectable()
export class PricingRunnerService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(PricingRunnerService.name);
  private timer: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private readonly active = new Set<number>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly catalogCache: CatalogCacheService,
    private readonly realtime: RealtimeGateway,
  ) {}

  onModuleInit(): void {
    const enabled =
      (process.env.PRICING_RUNNER_ENABLED ??
        (process.env.NODE_ENV === 'test' ? 'false' : 'true')) !== 'false';
    const interval = Number(process.env.PRICING_RUNNER_INTERVAL_MS ?? 15_000);
    if (enabled && Number.isFinite(interval) && interval >= 1_000) {
      this.timer = setInterval(() => this.kick(), interval);
      this.timer.unref();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.draining;
  }

  /** Process queued runs soon, in this process. Never throws. */
  kick(): void {
    if (this.stopped) return;
    if (this.draining) {
      this.again = true;
      return;
    }
    this.draining = (async () => {
      try {
        do {
          this.again = false;
          await this.recoverAbandoned();
          for (;;) {
            if (this.stopped) return;
            const run = await this.claim();
            if (!run) break;
            await this.process(run);
          }
        } while (this.again && !this.stopped);
      } catch (error) {
        this.logger.error(
          `pricing runner pass failed: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      } finally {
        this.draining = null;
      }
    })();
  }

  /** Resolves when the current pass (if any) is finished. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  // --------------------------------------------------------------------------

  private async claim(): Promise<RunRow | null> {
    const rows = returned<RunRow>(
      await this.dataSource.query(
        `UPDATE "pricing_plan_runs"
          SET "status" = 'running', "startedAt" = now(), "heartbeatAt" = now(), "phase" = 'starting'
        WHERE "id" = (SELECT "id" FROM "pricing_plan_runs"
                       WHERE "status" = 'queued' ORDER BY "id" LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      ),
    );
    return rows[0] ?? null;
  }

  private async recoverAbandoned(): Promise<void> {
    const abandoned = returned<{ id: number; planId: number; kind: string }>(
      await this.dataSource.query(
        `UPDATE "pricing_plan_runs"
          SET "status" = 'failed', "errorCode" = $1, "finishedAt" = now()
        WHERE "status" = 'running' AND "heartbeatAt" < now() - interval '${ABANDON_AFTER}'
          AND NOT ("id" = ANY($2::int[]))
        RETURNING "id", "planId", "kind"`,
        [E.PRICING_RUN_ABANDONED, [...this.active]],
      ),
    );
    for (const run of abandoned) {
      // The dead process's transaction rolled back with its connection: nothing
      // was written, so the plan is released for a retry.
      await this.dataSource.query(
        `UPDATE "pricing_plans"
            SET "status" = 'FAILED', "lastErrorCode" = $2, "updatedAt" = now()
          WHERE "id" = $1 AND "status" IN ('CALCULATING', 'APPLYING')`,
        [run.planId, E.PRICING_RUN_ABANDONED],
      );
      this.logger.warn(`pricing run ${run.id} (${run.kind}) abandoned`);
    }
  }

  private async progress(
    runId: number,
    phase: string,
    processed: number,
    total: number,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE "pricing_plan_runs"
          SET "phase" = $2,
              "totalItems" = GREATEST("totalItems", $3, $4),
              "processedItems" = $4,
              "heartbeatAt" = now()
        WHERE "id" = $1`,
      [runId, phase, total, processed],
    );
  }

  private async process(run: RunRow): Promise<void> {
    this.active.add(Number(run.id));
    const touched: Touched = { variantIds: [], productIds: [] };
    try {
      if (run.kind === 'calculate') await this.calculate(run);
      else if (run.kind === 'apply') await this.apply(run, touched);
      else if (run.kind === 'rollback') await this.rollback(run, touched);
    } catch (error) {
      await this.fail(run, error);
    } finally {
      this.active.delete(Number(run.id));
    }
    // After commit, outside any transaction: the catalogue caches and the
    // advisory `availability:invalidated` frame (ids only, no price).
    if (touched.variantIds.length > 0) {
      try {
        await this.catalogCache.invalidateProducts(touched.productIds);
        await this.realtime.publishAvailabilityInvalidation(
          touched.variantIds,
          'catalogue',
        );
      } catch {
        this.logger.warn(
          `pricing run ${run.id}: post-commit announcement failed`,
        );
      }
    }
  }

  private async fail(run: RunRow, error: unknown): Promise<void> {
    const pgCode = (error as { code?: string })?.code;
    const code: PricingErrorCode =
      error instanceof PricingRunError
        ? error.code
        : pgCode === '55P03' || pgCode === '40P01'
          ? E.PRICING_LOCK_TIMEOUT
          : E.PRICING_RUN_FAILED;
    // Codes and names only: a database error can quote the row it refused.
    this.logger.warn(
      `pricing run ${run.id} (${run.kind}) failed: ${code}${pgCode ? ` [pg ${pgCode}]` : ''}`,
    );
    await this.dataSource.transaction(async (manager) => {
      const [plan]: { status: string }[] = await manager.query(
        `SELECT "status" FROM "pricing_plans" WHERE "id" = $1 FOR UPDATE`,
        [run.planId],
      );
      await manager.query(
        `UPDATE "pricing_plan_runs"
            SET "status" = 'failed', "errorCode" = $2, "finishedAt" = now(),
                "result" = COALESCE($3::jsonb, "result")
          WHERE "id" = $1 AND "status" = 'running'`,
        [
          run.id,
          code,
          error instanceof PricingRunError && error.result
            ? JSON.stringify(error.result)
            : null,
        ],
      );
      if (!plan) return;
      if (
        run.kind !== 'rollback' &&
        ['CALCULATING', 'APPLYING'].includes(plan.status)
      ) {
        assertTransition(plan.status, 'FAILED');
        await manager.query(
          `UPDATE "pricing_plans" SET "status" = 'FAILED', "lastErrorCode" = $2, "updatedAt" = now()
            WHERE "id" = $1`,
          [run.planId, code],
        );
      } else {
        await manager.query(
          `UPDATE "pricing_plans" SET "lastErrorCode" = $2, "updatedAt" = now() WHERE "id" = $1`,
          [run.planId, code],
        );
      }
    });
  }

  private async lockPlan(
    manager: EntityManager,
    planId: number,
    expected: string,
  ): Promise<PlanRow> {
    const [plan]: PlanRow[] = await manager.query(
      `${PLAN_SELECT} WHERE p."id" = $1 FOR UPDATE`,
      [planId],
    );
    if (!plan || plan.status !== expected)
      throw new PricingRunError(E.PRICING_PLAN_STATE_CONFLICT);
    return plan;
  }

  private async finish(
    manager: EntityManager,
    runId: number,
    result: Record<string, unknown>,
  ) {
    await manager.query(
      `UPDATE "pricing_plan_runs"
          SET "status" = 'succeeded', "phase" = 'done', "result" = $2::jsonb,
              "processedItems" = "totalItems", "finishedAt" = now(), "heartbeatAt" = now()
        WHERE "id" = $1`,
      [runId, JSON.stringify(result)],
    );
  }

  // ==========================================================================
  // CALCULATE — evaluate every variant from the immutable input snapshot
  // ==========================================================================

  private async calculate(run: RunRow): Promise<void> {
    const snap = calculationSnapshotOf(run.inputsSnapshot);
    const inputs: TargetRevenueInputs = {
      monthlyCostsTotalRial: BigInt(snap.monthlyCostsTotalRial),
      targetMonthlyRevenueRial: BigInt(snap.targetMonthlyRevenueRial),
      taxRateBps: snap.taxRateBps,
      targetProfitMarginBps: snap.targetProfitMarginBps,
      roundingStepRial: BigInt(snap.roundingStepRial),
    };
    const [{ total }]: { total: number }[] = await this.dataSource.query(
      `SELECT count(*)::int AS total FROM "product_variants"`,
    );
    await this.progress(run.id, 'evaluating', 0, total);

    await this.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      const plan = await this.lockPlan(manager, run.planId, 'CALCULATING');
      await manager.query(
        `DELETE FROM "pricing_plan_items" WHERE "planId" = $1`,
        [plan.id],
      );

      const counts = {
        evaluated: 0,
        ready: 0,
        unchanged: 0,
        needsReview: 0,
        blocked: 0,
      };
      let after = 0;
      for (;;) {
        const rows: VariantFactsRow[] = await manager.query(
          `${VARIANT_FACTS_SELECT} WHERE v."id" > $1 ORDER BY v."id" LIMIT $2`,
          [after, CHUNK],
        );
        if (rows.length === 0) break;
        const records = rows.map((row) => {
          const evaluation = evaluateVariant(
            {
              isActive: row.isActive === true,
              offered: offered(row),
              stock: Number(row.stock),
              unvaluedQuantity: Number(row.unvaluedQuantity),
              averageUnitCost: averageOf(row),
              currentPrice: row.price === null ? null : BigInt(row.price),
            },
            inputs,
            snap.reviewRules,
            BigInt(MAX_RIAL),
          );
          counts.evaluated += 1;
          if (evaluation.status === PRICING_ITEM_STATUS.READY)
            counts.ready += 1;
          else if (evaluation.status === PRICING_ITEM_STATUS.UNCHANGED)
            counts.unchanged += 1;
          else if (evaluation.status === PRICING_ITEM_STATUS.NEEDS_REVIEW)
            counts.needsReview += 1;
          else counts.blocked += 1;
          return {
            variantId: Number(row.variantId),
            productId: Number(row.productId),
            productTitle: row.productTitle,
            productCode: row.productCode,
            variantCode: row.variantCode,
            sku: row.sku,
            isDefaultVariant: row.isDefault === true,
            categoryIds: (row.categoryIds ?? []).map(Number),
            visibleOnSite: row.visibleOnSite === true,
            branchVisibility: row.branchVisibility,
            variantActive: row.isActive === true,
            stock: Number(row.stock),
            unvaluedQuantity: Number(row.unvaluedQuantity),
            inventoryCostValue: row.inventoryCostValue,
            costBasisRial:
              evaluation.costBasis === null
                ? null
                : evaluation.costBasis.toString(),
            currentPriceRial: row.price,
            rawPrice: evaluation.rawPrice,
            proposedPriceRial:
              evaluation.proposedPrice === null
                ? null
                : evaluation.proposedPrice.toString(),
            status: evaluation.status,
            reasons: evaluation.reasons,
            // READY rows start included; every other row needs a decision.
            included: evaluation.status === PRICING_ITEM_STATUS.READY,
          };
        });
        await manager.query(
          `INSERT INTO "pricing_plan_items"
             ("planId", "calculationRunId", "variantId", "productId", "productTitle", "productCode",
              "variantCode", "sku", "isDefaultVariant", "categoryIds", "visibleOnSite",
              "branchVisibility", "variantActive", "stock", "unvaluedQuantity", "inventoryCostValue",
              "costBasisRial", "currentPriceRial", "rawPrice", "proposedPriceRial", "status",
              "reasons", "included", "calculationMethod", "formulaVersion", "calculatedAt")
           SELECT $1, $2, x."variantId", x."productId", x."productTitle", x."productCode",
                  x."variantCode", x."sku", x."isDefaultVariant",
                  ARRAY(SELECT jsonb_array_elements_text(x."categoryIds"))::int[],
                  x."visibleOnSite", x."branchVisibility", x."variantActive", x."stock",
                  x."unvaluedQuantity", x."inventoryCostValue"::bigint, x."costBasisRial"::bigint,
                  x."currentPriceRial"::bigint, x."rawPrice"::numeric, x."proposedPriceRial"::bigint,
                  x."status", ARRAY(SELECT jsonb_array_elements_text(x."reasons")),
                  x."included", $3, $4, now()
             FROM jsonb_to_recordset($5::jsonb) AS x(
                  "variantId" int, "productId" int, "productTitle" text, "productCode" text,
                  "variantCode" text, "sku" text, "isDefaultVariant" boolean, "categoryIds" jsonb,
                  "visibleOnSite" boolean, "branchVisibility" text, "variantActive" boolean,
                  "stock" int, "unvaluedQuantity" int, "inventoryCostValue" text,
                  "costBasisRial" text, "currentPriceRial" text, "rawPrice" text,
                  "proposedPriceRial" text, "status" text, "reasons" jsonb, "included" boolean)`,
          [
            plan.id,
            run.id,
            snap.calculationMethod,
            snap.formulaVersion,
            JSON.stringify(records),
          ],
        );
        after = Number(rows[rows.length - 1].variantId);
        await this.progress(run.id, 'evaluating', counts.evaluated, total);
      }

      if (counts.ready + counts.unchanged + counts.needsReview === 0) {
        throw new PricingRunError(E.PRICING_NO_ELIGIBLE_VARIANTS, {
          ...counts,
        });
      }
      assertTransition(plan.status, 'READY_FOR_REVIEW');
      await manager.query(
        `UPDATE "pricing_plans"
            SET "status" = 'READY_FOR_REVIEW', "calculatedAt" = now(), "approvedAt" = NULL,
                "approvedByUserId" = NULL, "lastErrorCode" = NULL, "updatedAt" = now()
          WHERE "id" = $1`,
        [plan.id],
      );
      await this.audit.record(
        {
          actor: actorOf(run),
          action: AuditAction.PRICING_PLAN_CALCULATED,
          targetType: AuditTarget.PRICING_PLAN,
          targetId: plan.id,
          targetLabel: plan.title,
          summary: {
            planId: Number(plan.id),
            runId: Number(run.id),
            ...counts,
          },
        },
        manager,
      );
      await this.finish(manager, run.id, counts);
    });
  }

  // ==========================================================================
  // APPLY — all selected prices, or none; stale rows abort the whole batch
  // ==========================================================================

  private async apply(run: RunRow, touched: Touched) {
    const written: { value: Touched | null } = { value: null };
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      const plan = await this.lockPlan(manager, run.planId, 'APPLYING');

      const items: {
        id: number;
        variantId: number;
        productId: number;
        currentPriceRial: string | null;
        costBasisRial: string | null;
        finalPriceRial: string;
      }[] = await manager.query(
        `SELECT i."id", i."variantId", i."productId",
                i."currentPriceRial"::text AS "currentPriceRial",
                i."costBasisRial"::text AS "costBasisRial",
                i."finalPriceRial"::text AS "finalPriceRial"
           FROM "pricing_plan_items" i
          WHERE i."planId" = $1 AND ${APPLICABLE_SQL}
          ORDER BY i."variantId"`,
        [plan.id],
      );
      if (items.length !== Number(run.expectedChangeCount)) {
        throw new PricingRunError(E.PRICING_APPLY_COUNT_MISMATCH, {
          applicableCount: items.length,
        });
      }
      await this.progress(run.id, 'locking', 0, items.length);

      // The global lock order: product_variants by ascending id (checkout, POS
      // and the product editor take the same order, so nothing can deadlock).
      const locked: {
        id: number;
        price: string | null;
        isActive: boolean;
        stock: number;
        unvaluedQuantity: number;
        inventoryCostValue: string;
        visibleOnSite: boolean;
        branchVisibility: string;
      }[] = await manager.query(
        `SELECT v."id", v."price"::text AS "price", v."isActive", v."stock", v."unvaluedQuantity",
                v."inventoryCostValue"::text AS "inventoryCostValue",
                p."visibleOnSite", p."branchVisibility"::text AS "branchVisibility"
           FROM "product_variants" v JOIN "products" p ON p."id" = v."productId"
          WHERE v."id" = ANY($1::int[])
          ORDER BY v."id"
          FOR UPDATE OF v`,
        [items.map((item) => item.variantId)],
      );
      const live = new Map(locked.map((row) => [Number(row.id), row]));

      await this.progress(run.id, 'verifying', 0, items.length);
      const stale: { id: number; reason: string }[] = [];
      for (const item of items) {
        const row = live.get(Number(item.variantId));
        if (!row) {
          stale.push({ id: item.id, reason: 'VARIANT_MISSING' });
        } else if (row.price !== item.currentPriceRial) {
          stale.push({ id: item.id, reason: 'PRICE_CHANGED' });
        } else if (!row.isActive || !offered(row)) {
          stale.push({ id: item.id, reason: 'NO_LONGER_SELLABLE' });
        } else if (Number(row.unvaluedQuantity) > 0) {
          stale.push({ id: item.id, reason: 'COST_NOW_UNKNOWN' });
        } else {
          const average = averageOf(row);
          if (average === null || average.toString() !== item.costBasisRial) {
            stale.push({ id: item.id, reason: 'COST_CHANGED' });
          }
        }
      }

      if (stale.length > 0) {
        // Nothing is written to any price. The stale rows are marked and taken
        // out, the approval is withdrawn, and this is committed so the console
        // can show exactly which rows went out of date.
        await manager.query(
          `UPDATE "pricing_plan_items" i
              SET "stale" = true, "staleReason" = x."reason", "included" = false,
                  "reviewedByUserId" = NULL, "reviewedAt" = NULL
             FROM jsonb_to_recordset($2::jsonb) AS x("id" int, "reason" text)
            WHERE i."id" = x."id" AND i."planId" = $1`,
          [plan.id, JSON.stringify(stale)],
        );
        assertTransition(plan.status, 'READY_FOR_REVIEW');
        await manager.query(
          `UPDATE "pricing_plans"
              SET "status" = 'READY_FOR_REVIEW', "approvedAt" = NULL, "approvedByUserId" = NULL,
                  "lastErrorCode" = $2, "updatedAt" = now()
            WHERE "id" = $1`,
          [plan.id, E.PRICING_PREVIEW_STALE],
        );
        await manager.query(
          `UPDATE "pricing_plan_runs"
              SET "status" = 'failed', "errorCode" = $2, "finishedAt" = now(),
                  "result" = $3::jsonb
            WHERE "id" = $1`,
          [
            run.id,
            E.PRICING_PREVIEW_STALE,
            JSON.stringify({ staleCount: stale.length, changed: 0 }),
          ],
        );
        return;
      }

      let done = 0;
      for (let start = 0; start < items.length; start += CHUNK) {
        const chunk = items.slice(start, start + CHUNK);
        const payload = JSON.stringify(
          chunk.map((item) => ({
            id: item.variantId,
            price: item.finalPriceRial,
          })),
        );
        // A price-only UPDATE: the valuation pool guard never sees a pool column.
        await manager.query(
          `UPDATE "product_variants" v SET "price" = x."price"::bigint
             FROM jsonb_to_recordset($1::jsonb) AS x("id" int, "price" text)
            WHERE v."id" = x."id"`,
          [payload],
        );
        await manager.query(
          `INSERT INTO "pricing_price_changes"
             ("planId", "runId", "itemId", "variantId", "productId", "kind", "oldPriceRial",
              "newPriceRial", "calculationMethod", "formulaVersion", "changedByUserId", "changedByDisplay")
           SELECT $1, $2, x."itemId", x."variantId", x."productId", 'apply', x."oldPrice"::bigint,
                  x."newPrice"::bigint, $3, $4, $5, $6
             FROM jsonb_to_recordset($7::jsonb) AS x(
                  "itemId" int, "variantId" int, "productId" int, "oldPrice" text, "newPrice" text)`,
          [
            plan.id,
            run.id,
            run.calculationMethod,
            run.formulaVersion,
            run.requestedByUserId,
            run.requestedByDisplay,
            JSON.stringify(
              chunk.map((item) => ({
                itemId: item.id,
                variantId: item.variantId,
                productId: item.productId,
                oldPrice: item.currentPriceRial,
                newPrice: item.finalPriceRial,
              })),
            ),
          ],
        );
        done += chunk.length;
        await this.progress(run.id, 'writing', done, items.length);
      }

      assertTransition(plan.status, 'APPLIED');
      await manager.query(
        `UPDATE "pricing_plans"
            SET "status" = 'APPLIED', "appliedAt" = now(), "appliedByUserId" = $2,
                "lastErrorCode" = NULL, "updatedAt" = now()
          WHERE "id" = $1`,
        [plan.id, run.requestedByUserId],
      );
      const productIds = [
        ...new Set(items.map((item) => Number(item.productId))),
      ];
      await this.audit.record(
        {
          actor: actorOf(run),
          action: AuditAction.PRICING_PLAN_APPLIED,
          targetType: AuditTarget.PRICING_PLAN,
          targetId: plan.id,
          targetLabel: plan.title,
          summary: {
            planId: Number(plan.id),
            runId: Number(run.id),
            variantsChanged: items.length,
            productsChanged: productIds.length,
          },
        },
        manager,
      );
      await this.finish(manager, run.id, {
        changed: items.length,
        products: productIds.length,
      });
      written.value = {
        variantIds: items.map((item) => Number(item.variantId)),
        productIds,
      };
    });
    // Only after the transaction committed.
    if (written.value) Object.assign(touched, written.value);
  }

  // ==========================================================================
  // ROLLBACK — restore what this plan wrote, never overwrite a later change
  // ==========================================================================

  private async rollback(run: RunRow, touched: Touched) {
    const written: { value: Touched | null } = { value: null };
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      const plan = await this.lockPlan(manager, run.planId, 'APPLIED');

      const changes: {
        id: number;
        itemId: number | null;
        variantId: number;
        productId: number;
        oldPriceRial: string | null;
        newPriceRial: string | null;
      }[] = await manager.query(
        `SELECT c."id", c."itemId", c."variantId", c."productId",
                c."oldPriceRial"::text AS "oldPriceRial", c."newPriceRial"::text AS "newPriceRial"
           FROM "pricing_price_changes" c
          WHERE c."planId" = $1 AND c."kind" = 'apply'
            AND NOT EXISTS (SELECT 1 FROM "pricing_price_changes" r WHERE r."revertsChangeId" = c."id")
          ORDER BY c."variantId"`,
        [plan.id],
      );
      await this.progress(run.id, 'locking', 0, changes.length);
      const locked: { id: number; price: string | null }[] =
        await manager.query(
          `SELECT v."id", v."price"::text AS "price" FROM "product_variants" v
          WHERE v."id" = ANY($1::int[]) ORDER BY v."id" FOR UPDATE`,
          [changes.map((change) => change.variantId)],
        );
      const live = new Map(locked.map((row) => [Number(row.id), row.price]));

      const restorable: typeof changes = [];
      const conflicts: {
        changeId: number;
        variantId: number;
        productId: number;
        appliedPriceRial: string | null;
        currentPriceRial: string | null;
      }[] = [];
      for (const change of changes) {
        const current = live.has(Number(change.variantId))
          ? live.get(Number(change.variantId))
          : undefined;
        if (current !== undefined && current === change.newPriceRial) {
          restorable.push(change);
        } else {
          // Changed again after this plan applied (by hand, by another plan) or
          // gone: that later price is legitimate and is never overwritten.
          conflicts.push({
            changeId: Number(change.id),
            variantId: Number(change.variantId),
            productId: Number(change.productId),
            appliedPriceRial: change.newPriceRial,
            currentPriceRial: current ?? null,
          });
        }
      }

      let done = 0;
      for (let start = 0; start < restorable.length; start += CHUNK) {
        const chunk = restorable.slice(start, start + CHUNK);
        await manager.query(
          `UPDATE "product_variants" v SET "price" = x."price"::bigint
             FROM jsonb_to_recordset($1::jsonb) AS x("id" int, "price" text)
            WHERE v."id" = x."id"`,
          [
            JSON.stringify(
              chunk.map((change) => ({
                id: change.variantId,
                price: change.oldPriceRial,
              })),
            ),
          ],
        );
        await manager.query(
          `INSERT INTO "pricing_price_changes"
             ("planId", "runId", "itemId", "variantId", "productId", "kind", "oldPriceRial",
              "newPriceRial", "revertsChangeId", "calculationMethod", "formulaVersion",
              "changedByUserId", "changedByDisplay")
           SELECT $1, $2, x."itemId", x."variantId", x."productId", 'rollback', x."oldPrice"::bigint,
                  x."newPrice"::bigint, x."revertsChangeId", $3, $4, $5, $6
             FROM jsonb_to_recordset($7::jsonb) AS x(
                  "itemId" int, "variantId" int, "productId" int, "oldPrice" text,
                  "newPrice" text, "revertsChangeId" int)`,
          [
            plan.id,
            run.id,
            run.calculationMethod,
            run.formulaVersion,
            run.requestedByUserId,
            run.requestedByDisplay,
            JSON.stringify(
              chunk.map((change) => ({
                itemId: change.itemId,
                variantId: change.variantId,
                productId: change.productId,
                oldPrice: change.newPriceRial,
                newPrice: change.oldPriceRial,
                revertsChangeId: change.id,
              })),
            ),
          ],
        );
        done += chunk.length;
        await this.progress(run.id, 'restoring', done, changes.length);
      }

      assertTransition(plan.status, 'ROLLED_BACK');
      await manager.query(
        `UPDATE "pricing_plans"
            SET "status" = 'ROLLED_BACK', "rolledBackAt" = now(), "rolledBackByUserId" = $2,
                "lastErrorCode" = NULL, "updatedAt" = now()
          WHERE "id" = $1`,
        [plan.id, run.requestedByUserId],
      );
      await this.audit.record(
        {
          actor: actorOf(run),
          action: AuditAction.PRICING_PLAN_ROLLED_BACK,
          targetType: AuditTarget.PRICING_PLAN,
          targetId: plan.id,
          targetLabel: plan.title,
          summary: {
            planId: Number(plan.id),
            runId: Number(run.id),
            variantsRestored: restorable.length,
            conflicts: conflicts.length,
          },
        },
        manager,
      );
      await this.finish(manager, run.id, {
        restored: restorable.length,
        conflictCount: conflicts.length,
        conflicts: conflicts.slice(0, 500),
      });
      written.value = {
        variantIds: restorable.map((change) => Number(change.variantId)),
        productIds: [
          ...new Set(restorable.map((change) => Number(change.productId))),
        ],
      };
    });
    // Only after the transaction committed.
    if (written.value) Object.assign(touched, written.value);
  }
}
