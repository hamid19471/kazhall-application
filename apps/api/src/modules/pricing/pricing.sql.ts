/**
 * SQL fragments and row → view mappers for the monthly pricing module.
 *
 * One WHERE builder serves the paginated preview, the bulk include/exclude and
 * the summary, so "apply to everything I am looking at" is exactly the rows the
 * list shows. Every value is a bound parameter; only whitelisted column names
 * are ever interpolated.
 */
import type { ItemFilterDto, ItemListQueryDto } from './dto/pricing.dto';
import { bpsToPercentText } from './pricing-formula';

/** Rows the apply would write. The single definition used everywhere. */
export const APPLICABLE_SQL = `(i."included" AND NOT i."stale" AND i."status" <> 'BLOCKED'
  AND i."finalPriceRial" IS NOT NULL
  AND i."finalPriceRial" IS DISTINCT FROM i."currentPriceRial")`;

/** Rows a person should look at before approving. */
export const EXCEPTION_SQL = `(i."status" IN ('NEEDS_REVIEW', 'BLOCKED') OR i."stale")`;

export interface SqlWhere {
  clause: string;
  params: unknown[];
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * The WHERE clause over `pricing_plan_items i` for one plan. `$1` is always the
 * plan id; filters bind `$2…` in order.
 */
export function itemWhere(planId: number, filters: ItemFilterDto): SqlWhere {
  const params: unknown[] = [planId];
  const parts: string[] = [`i."planId" = $1`];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const view = filters.view ?? 'exceptions';
  if (view === 'exceptions') parts.push(EXCEPTION_SQL);
  if (view === 'applicable') parts.push(APPLICABLE_SQL);

  if (filters.search) {
    const p = bind(`%${escapeLike(filters.search)}%`);
    parts.push(
      `(i."productTitle" ILIKE ${p} ESCAPE '\\' OR i."productCode" ILIKE ${p} ESCAPE '\\'
        OR i."variantCode" ILIKE ${p} ESCAPE '\\' OR i."sku" ILIKE ${p} ESCAPE '\\')`,
    );
  }
  if (filters.status) parts.push(`i."status" = ${bind(filters.status)}`);
  if (filters.categoryId !== undefined) {
    parts.push(`i."categoryIds" @> ARRAY[${bind(filters.categoryId)}::int]`);
  }
  switch (filters.channel) {
    case 'site':
      parts.push(`(i."visibleOnSite" AND i."branchVisibility" = 'none')`);
      break;
    case 'branches':
      parts.push(`(NOT i."visibleOnSite" AND i."branchVisibility" <> 'none')`);
      break;
    case 'both':
      parts.push(`(i."visibleOnSite" AND i."branchVisibility" <> 'none')`);
      break;
    case 'none':
      parts.push(`(NOT i."visibleOnSite" AND i."branchVisibility" = 'none')`);
      break;
    default:
      break;
  }
  switch (filters.direction) {
    case 'increase':
      parts.push(`i."changeRial" > 0`);
      break;
    case 'decrease':
      parts.push(`i."changeRial" < 0`);
      break;
    case 'none':
      parts.push(`i."changeRial" = 0`);
      break;
    default:
      break;
  }
  if (filters.minChangePercent !== undefined) {
    parts.push(
      `i."changePercent" >= ${bind(filters.minChangePercent)}::numeric`,
    );
  }
  if (filters.maxChangePercent !== undefined) {
    parts.push(
      `i."changePercent" <= ${bind(filters.maxChangePercent)}::numeric`,
    );
  }
  if (filters.included !== undefined)
    parts.push(`i."included" = ${bind(filters.included)}`);
  if (filters.stale !== undefined)
    parts.push(`i."stale" = ${bind(filters.stale)}`);

  return { clause: parts.join(' AND '), params };
}

const SORT_COLUMNS: Record<NonNullable<ItemListQueryDto['sort']>, string> = {
  product: `i."productTitle" {dir}, i."variantCode" {dir}`,
  changePercent: `i."changePercent" {dir} NULLS LAST`,
  changeRial: `i."changeRial" {dir} NULLS LAST`,
  currentPrice: `i."currentPriceRial" {dir} NULLS LAST`,
  finalPrice: `i."finalPriceRial" {dir} NULLS LAST`,
  costBasis: `i."costBasisRial" {dir} NULLS LAST`,
  status: `CASE i."status" WHEN 'BLOCKED' THEN 0 WHEN 'NEEDS_REVIEW' THEN 1
             WHEN 'READY' THEN 2 ELSE 3 END {dir}`,
};

export function itemOrderBy(
  query: Pick<ItemListQueryDto, 'sort' | 'order'>,
): string {
  const dir = query.order === 'desc' ? 'DESC' : 'ASC';
  const column = SORT_COLUMNS[query.sort ?? 'product'].replace(/\{dir\}/g, dir);
  // The id tiebreaker makes every page stable under equal sort keys.
  return `${column}, i."id" ${dir}`;
}

export const ITEM_SELECT = `
  SELECT i."id", i."variantId", i."productId", i."productTitle", i."productCode",
         i."variantCode", i."sku", i."isDefaultVariant", i."categoryIds",
         i."visibleOnSite", i."branchVisibility", i."variantActive",
         i."costBasisRial"::text      AS "costBasisRial",
         i."currentPriceRial"::text   AS "currentPriceRial",
         i."rawPrice"::text           AS "rawPrice",
         i."proposedPriceRial"::text  AS "proposedPriceRial",
         i."overridePriceRial"::text  AS "overridePriceRial",
         i."finalPriceRial"::text     AS "finalPriceRial",
         i."changeRial"::text         AS "changeRial",
         i."changePercent"::text      AS "changePercent",
         i."status", i."reasons", i."included",
         (i."reviewedByUserId" IS NOT NULL) AS "reviewed",
         i."stale", i."staleReason", i."calculationMethod", i."formulaVersion",
         i."calculatedAt",
         ${APPLICABLE_SQL} AS "applicable"
    FROM "pricing_plan_items" i`;

export interface ItemRow {
  id: number;
  variantId: number;
  productId: number;
  productTitle: string;
  productCode: string;
  variantCode: string;
  sku: string;
  isDefaultVariant: boolean;
  categoryIds: number[];
  visibleOnSite: boolean;
  branchVisibility: string;
  variantActive: boolean;
  costBasisRial: string | null;
  currentPriceRial: string | null;
  rawPrice: string | null;
  proposedPriceRial: string | null;
  overridePriceRial: string | null;
  finalPriceRial: string | null;
  changeRial: string | null;
  changePercent: string | null;
  status: string;
  reasons: string[];
  included: boolean;
  reviewed: boolean;
  stale: boolean;
  staleReason: string | null;
  calculationMethod: string;
  formulaVersion: number;
  calculatedAt: Date;
  applicable: boolean;
}

export function itemView(row: ItemRow) {
  return {
    ...row,
    id: Number(row.id),
    variantId: Number(row.variantId),
    productId: Number(row.productId),
    categoryIds: (row.categoryIds ?? []).map(Number),
    formulaVersion: Number(row.formulaVersion),
  };
}

export const SUMMARY_SELECT = `
  SELECT count(*)::int                                                AS "evaluated",
         count(*) FILTER (WHERE i."status" = 'READY')::int            AS "ready",
         count(*) FILTER (WHERE i."status" = 'UNCHANGED')::int        AS "unchanged",
         count(*) FILTER (WHERE i."status" = 'NEEDS_REVIEW')::int     AS "needsReview",
         count(*) FILTER (WHERE i."status" = 'BLOCKED')::int          AS "blocked",
         count(*) FILTER (WHERE i."stale")::int                       AS "stale",
         count(*) FILTER (WHERE i."included")::int                    AS "included",
         count(*) FILTER (WHERE i."status" = 'NEEDS_REVIEW' AND i."included")::int
                                                                      AS "approvedReview",
         count(*) FILTER (WHERE ${APPLICABLE_SQL})::int               AS "applicable",
         count(*) FILTER (WHERE ${APPLICABLE_SQL} AND i."changeRial" > 0)::int
                                                                      AS "applicableIncreases",
         count(*) FILTER (WHERE ${APPLICABLE_SQL} AND i."changeRial" < 0)::int
                                                                      AS "applicableDecreases",
         count(*) FILTER (WHERE i."overridePriceRial" IS NOT NULL)::int AS "overridden",
         round(avg(i."changePercent") FILTER (WHERE i."status" <> 'BLOCKED'), 2)::text
                                                                      AS "averageChangePercent",
         min(i."changePercent") FILTER (WHERE i."status" <> 'BLOCKED')::text
                                                                      AS "minChangePercent",
         max(i."changePercent") FILTER (WHERE i."status" <> 'BLOCKED')::text
                                                                      AS "maxChangePercent"
    FROM "pricing_plan_items" i
   WHERE i."planId" = $1`;

/** One `SUMMARY_SELECT` row: counts are numbers, percents two-decimal strings. */
export interface SummaryRow {
  evaluated: number;
  ready: number;
  unchanged: number;
  needsReview: number;
  blocked: number;
  stale: number;
  included: number;
  approvedReview: number;
  applicable: number;
  applicableIncreases: number;
  applicableDecreases: number;
  overridden: number;
  averageChangePercent: string | null;
  minChangePercent: string | null;
  maxChangePercent: string | null;
}

export interface PlanRow {
  id: number;
  title: string;
  effectiveYear: number;
  effectiveMonth: number;
  calculationMethod: string;
  formulaVersion: number;
  status: string;
  targetMonthlyRevenueRial: string | null;
  taxRateBps: number | null;
  targetProfitMarginBps: number | null;
  roundingStepRial: string;
  reviewMaxIncreaseBps: number;
  reviewDecreases: boolean;
  notes: string | null;
  copiedFromPlanId: number | null;
  lastErrorCode: string | null;
  createdByUserId: number;
  createdAt: Date;
  updatedAt: Date;
  calculatedAt: Date | null;
  approvedAt: Date | null;
  approvedByUserId: number | null;
  appliedAt: Date | null;
  appliedByUserId: number | null;
  rolledBackAt: Date | null;
  rolledBackByUserId: number | null;
}

export const PLAN_SELECT = `
  SELECT p."id", p."title", p."effectiveYear", p."effectiveMonth", p."calculationMethod",
         p."formulaVersion", p."status",
         p."targetMonthlyRevenueRial"::text AS "targetMonthlyRevenueRial",
         p."taxRateBps", p."targetProfitMarginBps",
         p."roundingStepRial"::text AS "roundingStepRial",
         p."reviewMaxIncreaseBps", p."reviewDecreases", p."notes", p."copiedFromPlanId",
         p."lastErrorCode", p."createdByUserId", p."createdAt", p."updatedAt",
         p."calculatedAt", p."approvedAt", p."approvedByUserId", p."appliedAt",
         p."appliedByUserId", p."rolledBackAt", p."rolledBackByUserId"
    FROM "pricing_plans" p`;

export function planFieldsView(row: PlanRow) {
  return {
    id: Number(row.id),
    title: row.title,
    effectiveYear: Number(row.effectiveYear),
    effectiveMonth: Number(row.effectiveMonth),
    calculationMethod: row.calculationMethod,
    formulaVersion: Number(row.formulaVersion),
    status: row.status,
    targetMonthlyRevenueRial: row.targetMonthlyRevenueRial,
    taxRatePercent:
      row.taxRateBps === null ? null : bpsToPercentText(Number(row.taxRateBps)),
    targetProfitMarginPercent:
      row.targetProfitMarginBps === null
        ? null
        : bpsToPercentText(Number(row.targetProfitMarginBps)),
    roundingStepRial: row.roundingStepRial,
    reviewMaxIncreasePercent: bpsToPercentText(
      Number(row.reviewMaxIncreaseBps),
    ),
    reviewDecreases: row.reviewDecreases,
    notes: row.notes,
    copiedFromPlanId:
      row.copiedFromPlanId === null ? null : Number(row.copiedFromPlanId),
    lastErrorCode: row.lastErrorCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    calculatedAt: row.calculatedAt,
    approvedAt: row.approvedAt,
    appliedAt: row.appliedAt,
    rolledBackAt: row.rolledBackAt,
  };
}

export interface CostEntryRow {
  id: number;
  planId: number;
  title: string;
  amountRial: string;
  scope: string;
  branchId: number | null;
  branchName: string | null;
  note: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export const COST_ENTRY_SELECT = `
  SELECT c."id", c."planId", c."title", c."amountRial"::text AS "amountRial", c."scope",
         c."branchId", b."name" AS "branchName", c."note", c."isActive", c."sortOrder",
         c."createdAt", c."updatedAt"
    FROM "pricing_plan_cost_entries" c
    LEFT JOIN "branches" b ON b."id" = c."branchId"`;

export function costEntryView(row: CostEntryRow) {
  return {
    id: Number(row.id),
    title: row.title,
    amountRial: row.amountRial,
    scope: row.scope,
    branchId: row.branchId === null ? null : Number(row.branchId),
    branchName: row.branchName,
    note: row.note,
    isActive: row.isActive,
    sortOrder: Number(row.sortOrder),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface RunRow {
  id: number;
  planId: number;
  kind: string;
  status: string;
  idempotencyKey: string;
  requestHash: string;
  calculationMethod: string;
  formulaVersion: number;
  inputsSnapshot: Record<string, unknown> | null;
  expectedChangeCount: number | null;
  phase: string | null;
  totalItems: number;
  processedItems: number;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  requestedByUserId: number;
  requestedByDisplay: string;
  queuedAt: Date;
  startedAt: Date | null;
  heartbeatAt: Date | null;
  finishedAt: Date | null;
}

export const RUN_SELECT = `SELECT r.* FROM "pricing_plan_runs" r`;

/**
 * TypeORM's postgres driver returns `[rows, affectedCount]` for UPDATE and
 * DELETE (plain `rows` for SELECT and INSERT). Every `… RETURNING` statement
 * other than INSERT goes through this, so a caller always sees the rows.
 */
export function returned<T>(result: unknown): T[] {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[0] as T[];
  }
  return (result ?? []) as T[];
}
