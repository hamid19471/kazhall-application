import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { MAX_RIAL } from 'src/common/money/rial';
import { AuditAction, AuditTarget } from 'src/modules/audit/audit.actions';
import { AuditActor, AuditService } from 'src/modules/audit/audit.service';
import { percentString } from 'src/modules/inventory/valuation/valuation';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';

import {
  ApproveOrApplyDto,
  BulkItemsDto,
  ChangesQueryDto,
  CostEntryDto,
  CreatePlanDto,
  ItemListQueryDto,
  PlanListQueryDto,
  PlanStatus,
  ReorderCostEntriesDto,
  UpdateCostEntryDto,
  UpdateItemDto,
  UpdatePlanDto,
} from './dto/pricing.dto';
import {
  MAX_PLAN_RIAL,
  MAX_ROUNDING_STEP_RIAL,
  MIN_ROUNDING_STEP_RIAL,
  PRICING_METHOD,
  TARGET_REVENUE_FORMULA_VERSION,
  TargetRevenueInputs,
  inputProblems,
  percentTextToBps,
  pricingDenominator,
} from './pricing-formula';
import {
  PricingErrorCode,
  PricingErrorCodes as E,
  PricingMessages,
  pricingError,
} from './pricing.errors';
import { PricingRunnerService } from './pricing-runner.service';
import { assertTransition } from './pricing-states';
import {
  APPLICABLE_SQL,
  COST_ENTRY_SELECT,
  CostEntryRow,
  ITEM_SELECT,
  ItemRow,
  PLAN_SELECT,
  PlanRow,
  RUN_SELECT,
  RunRow,
  SUMMARY_SELECT,
  SummaryRow,
  costEntryView,
  itemOrderBy,
  itemView,
  itemWhere,
  planFieldsView,
  returned,
} from './pricing.sql';

export interface PricingPrincipal {
  userId: number;
  roles: UserRoleEnum[];
  actor: AuditActor;
}

/** Run error codes are stored as text; look their message up without a cast. */
const MESSAGE_BY_CODE: ReadonlyMap<string, string> = new Map(
  Object.entries(PricingMessages),
);

/** Inputs and costs may be edited only here; an edit discards the preview. */
const EDITABLE: readonly string[] = ['DRAFT', 'READY_FOR_REVIEW', 'FAILED'];

const PLAN_RIAL = /^(0|[1-9][0-9]*)$/;

/** Integer Rial from a JSON integer or a base-10 string, within [min, max]. */
export function parseRialField(raw: unknown, min: bigint, max: bigint): bigint {
  let value: bigint;
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw))
      throw pricingError.badRequest(E.PRICING_AMOUNT_INVALID);
    value = BigInt(raw);
  } else if (typeof raw === 'string' && PLAN_RIAL.test(raw.trim())) {
    value = BigInt(raw.trim());
  } else if (typeof raw === 'string' && /^-\d+$/.test(raw.trim())) {
    throw pricingError.badRequest(E.AMOUNT_NEGATIVE);
  } else {
    throw pricingError.badRequest(E.PRICING_AMOUNT_INVALID);
  }
  if (value < 0n) throw pricingError.badRequest(E.AMOUNT_NEGATIVE);
  if (value < min || value > max)
    throw pricingError.badRequest(E.AMOUNT_TOO_LARGE);
  return value;
}

function rate(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const bps = percentTextToBps(text);
  if (bps === null) throw pricingError.badRequest(E.PRICING_RATE_INVALID);
  return bps;
}

function requestHash(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

const KEY = /^[A-Za-z0-9._:-]{8,200}$/;

@Injectable()
export class PricingPlansService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly runner: PricingRunnerService,
  ) {}

  // ==========================================================================
  // Authorization — repeated below the controller's role guard on purpose
  // ==========================================================================

  private assertOwner(principal: PricingPrincipal): void {
    if (!principal?.roles?.includes(UserRoleEnum.superAdmin))
      throw pricingError.forbidden();
  }

  // ==========================================================================
  // Plans
  // ==========================================================================

  async listPlans(query: PlanListQueryDto, principal: PricingPrincipal) {
    this.assertOwner(principal);
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const params: unknown[] = [];
    let where = '';
    if (query.status) {
      params.push(query.status);
      where = `WHERE p."status" = $1`;
    }
    const [{ total }]: { total: number }[] = await this.dataSource.query(
      `SELECT count(*)::int AS total FROM "pricing_plans" p ${where}`,
      params,
    );
    const rows: (PlanRow & { itemCount: number; applicableCount: number })[] =
      await this.dataSource.query(
        `SELECT q.*,
                (SELECT count(*)::int FROM "pricing_plan_items" i WHERE i."planId" = q."id") AS "itemCount",
                (SELECT count(*)::int FROM "pricing_plan_items" i
                  WHERE i."planId" = q."id" AND ${APPLICABLE_SQL}) AS "applicableCount"
           FROM (${PLAN_SELECT} ${where}) q
          ORDER BY q."effectiveYear" DESC, q."effectiveMonth" DESC, q."id" DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, (page - 1) * limit],
      );
    return {
      data: rows.map((row) => ({
        ...planFieldsView(row),
        itemCount: Number(row.itemCount),
        applicableCount: Number(row.applicableCount),
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 0,
    };
  }

  async getPlan(planId: number, principal: PricingPrincipal) {
    this.assertOwner(principal);
    return this.planDetail(this.dataSource.manager, planId);
  }

  async createPlan(dto: CreatePlanDto, principal: PricingPrincipal) {
    this.assertOwner(principal);
    const planId = await this.dataSource.transaction(async (manager) => {
      let source: PlanRow | null = null;
      if (dto.copyFromPlanId !== undefined) {
        const found: PlanRow[] = await manager.query(
          `${PLAN_SELECT} WHERE p."id" = $1`,
          [dto.copyFromPlanId],
        );
        if (found.length === 0)
          throw pricingError.notFound(E.PRICING_COPY_SOURCE_NOT_FOUND);
        source = found[0];
      }
      const [{ id }]: { id: number }[] = await manager.query(
        `INSERT INTO "pricing_plans"
           ("title", "effectiveYear", "effectiveMonth", "calculationMethod", "formulaVersion",
            "targetMonthlyRevenueRial", "taxRateBps", "targetProfitMarginBps", "roundingStepRial",
            "reviewMaxIncreaseBps", "reviewDecreases", "notes", "copiedFromPlanId", "createdByUserId")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::bigint, 1000),
                 COALESCE($10::int, 2000), COALESCE($11::boolean, true), $12, $13, $14)
         RETURNING "id"`,
        [
          dto.title,
          dto.effectiveYear,
          dto.effectiveMonth,
          PRICING_METHOD.TARGET_REVENUE,
          TARGET_REVENUE_FORMULA_VERSION,
          source?.targetMonthlyRevenueRial ?? null,
          source?.taxRateBps ?? null,
          source?.targetProfitMarginBps ?? null,
          source?.roundingStepRial ?? null,
          source?.reviewMaxIncreaseBps ?? null,
          source?.reviewDecreases ?? null,
          source?.notes ?? null,
          source?.id ?? null,
          principal.userId,
        ],
      );
      if (source) {
        await manager.query(
          `INSERT INTO "pricing_plan_cost_entries"
             ("planId", "title", "amountRial", "scope", "branchId", "note", "isActive", "sortOrder")
           SELECT $1, "title", "amountRial", "scope", "branchId", "note", "isActive", "sortOrder"
             FROM "pricing_plan_cost_entries" WHERE "planId" = $2
            ORDER BY "sortOrder", "id"`,
          [id, source.id],
        );
      }
      await this.audit.record(
        {
          actor: principal.actor,
          action: AuditAction.PRICING_PLAN_CREATED,
          targetType: AuditTarget.PRICING_PLAN,
          targetId: id,
          targetLabel: dto.title,
          summary: { planId: id, copiedFromPlanId: source?.id ?? null },
        },
        manager,
      );
      return Number(id);
    });
    return this.planDetail(this.dataSource.manager, planId);
  }

  async updatePlan(
    planId: number,
    dto: UpdatePlanDto,
    principal: PricingPrincipal,
  ) {
    this.assertOwner(principal);
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`"${column}" = $${params.length}`);
    };
    const changed: string[] = [];
    const track = (field: string, column: string, value: unknown) => {
      if (value === undefined) return;
      set(column, value);
      changed.push(field);
    };

    track('title', 'title', dto.title);
    track('effectiveYear', 'effectiveYear', dto.effectiveYear);
    track('effectiveMonth', 'effectiveMonth', dto.effectiveMonth);
    if (dto.targetMonthlyRevenueRial !== undefined) {
      const value =
        dto.targetMonthlyRevenueRial === null
          ? null
          : parseRialField(
              dto.targetMonthlyRevenueRial,
              0n,
              MAX_PLAN_RIAL,
            ).toString();
      track('targetMonthlyRevenueRial', 'targetMonthlyRevenueRial', value);
    }
    const tax = rate(dto.taxRatePercent);
    if (tax !== undefined && tax >= 10_000)
      throw pricingError.badRequest(E.TAX_RATE_OUT_OF_RANGE);
    track('taxRatePercent', 'taxRateBps', tax);
    const profit = rate(dto.targetProfitMarginPercent);
    if (profit !== undefined && profit >= 10_000) {
      throw pricingError.badRequest(E.PROFIT_MARGIN_OUT_OF_RANGE);
    }
    track('targetProfitMarginPercent', 'targetProfitMarginBps', profit);
    if (dto.roundingStepRial !== undefined) {
      let step: bigint;
      try {
        step = parseRialField(
          dto.roundingStepRial,
          MIN_ROUNDING_STEP_RIAL,
          MAX_ROUNDING_STEP_RIAL,
        );
      } catch {
        throw pricingError.badRequest(E.ROUNDING_STEP_INVALID);
      }
      track('roundingStepRial', 'roundingStepRial', step.toString());
    }
    if (dto.reviewMaxIncreasePercent !== undefined) {
      const match = /^(\d{1,5})(?:\.(\d{1,2}))?$/.exec(
        dto.reviewMaxIncreasePercent,
      );
      if (!match) throw pricingError.badRequest(E.PRICING_RATE_INVALID);
      const bps =
        Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
      if (bps > 1_000_000)
        throw pricingError.badRequest(E.PRICING_RATE_INVALID);
      track('reviewMaxIncreasePercent', 'reviewMaxIncreaseBps', bps);
    }
    track('reviewDecreases', 'reviewDecreases', dto.reviewDecreases);
    track('notes', 'notes', dto.notes);

    await this.dataSource.transaction(async (manager) => {
      const plan = await this.lockPlan(manager, planId);
      this.assertEditable(plan);
      if (sets.length === 0) return;
      await manager.query(
        `UPDATE "pricing_plans" SET ${sets.join(', ')}, "updatedAt" = now()
          WHERE "id" = $${params.length + 1}`,
        [...params, planId],
      );
      await this.discardPreview(manager, plan);
      await this.recordUpdated(manager, principal, plan, changed);
    });
    return this.planDetail(this.dataSource.manager, planId);
  }

  async deletePlan(planId: number, principal: PricingPrincipal) {
    this.assertOwner(principal);
    await this.dataSource.transaction(async (manager) => {
      const plan = await this.lockPlan(manager, planId);
      const [{ changes }]: { changes: number }[] = await manager.query(
        `SELECT count(*)::int AS changes FROM "pricing_price_changes" WHERE "planId" = $1`,
        [planId],
      );
      if (!EDITABLE.includes(plan.status) || changes > 0) {
        throw pricingError.conflict(E.PRICING_PLAN_NOT_DELETABLE);
      }
      await this.assertNoActiveRun(manager, planId);
      await manager.query(`DELETE FROM "pricing_plans" WHERE "id" = $1`, [
        planId,
      ]);
      await this.audit.record(
        {
          actor: principal.actor,
          action: AuditAction.PRICING_PLAN_DELETED,
          targetType: AuditTarget.PRICING_PLAN,
          targetId: planId,
          targetLabel: plan.title,
          summary: { planId },
        },
        manager,
      );
    });
    return { deleted: true };
  }

  // ==========================================================================
  // Cost entries
  // ==========================================================================

  async addCostEntry(
    planId: number,
    dto: CostEntryDto,
    principal: PricingPrincipal,
  ) {
    this.assertOwner(principal);
    const amount = parseRialField(dto.amountRial, 0n, MAX_PLAN_RIAL);
    await this.dataSource.transaction(async (manager) => {
      const plan = await this.lockPlan(manager, planId);
      this.assertEditable(plan);
      const { scope, branchId } = await this.resolveScope(
        manager,
        dto.scope,
        dto.branchId,
      );
      await manager.query(
        `INSERT INTO "pricing_plan_cost_entries"
           ("planId", "title", "amountRial", "scope", "branchId", "note", "isActive", "sortOrder")
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 (SELECT COALESCE(max("sortOrder"), 0) + 1
                    FROM "pricing_plan_cost_entries" WHERE "planId" = $1))`,
        [
          planId,
          dto.title,
          amount.toString(),
          scope,
          branchId,
          dto.note ?? null,
          dto.isActive ?? true,
        ],
      );
      await this.discardPreview(manager, plan);
      await this.recordUpdated(manager, principal, plan, ['costEntries']);
    });
    return this.planDetail(this.dataSource.manager, planId);
  }

  async updateCostEntry(
    planId: number,
    entryId: number,
    dto: UpdateCostEntryDto,
    principal: PricingPrincipal,
  ) {
    this.assertOwner(principal);
    const amount =
      dto.amountRial === undefined
        ? undefined
        : parseRialField(dto.amountRial, 0n, MAX_PLAN_RIAL);
    await this.dataSource.transaction(async (manager) => {
      const plan = await this.lockPlan(manager, planId);
      this.assertEditable(plan);
      const [entry]: {
        scope: 'general' | 'branch';
        branchId: number | null;
      }[] = await manager.query(
        `SELECT "scope", "branchId" FROM "pricing_plan_cost_entries" WHERE "id" = $1 AND "planId" = $2`,
        [entryId, planId],
      );
      if (!entry) throw pricingError.notFound(E.PRICING_COST_ENTRY_NOT_FOUND);
      const scopeGiven = dto.scope !== undefined || dto.branchId !== undefined;
      const scoped = scopeGiven
        ? await this.resolveScope(
            manager,
            dto.scope ?? (dto.branchId ? 'branch' : entry.scope),
            dto.branchId === undefined ? entry.branchId : dto.branchId,
          )
        : null;
      await manager.query(
        `UPDATE "pricing_plan_cost_entries"
            SET "title" = COALESCE($3, "title"),
                "amountRial" = COALESCE($4::bigint, "amountRial"),
                "scope" = COALESCE($5, "scope"),
                "branchId" = CASE WHEN $6::boolean THEN $7::int ELSE "branchId" END,
                "note" = CASE WHEN $8::boolean THEN $9 ELSE "note" END,
                "isActive" = COALESCE($10::boolean, "isActive"),
                "updatedAt" = now()
          WHERE "id" = $1 AND "planId" = $2`,
        [
          entryId,
          planId,
          dto.title ?? null,
          amount === undefined ? null : amount.toString(),
          scoped?.scope ?? null,
          scoped !== null,
          scoped?.branchId ?? null,
          dto.note !== undefined,
          dto.note ?? null,
          dto.isActive ?? null,
        ],
      );
      await this.discardPreview(manager, plan);
      await this.recordUpdated(manager, principal, plan, ['costEntries']);
    });
    return this.planDetail(this.dataSource.manager, planId);
  }

  async removeCostEntry(
    planId: number,
    entryId: number,
    principal: PricingPrincipal,
  ) {
    this.assertOwner(principal);
    await this.dataSource.transaction(async (manager) => {
      const plan = await this.lockPlan(manager, planId);
      this.assertEditable(plan);
      const removed = returned<{ id: number }>(
        await manager.query(
          `DELETE FROM "pricing_plan_cost_entries" WHERE "id" = $1 AND "planId" = $2 RETURNING "id"`,
          [entryId, planId],
        ),
      );
      if (removed.length === 0)
        throw pricingError.notFound(E.PRICING_COST_ENTRY_NOT_FOUND);
      await this.discardPreview(manager, plan);
      await this.recordUpdated(manager, principal, plan, ['costEntries']);
    });
    return this.planDetail(this.dataSource.manager, planId);
  }

  async reorderCostEntries(
    planId: number,
    dto: ReorderCostEntriesDto,
    principal: PricingPrincipal,
  ) {
    this.assertOwner(principal);
    await this.dataSource.transaction(async (manager) => {
      const plan = await this.lockPlan(manager, planId);
      this.assertEditable(plan);
      const existing: { id: number }[] = await manager.query(
        `SELECT "id" FROM "pricing_plan_cost_entries" WHERE "planId" = $1`,
        [planId],
      );
      const have = existing.map((row) => Number(row.id)).sort((a, b) => a - b);
      const want = [...dto.entryIds].sort((a, b) => a - b);
      if (
        new Set(dto.entryIds).size !== dto.entryIds.length ||
        have.join() !== want.join()
      ) {
        throw pricingError.badRequest(E.PRICING_REORDER_INVALID);
      }
      await manager.query(
        `UPDATE "pricing_plan_cost_entries" c
            SET "sortOrder" = o.ord, "updatedAt" = now()
           FROM unnest($2::int[]) WITH ORDINALITY AS o(id, ord)
          WHERE c."id" = o.id AND c."planId" = $1`,
        [planId, dto.entryIds],
      );
      // Order alone does not change a price; the preview stays valid.
      await this.recordUpdated(manager, principal, plan, ['costEntryOrder']);
    });
    return this.planDetail(this.dataSource.manager, planId);
  }

  // ==========================================================================
  // Preview
  // ==========================================================================

  async summary(planId: number, principal: PricingPrincipal) {
    this.assertOwner(principal);
    await this.requirePlan(this.dataSource.manager, planId);
    return this.summaryOf(this.dataSource.manager, planId);
  }

  async listItems(
    planId: number,
    query: ItemListQueryDto,
    principal: PricingPrincipal,
  ) {
    this.assertOwner(principal);
    await this.requirePlan(this.dataSource.manager, planId);
    const where = itemWhere(planId, query);
    const [{ total }]: { total: number }[] = await this.dataSource.query(
      `SELECT count(*)::int AS total FROM "pricing_plan_items" i WHERE ${where.clause}`,
      where.params,
    );
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const rows: ItemRow[] = await this.dataSource.query(
      `${ITEM_SELECT} WHERE ${where.clause} ORDER BY ${itemOrderBy(query)}
        LIMIT $${where.params.length + 1} OFFSET $${where.params.length + 2}`,
      [...where.params, limit, (page - 1) * limit],
    );
    return {
      data: rows.map(itemView),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 0,
    };
  }

  async updateItem(
    planId: number,
    itemId: number,
    dto: UpdateItemDto,
    principal: PricingPrincipal,
  ) {
    this.assertOwner(principal);
    const overrideGiven = dto.overridePriceRial !== undefined;
    const override =
      !overrideGiven || dto.overridePriceRial === null
        ? null
        : (() => {
            try {
              return parseRialField(
                dto.overridePriceRial,
                1n,
                BigInt(MAX_RIAL),
              );
            } catch {
              throw pricingError.badRequest(E.PRICING_OVERRIDE_INVALID);
            }
          })();

    await this.dataSource.transaction(async (manager) => {
      const plan = await this.lockPlan(manager, planId);
      if (plan.status !== 'READY_FOR_REVIEW')
        throw pricingError.conflict(E.PRICING_PLAN_NOT_EDITABLE);
      const [item]: {
        id: number;
        status: string;
        stale: boolean;
        costBasisRial: string | null;
        overridePriceRial: string | null;
        included: boolean;
      }[] = await manager.query(
        `SELECT "id", "status", "stale", "costBasisRial"::text AS "costBasisRial",
                "overridePriceRial"::text AS "overridePriceRial", "included"
           FROM "pricing_plan_items" WHERE "id" = $1 AND "planId" = $2 FOR UPDATE`,
        [itemId, planId],
      );
      if (!item) throw pricingError.notFound(E.PRICING_ITEM_NOT_FOUND);
      if (item.status === 'BLOCKED' || item.stale)
        throw pricingError.conflict(E.PRICING_ITEM_BLOCKED);

      let nextOverride: string | null = item.overridePriceRial;
      if (overrideGiven) {
        if (
          override !== null &&
          item.costBasisRial !== null &&
          override < BigInt(item.costBasisRial)
        ) {
          throw pricingError.badRequest(E.PRICING_OVERRIDE_BELOW_COST);
        }
        nextOverride = override === null ? null : override.toString();
      }
      // Setting a manual price is a decision about this row: it includes it.
      let included: boolean =
        dto.included ??
        (overrideGiven && override !== null ? true : item.included);
      if (included && item.status === 'UNCHANGED' && nextOverride === null) {
        if (dto.included === true)
          throw pricingError.conflict(E.PRICING_ITEM_UNCHANGED);
        included = false;
      }

      await manager.query(
        `UPDATE "pricing_plan_items"
            SET "overridePriceRial" = $3::bigint,
                "overriddenByUserId" = CASE WHEN $3::bigint IS NULL THEN NULL
                                            WHEN $5::boolean THEN $4 ELSE "overriddenByUserId" END,
                "overriddenAt" = CASE WHEN $3::bigint IS NULL THEN NULL
                                      WHEN $5::boolean THEN now() ELSE "overriddenAt" END,
                "included" = $6,
                "reviewedByUserId" = CASE WHEN $6 THEN $4 ELSE NULL END,
                "reviewedAt" = CASE WHEN $6 THEN now() ELSE NULL END
          WHERE "id" = $1 AND "planId" = $2`,
        [
          itemId,
          planId,
          nextOverride,
          principal.userId,
          overrideGiven,
          included,
        ],
      );
    });
    const [row]: ItemRow[] = await this.dataSource.query(
      `${ITEM_SELECT} WHERE i."id" = $1`,
      [itemId],
    );
    return itemView(row);
  }

  async bulkItems(
    planId: number,
    dto: BulkItemsDto,
    principal: PricingPrincipal,
  ) {
    this.assertOwner(principal);
    return this.dataSource.transaction(async (manager) => {
      const plan = await this.lockPlan(manager, planId);
      if (plan.status !== 'READY_FOR_REVIEW')
        throw pricingError.conflict(E.PRICING_PLAN_NOT_EDITABLE);
      const where = itemWhere(planId, dto.filters);
      const actor = where.params.length + 1;
      let eligible: string;
      if (dto.included) {
        eligible = `NOT i."stale" AND (
            i."status" = 'READY'
            OR (i."status" = 'UNCHANGED' AND i."overridePriceRial" IS NOT NULL)
            ${dto.approveNeedsReview ? `OR i."status" = 'NEEDS_REVIEW'` : ''})
          AND NOT i."included"`;
      } else {
        eligible = `i."included"`;
      }
      const updated = returned<{ id: number }>(
        await manager.query(
          `UPDATE "pricing_plan_items" i
            SET "included" = ${dto.included ? 'true' : 'false'},
                "reviewedByUserId" = ${dto.included ? `$${actor}::int` : 'NULL'},
                "reviewedAt" = ${dto.included ? 'now()' : 'NULL'}
          WHERE ${where.clause} AND ${eligible}
          RETURNING i."id"`,
          dto.included ? [...where.params, principal.userId] : where.params,
        ),
      );
      return {
        updated: updated.length,
        summary: await this.summaryOf(manager, planId),
      };
    });
  }

  // ==========================================================================
  // Approval
  // ==========================================================================

  async approve(
    planId: number,
    dto: ApproveOrApplyDto,
    principal: PricingPrincipal,
  ) {
    this.assertOwner(principal);
    await this.dataSource.transaction(async (manager) => {
      const plan = await this.lockPlan(manager, planId);
      assertTransition(plan.status, 'APPROVED');
      await this.assertNoActiveRun(manager, planId);
      const applicable = await this.applicableCount(manager, planId);
      if (applicable === 0)
        throw pricingError.conflict(E.PRICING_NOTHING_TO_APPLY);
      if (applicable !== dto.expectedChangeCount) {
        throw pricingError.conflict(E.PRICING_APPLY_COUNT_MISMATCH, {
          applicableCount: applicable,
        });
      }
      await manager.query(
        `UPDATE "pricing_plans"
            SET "status" = 'APPROVED', "approvedAt" = now(), "approvedByUserId" = $2, "updatedAt" = now()
          WHERE "id" = $1`,
        [planId, principal.userId],
      );
      await this.audit.record(
        {
          actor: principal.actor,
          action: AuditAction.PRICING_PLAN_APPROVED,
          targetType: AuditTarget.PRICING_PLAN,
          targetId: planId,
          targetLabel: plan.title,
          summary: { planId, variantsToChange: applicable },
        },
        manager,
      );
    });
    return this.planDetail(this.dataSource.manager, planId);
  }

  async unapprove(planId: number, principal: PricingPrincipal) {
    this.assertOwner(principal);
    await this.dataSource.transaction(async (manager) => {
      const plan = await this.lockPlan(manager, planId);
      if (plan.status !== 'APPROVED') {
        throw pricingError.conflict(E.PRICING_PLAN_STATE_CONFLICT, {
          from: plan.status,
        });
      }
      assertTransition(plan.status, 'READY_FOR_REVIEW');
      await manager.query(
        `UPDATE "pricing_plans"
            SET "status" = 'READY_FOR_REVIEW', "approvedAt" = NULL, "approvedByUserId" = NULL,
                "updatedAt" = now()
          WHERE "id" = $1`,
        [planId],
      );
    });
    return this.planDetail(this.dataSource.manager, planId);
  }

  // ==========================================================================
  // Runs: calculate, apply, rollback — durable, idempotent, processed by the runner
  // ==========================================================================

  async requestCalculation(
    planId: number,
    rawKey: string | undefined,
    principal: PricingPrincipal,
  ) {
    this.assertOwner(principal);
    const key = this.requireKey(rawKey);
    const hash = requestHash({ kind: 'calculate' });
    const run = await this.dataSource.transaction(async (manager) => {
      const plan = await this.lockPlan(manager, planId);
      const replay = await this.replay(manager, planId, 'calculate', key, hash);
      if (replay) return replay;

      assertTransition(plan.status, 'CALCULATING');
      await this.assertNoActiveRun(manager, planId);
      const inputs = this.inputsOf(
        plan,
        await this.activeCostTotal(manager, planId),
      );
      if (!inputs) throw pricingError.badRequest(E.PRICING_INPUTS_INCOMPLETE);
      const problems = inputProblems(inputs);
      if (problems.length > 0) {
        throw pricingError.badRequest(problems[0], { problems });
      }
      if ((await this.eligibleVariantCount(manager)) === 0) {
        throw pricingError.badRequest(E.PRICING_NO_ELIGIBLE_VARIANTS);
      }

      const entries: CostEntryRow[] = await manager.query(
        `${COST_ENTRY_SELECT} WHERE c."planId" = $1 ORDER BY c."sortOrder", c."id"`,
        [planId],
      );
      const snapshot = {
        calculationMethod: plan.calculationMethod,
        formulaVersion: Number(plan.formulaVersion),
        effectiveYear: Number(plan.effectiveYear),
        effectiveMonth: Number(plan.effectiveMonth),
        targetMonthlyRevenueRial: inputs.targetMonthlyRevenueRial.toString(),
        monthlyCostsTotalRial: inputs.monthlyCostsTotalRial.toString(),
        taxRateBps: inputs.taxRateBps,
        targetProfitMarginBps: inputs.targetProfitMarginBps,
        roundingStepRial: inputs.roundingStepRial.toString(),
        reviewRules: {
          maxIncreaseBpsWithoutReview: Number(plan.reviewMaxIncreaseBps),
          reviewDecreases: plan.reviewDecreases,
        },
        operatingCostRatePercent: percentString(
          inputs.monthlyCostsTotalRial,
          inputs.targetMonthlyRevenueRial,
        ),
        costEntries: entries.map((entry) => ({
          id: Number(entry.id),
          title: entry.title,
          amountRial: entry.amountRial,
          scope: entry.scope,
          branchId: entry.branchId === null ? null : Number(entry.branchId),
          note: entry.note,
          isActive: entry.isActive,
        })),
      };
      const created = await this.insertRun(
        manager,
        plan,
        'calculate',
        key,
        hash,
        principal,
        {
          inputsSnapshot: snapshot,
        },
      );
      await this.setStatus(manager, planId, 'CALCULATING', {
        clearError: true,
      });
      return created;
    });
    this.runner.kick();
    return this.runView(run);
  }

  async requestApply(
    planId: number,
    dto: ApproveOrApplyDto,
    rawKey: string | undefined,
    principal: PricingPrincipal,
  ) {
    this.assertOwner(principal);
    const key = this.requireKey(rawKey);
    const hash = requestHash({
      kind: 'apply',
      expectedChangeCount: dto.expectedChangeCount,
    });
    const run = await this.dataSource.transaction(async (manager) => {
      const plan = await this.lockPlan(manager, planId);
      const replay = await this.replay(manager, planId, 'apply', key, hash);
      if (replay) return replay;

      // A failed apply keeps its approval: the rows were frozen and nothing was written.
      const retryAfterFailure =
        plan.status === 'FAILED' && plan.approvedAt !== null;
      if (plan.status !== 'APPROVED' && !retryAfterFailure) {
        throw pricingError.conflict(E.PRICING_PLAN_STATE_CONFLICT, {
          from: plan.status,
          to: 'APPLYING',
        });
      }
      assertTransition(plan.status, 'APPLYING');
      await this.assertNoActiveRun(manager, planId);
      const applicable = await this.applicableCount(manager, planId);
      if (applicable === 0)
        throw pricingError.conflict(E.PRICING_NOTHING_TO_APPLY);
      if (applicable !== dto.expectedChangeCount) {
        throw pricingError.conflict(E.PRICING_APPLY_COUNT_MISMATCH, {
          applicableCount: applicable,
        });
      }
      const created = await this.insertRun(
        manager,
        plan,
        'apply',
        key,
        hash,
        principal,
        {
          expectedChangeCount: applicable,
        },
      );
      await this.setStatus(manager, planId, 'APPLYING', { clearError: true });
      return created;
    });
    this.runner.kick();
    return this.runView(run);
  }

  async rollbackPreview(planId: number, principal: PricingPrincipal) {
    this.assertOwner(principal);
    const plan = await this.requirePlan(this.dataSource.manager, planId);
    const [counts]: {
      applied: number;
      restorable: number;
      conflicts: number;
    }[] = await this.dataSource.query(
      `SELECT count(*)::int AS "applied",
              count(*) FILTER (WHERE v."price" IS NOT DISTINCT FROM c."newPriceRial")::int AS "restorable",
              count(*) FILTER (WHERE v."price" IS DISTINCT FROM c."newPriceRial")::int AS "conflicts"
         FROM "pricing_price_changes" c
         LEFT JOIN "product_variants" v ON v."id" = c."variantId"
        WHERE c."planId" = $1 AND c."kind" = 'apply'
          AND NOT EXISTS (SELECT 1 FROM "pricing_price_changes" r WHERE r."revertsChangeId" = c."id")`,
      [planId],
    );
    return { planStatus: plan.status, ...counts };
  }

  async requestRollback(
    planId: number,
    rawKey: string | undefined,
    principal: PricingPrincipal,
  ) {
    this.assertOwner(principal);
    const key = this.requireKey(rawKey);
    const hash = requestHash({ kind: 'rollback' });
    const run = await this.dataSource.transaction(async (manager) => {
      const plan = await this.lockPlan(manager, planId);
      const replay = await this.replay(manager, planId, 'rollback', key, hash);
      if (replay) return replay;
      if (plan.status !== 'APPLIED') {
        throw pricingError.conflict(E.PRICING_PLAN_STATE_CONFLICT, {
          from: plan.status,
          to: 'ROLLED_BACK',
        });
      }
      await this.assertNoActiveRun(manager, planId);
      return this.insertRun(
        manager,
        plan,
        'rollback',
        key,
        hash,
        principal,
        {},
      );
    });
    this.runner.kick();
    return this.runView(run);
  }

  async listRuns(planId: number, principal: PricingPrincipal) {
    this.assertOwner(principal);
    await this.requirePlan(this.dataSource.manager, planId);
    const rows: RunRow[] = await this.dataSource.query(
      `${RUN_SELECT} WHERE r."planId" = $1 ORDER BY r."id" DESC LIMIT 50`,
      [planId],
    );
    return rows.map((row) => this.runView(row));
  }

  async getRun(planId: number, runId: number, principal: PricingPrincipal) {
    this.assertOwner(principal);
    const [row]: RunRow[] = await this.dataSource.query(
      `${RUN_SELECT} WHERE r."planId" = $1 AND r."id" = $2`,
      [planId, runId],
    );
    if (!row) throw pricingError.notFound(E.PRICING_RUN_NOT_FOUND);
    return this.runView(row);
  }

  async listChanges(
    planId: number,
    query: ChangesQueryDto,
    principal: PricingPrincipal,
  ) {
    this.assertOwner(principal);
    await this.requirePlan(this.dataSource.manager, planId);
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const params: unknown[] = [planId];
    let kind = '';
    if (query.kind) {
      params.push(query.kind);
      kind = `AND c."kind" = $2`;
    }
    const [{ total }]: { total: number }[] = await this.dataSource.query(
      `SELECT count(*)::int AS total FROM "pricing_price_changes" c WHERE c."planId" = $1 ${kind}`,
      params,
    );
    const rows: Record<string, unknown>[] = await this.dataSource.query(
      `SELECT c."id", c."runId", c."itemId", c."variantId", c."productId", c."kind",
              c."oldPriceRial"::text AS "oldPriceRial", c."newPriceRial"::text AS "newPriceRial",
              c."revertsChangeId", c."calculationMethod", c."formulaVersion",
              c."changedByDisplay", c."changedAt",
              i."productTitle", i."variantCode", i."sku"
         FROM "pricing_price_changes" c
         LEFT JOIN "pricing_plan_items" i ON i."id" = c."itemId"
        WHERE c."planId" = $1 ${kind}
        ORDER BY c."id" ASC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit],
    );
    return {
      data: rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 0,
    };
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  private requireKey(raw: string | undefined): string {
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!KEY.test(key)) {
      throw pricingError.badRequest(E.PRICING_IDEMPOTENCY_KEY_REQUIRED);
    }
    return key;
  }

  /** The same key + same request replays the run; the same key + another request is refused. */
  private async replay(
    manager: EntityManager,
    planId: number,
    kind: string,
    key: string,
    hash: string,
  ): Promise<RunRow | null> {
    const [existing]: RunRow[] = await manager.query(
      `${RUN_SELECT} WHERE r."planId" = $1 AND r."kind" = $2 AND r."idempotencyKey" = $3`,
      [planId, kind, key],
    );
    if (!existing) return null;
    if (existing.requestHash !== hash)
      throw pricingError.conflict(E.PRICING_IDEMPOTENCY_KEY_REUSED);
    return existing;
  }

  private async insertRun(
    manager: EntityManager,
    plan: PlanRow,
    kind: 'calculate' | 'apply' | 'rollback',
    key: string,
    hash: string,
    principal: PricingPrincipal,
    extra: { inputsSnapshot?: unknown; expectedChangeCount?: number },
  ): Promise<RunRow> {
    try {
      const [row]: RunRow[] = await manager.query(
        `INSERT INTO "pricing_plan_runs"
           ("planId", "kind", "idempotencyKey", "requestHash", "calculationMethod", "formulaVersion",
            "inputsSnapshot", "expectedChangeCount", "requestedByUserId", "requestedByDisplay")
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
         RETURNING *`,
        [
          plan.id,
          kind,
          key,
          hash,
          plan.calculationMethod,
          plan.formulaVersion,
          extra.inputsSnapshot === undefined
            ? null
            : JSON.stringify(extra.inputsSnapshot),
          extra.expectedChangeCount ?? null,
          principal.userId,
          (principal.actor.display || 'unknown').slice(0, 160),
        ],
      );
      return row;
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw pricingError.conflict(E.PRICING_RUN_ACTIVE);
      throw error;
    }
  }

  private async assertNoActiveRun(
    manager: EntityManager,
    planId: number,
  ): Promise<void> {
    const active: unknown[] = await manager.query(
      `SELECT 1 FROM "pricing_plan_runs" WHERE "planId" = $1 AND "status" IN ('queued', 'running')`,
      [planId],
    );
    if (active.length > 0) throw pricingError.conflict(E.PRICING_RUN_ACTIVE);
  }

  private async setStatus(
    manager: EntityManager,
    planId: number,
    status: PlanStatus,
    options: { clearError?: boolean } = {},
  ): Promise<void> {
    await manager.query(
      `UPDATE "pricing_plans"
          SET "status" = $2, "updatedAt" = now()
              ${options.clearError ? `, "lastErrorCode" = NULL` : ''}
        WHERE "id" = $1`,
      [planId, status],
    );
  }

  private async lockPlan(
    manager: EntityManager,
    planId: number,
  ): Promise<PlanRow> {
    const [plan]: PlanRow[] = await manager.query(
      `${PLAN_SELECT} WHERE p."id" = $1 FOR UPDATE`,
      [planId],
    );
    if (!plan) throw pricingError.notFound(E.PRICING_PLAN_NOT_FOUND);
    return plan;
  }

  private async requirePlan(
    manager: EntityManager,
    planId: number,
  ): Promise<PlanRow> {
    const [plan]: PlanRow[] = await manager.query(
      `${PLAN_SELECT} WHERE p."id" = $1`,
      [planId],
    );
    if (!plan) throw pricingError.notFound(E.PRICING_PLAN_NOT_FOUND);
    return plan;
  }

  private assertEditable(plan: PlanRow): void {
    if (!EDITABLE.includes(plan.status))
      throw pricingError.conflict(E.PRICING_PLAN_NOT_EDITABLE);
  }

  /**
   * An input or cost changed: the persisted preview no longer describes the
   * plan, so it is discarded and the plan returns to DRAFT. Never reached for
   * an APPROVED, APPLIED or ROLLED_BACK plan (`assertEditable`).
   */
  private async discardPreview(
    manager: EntityManager,
    plan: PlanRow,
  ): Promise<void> {
    await manager.query(
      `DELETE FROM "pricing_plan_items" WHERE "planId" = $1`,
      [plan.id],
    );
    if (plan.status !== 'DRAFT') assertTransition(plan.status, 'DRAFT');
    await manager.query(
      `UPDATE "pricing_plans"
          SET "status" = 'DRAFT', "calculatedAt" = NULL, "approvedAt" = NULL,
              "approvedByUserId" = NULL, "lastErrorCode" = NULL, "updatedAt" = now()
        WHERE "id" = $1`,
      [plan.id],
    );
  }

  private async recordUpdated(
    manager: EntityManager,
    principal: PricingPrincipal,
    plan: PlanRow,
    fields: string[],
  ): Promise<void> {
    await this.audit.record(
      {
        actor: principal.actor,
        action: AuditAction.PRICING_PLAN_UPDATED,
        targetType: AuditTarget.PRICING_PLAN,
        targetId: plan.id,
        targetLabel: plan.title,
        // Field NAMES only. The values are costs, targets and rates.
        summary: { planId: Number(plan.id), fields },
      },
      manager,
    );
  }

  private async resolveScope(
    manager: EntityManager,
    scope: 'general' | 'branch' | undefined,
    branchId: number | null | undefined,
  ): Promise<{ scope: 'general' | 'branch'; branchId: number | null }> {
    const resolved = scope ?? (branchId ? 'branch' : 'general');
    if (resolved === 'general') return { scope: 'general', branchId: null };
    if (!branchId) throw pricingError.badRequest(E.PRICING_BRANCH_NOT_FOUND);
    const found: unknown[] = await manager.query(
      `SELECT 1 FROM "branches" WHERE "id" = $1`,
      [branchId],
    );
    if (found.length === 0)
      throw pricingError.badRequest(E.PRICING_BRANCH_NOT_FOUND);
    return { scope: 'branch', branchId };
  }

  private async activeCostTotal(
    manager: EntityManager,
    planId: number,
  ): Promise<bigint> {
    const [{ total }]: { total: string }[] = await manager.query(
      `SELECT COALESCE(sum("amountRial"), 0)::text AS total
         FROM "pricing_plan_cost_entries" WHERE "planId" = $1 AND "isActive"`,
      [planId],
    );
    return BigInt(total);
  }

  /** The plan as formula inputs, or `null` while a required input is missing. */
  private inputsOf(
    plan: PlanRow,
    monthlyCostsTotalRial: bigint,
  ): TargetRevenueInputs | null {
    if (
      plan.targetMonthlyRevenueRial === null ||
      plan.taxRateBps === null ||
      plan.targetProfitMarginBps === null
    ) {
      return null;
    }
    return {
      monthlyCostsTotalRial,
      targetMonthlyRevenueRial: BigInt(plan.targetMonthlyRevenueRial),
      taxRateBps: Number(plan.taxRateBps),
      targetProfitMarginBps: Number(plan.targetProfitMarginBps),
      roundingStepRial: BigInt(plan.roundingStepRial),
    };
  }

  /** Active, offered variants whose every unit has a known cost. */
  private async eligibleVariantCount(manager: EntityManager): Promise<number> {
    const [{ count }]: { count: number }[] = await manager.query(
      `SELECT count(*)::int AS count
         FROM "product_variants" v JOIN "products" p ON p."id" = v."productId"
        WHERE v."isActive" AND v."unvaluedQuantity" = 0 AND v."stock" > 0
          AND v."inventoryCostValue" > 0
          AND (p."visibleOnSite" OR p."branchVisibility" <> 'none')`,
    );
    return count;
  }

  private async applicableCount(
    manager: EntityManager,
    planId: number,
  ): Promise<number> {
    const [{ count }]: { count: number }[] = await manager.query(
      `SELECT count(*)::int AS count FROM "pricing_plan_items" i WHERE i."planId" = $1 AND ${APPLICABLE_SQL}`,
      [planId],
    );
    return count;
  }

  private async summaryOf(manager: EntityManager, planId: number) {
    const [row]: SummaryRow[] = await manager.query(SUMMARY_SELECT, [planId]);
    return row;
  }

  private async planDetail(manager: EntityManager, planId: number) {
    const plan = await this.requirePlan(manager, planId);
    const entries: CostEntryRow[] = await manager.query(
      `${COST_ENTRY_SELECT} WHERE c."planId" = $1 ORDER BY c."sortOrder", c."id"`,
      [planId],
    );
    const total = await this.activeCostTotal(manager, planId);
    const inputs = this.inputsOf(plan, total);
    let problems: PricingErrorCode[] = [];
    let operatingCostRatePercent: string | null = null;
    let denominatorPercent: string | null = null;
    if (inputs === null) {
      problems = [E.PRICING_INPUTS_INCOMPLETE];
    } else {
      problems = inputProblems(inputs);
      operatingCostRatePercent = percentString(
        inputs.monthlyCostsTotalRial,
        inputs.targetMonthlyRevenueRial,
      );
      if (inputs.targetMonthlyRevenueRial > 0n) {
        const d = pricingDenominator(inputs);
        denominatorPercent = percentString(d.numerator, d.denominator);
      }
    }
    const [activeRun]: RunRow[] = await manager.query(
      `${RUN_SELECT} WHERE r."planId" = $1 ORDER BY r."id" DESC LIMIT 1`,
      [planId],
    );
    const [{ items }]: { items: number }[] = await manager.query(
      `SELECT count(*)::int AS items FROM "pricing_plan_items" WHERE "planId" = $1`,
      [planId],
    );
    return {
      ...planFieldsView(plan),
      costEntries: entries.map(costEntryView),
      monthlyCostsTotalRial: total.toString(),
      operatingCostRatePercent,
      denominatorPercent,
      inputProblems: problems.map((code) => ({
        code,
        message: PricingMessages[code],
      })),
      isEditable: EDITABLE.includes(plan.status),
      hasPreview: items > 0,
      latestRun: activeRun ? this.runView(activeRun) : null,
      summary: items > 0 ? await this.summaryOf(manager, planId) : null,
    };
  }

  runView(row: RunRow) {
    return {
      id: Number(row.id),
      planId: Number(row.planId),
      kind: row.kind,
      status: row.status,
      phase: row.phase,
      totalItems: Number(row.totalItems),
      processedItems: Number(row.processedItems),
      expectedChangeCount:
        row.expectedChangeCount === null
          ? null
          : Number(row.expectedChangeCount),
      result: row.result,
      errorCode: row.errorCode,
      errorMessage: row.errorCode
        ? (MESSAGE_BY_CODE.get(row.errorCode) ?? null)
        : null,
      calculationMethod: row.calculationMethod,
      formulaVersion: Number(row.formulaVersion),
      inputsSnapshot: row.inputsSnapshot,
      requestedByDisplay: row.requestedByDisplay,
      queuedAt: row.queuedAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    };
  }
}
