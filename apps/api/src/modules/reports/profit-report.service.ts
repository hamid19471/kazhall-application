import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OrderMessages } from 'src/common/constants/order.messages';
import { toCount, toRial, toRialBigInt } from 'src/common/money/rial';
import { percentString } from 'src/modules/inventory/valuation/valuation';
import { resolveReportTimezone } from '../orders/business-time';
import { OrderStatusEnum } from '../orders/enums/order-status.enum';
import UserRoleEnum from '../user/enums/user-role.enum';
import {
  ProfitBreakdownQueryDto,
  ProfitGroupBy,
  ProfitReportQueryDto,
} from './dto/profit-report-query.dto';
import {
  ELIGIBLE_SALE_STATUSES,
  REVENUE_DATE_SQL,
  ReportViewer,
  TOTALS_SEMANTICS,
} from './reports.service';

/**
 * ============================================================================
 * GROSS-PROFIT REPORTING — `/reports/profit/*`
 * ============================================================================
 *
 * The contract is docs/PURCHASE-COST-ACCOUNTING.md §1, §9 and §13. This is
 * GROSS profit: net sales revenue minus the cost of the goods sold. Operating
 * expenses, salaries, rent, taxes, shipping and gateway fees are not modelled
 * anywhere in this system, so nothing here is — or may be labelled — net
 * profit.
 *
 * LINE-BASED, NOT ORDER-BASED. Cost is recognised per `order_items` row
 * (`costStatus`, `cogsTotal`) and reversed per row (`order_item_adjustments`),
 * so every figure here is a sum over line events:
 *
 *   sale event      an eligible-sale line, dated by its order's revenue date
 *   reversal event  one `order_item_adjustments` row, dated by its `eventAt`
 *
 * "Eligible sale" is the SAME predicate `ReportsService` uses — the exported
 * `ELIGIBLE_SALE_STATUSES` plus voided-after-payment — and the revenue date is
 * the same exported `REVENUE_DATE_SQL`. This report does not redefine a sale.
 *
 * UNKNOWN COST IS NEVER ZERO COST. A line whose cost is `unknown` (legacy
 * stock, or a unit counted in without a cost) or still `pending` (a paid web
 * order not yet fulfilled) contributes its revenue to `unknownCost` and
 * nothing to `knownCost`; gross profit is computed over known-cost lines only
 * and `coveragePercent` says how much of the revenue that is.
 * ============================================================================
 */

/** The warning every breakdown/order row with unknown-cost activity carries. */
export const PROFIT_INCOMPLETE_WARNING =
  'اطلاعات قیمت خرید این فروش ناقص است؛ سود قابل محاسبه نیست.';

/**
 * PROFIT SEMANTICS — returned verbatim on every `/reports/profit/*` response.
 *
 * EVERY SENTENCE MUST BE TRUE OF THE SQL IN THIS FILE, exactly as
 * `TOTALS_SEMANTICS` is for the sales report. Rewrite it when a predicate
 * changes, never before.
 */
export const PROFIT_SEMANTICS = Object.freeze({
  metric:
    'GROSS PROFIT = net sales revenue - cost of goods sold, over lines whose purchase cost is known. It is NOT net profit: operating expenses, salaries, rent, taxes, shipping costs and gateway fees are not modelled anywhere in this system and nothing here deducts them.',
  currency: TOTALS_SEMANTICS.currency,
  moneyUnit: TOTALS_SEMANTICS.moneyUnit,
  percentages:
    'Percentages are strings with two decimals, computed in BigInt and rounded half away from zero, or null when the denominator is zero or negative -- never Infinity, NaN or an invented 0.',
  lineBased:
    'Every figure is a sum over ORDER LINES (order_items), not over orders. A sale event is an order line of an eligible sale whose revenue date falls in the range; a reversal event is one order_item_adjustments row whose eventAt falls in the range.',
  eligibleSaleStates: TOTALS_SEMANTICS.eligibleSaleStates,
  revenueDate: TOTALS_SEMANTICS.revenueDate,
  reversalDate:
    'Reversals (whole-order voids, returns and refunds, and line adjustments) are dated by order_item_adjustments."eventAt", the instant each was recorded -- NOT by the sale date. They are counted only for lines of eligible sales, the same predicate the sale events use, so no reversal is ever counted for revenue that was never booked.',
  reversalsWithUnknownEventDate:
    'Legacy reversal rows (scope=legacy) whose date migration 0009 could not recover have eventAt NULL. They are EXCLUDED from a ranged query and reported in dataQuality.reversalsWithUnknownEventDate instead, and INCLUDED in an unranged (all-time) query. Do not add that data-quality figure across periods.',
  cogsMatching:
    "COGS is matched to the revenue period of its line: a known-cost line's cogsTotal counts in the period its revenue does, even when a web order was fulfilled days after payment. Until fulfilment the line is pending and its revenue is reported as unknownCost.pendingFulfilmentRevenue.",
  costClassification:
    "A line is classified by its CURRENT order_items.\"costStatus\": 'known' (every unit valued), 'unknown' (at least one unit of unknown cost, or legacy) or 'pending' (not yet fulfilled). Its sale event AND its reversal events use that classification, so a known line's reversals reduce knownCost and every other line's reversals reduce unknownCost.",
  grossSalesRevenue:
    'Sum of order_items.total_price over sale events. unitsSold is the sum of order_items.quantity over the same events.',
  revenueReversed:
    'Sum of order_item_adjustments."revenueReversed" over reversal events; voidedRevenue is the part with kind=\'void\' and refundedRevenue every other kind (return_refund, refund_only; return_only reverses no revenue). netSalesRevenue = grossSalesRevenue - revenueReversed.',
  unitsReturned:
    'Sum of restockedKnownQuantity + restockedUnknownQuantity over reversal events: units physically returned to stock. unitsRefundedWithoutReturn is the revenueQuantity of refund_only events, whose goods did not come back.',
  knownCost:
    'knownCost.grossRevenue and knownCost.cogs are sums over sale events of known lines (total_price and cogsTotal); knownCost.revenueReversed and knownCost.cogsReversed over reversal events of known lines. netRevenue = grossRevenue - revenueReversed, netCogs = cogs - cogsReversed, grossProfit = netRevenue - netCogs, grossMarginPercent = grossProfit / netRevenue x 100. A refund without return reverses revenue and NO cost, so it lowers gross profit: that is a genuine loss, not an error.',
  unknownCost:
    'unknownCost.grossRevenue is the revenue of sale events of unknown and pending lines, split as unvaluedRevenue (costStatus unknown) and pendingFulfilmentRevenue (costStatus pending); revenueReversed is the reversals of those lines; netRevenue = grossRevenue - revenueReversed. None of it enters grossProfit: its cost is unknown, which is never treated as zero.',
  coveragePercent:
    "knownCost.grossRevenue / grossSalesRevenue x 100 -- how much of the period's revenue has a known purchase cost. null when grossSalesRevenue is 0.",
  lineCount:
    'knownCost.lineCount and unknownCost.lineCount count sale events (lines), not reversal rows.',
  inventoryLosses:
    'Reported SEPARATELY and never part of COGS: stock_movements with reason inventory_correction or manual_adjustment, delta < 0 and cost evidence ("costDelta" IS NOT NULL), dated by createdAt. units = -delta, knownCostRemoved = -costDelta, unknownCostUnits = -unvaluedQuantityDelta. The productId, variantId and categoryId filters apply to them; branchId, channel and cashierUserId do NOT, because an inventory loss is not a sale and has no order, branch sale or cashier.',
  filters:
    'branchId, channel and cashierUserId filter on the ORDER (cashierUserId is the original seller, never the reversal actor). productId and variantId filter on the LINE (order_items."productId" / "variantId"); categoryId keeps lines whose product is currently linked to that category in product_category.',
  costCoverage:
    "Per breakdown/order row: 'complete' when the row has no sale or reversal event of an unknown or pending line, 'none' when it has no event of a known line, 'partial' otherwise. grossProfit and grossMarginPercent are null for 'none'; every row that is not 'complete' carries the warning. The rule is stricter than 'no unknown net revenue': an unknown-cost line refunded without return nets to zero revenue while its cost is still unknown, so it must not make a row look complete.",
  ranking:
    'Breakdown rows are ordered complete first, then partial, then none -- so a product whose cost is unknown can never be ranked as highly profitable -- and within each class by grossProfit DESC (numeric, in SQL), with the row key ascending as a total tie-break.',
  groupByDay:
    'groupBy=day places each event in the LOCAL calendar day of the report timezone of its own event date (revenue date for sales, eventAt for reversals).',
  groupByCategory:
    'groupBy=category counts a line once in EACH category its product belongs to (and under key null when it has none). Category rows therefore overlap and MUST NOT be summed; every other groupBy partitions the totals exactly.',
});

/** Positional bind-parameter accumulator (same rule as `ReportsService`). */
class SqlParams {
  readonly values: unknown[] = [];

  bind(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

interface ResolvedRange {
  from: string | null;
  to: string | null;
  startUtc: string | null;
  endUtc: string | null;
}

/** Numeric aggregates as node-postgres returns them (strings). */
type AggRow = Record<string, string | number | null>;

/**
 * The aggregate columns every route computes, in ONE place, so the summary,
 * a breakdown row, an order row and the order detail cannot disagree about
 * which event feeds which figure. Values stay NUMERIC here (never ::text yet)
 * so the breakdown can order on them numerically; they are cast at the edge.
 */
const AGGREGATES: ReadonlyArray<[string, string]> = [
  ['gross', `SUM(e.sale_revenue)`],
  ['known_gross', `SUM(e.sale_revenue) FILTER (WHERE e.cost_status = 'known')`],
  [
    'pending_gross',
    `SUM(e.sale_revenue) FILTER (WHERE e.cost_status = 'pending')`,
  ],
  [
    'unvalued_gross',
    `SUM(e.sale_revenue) FILTER (WHERE e.cost_status = 'unknown')`,
  ],
  ['reversed', `SUM(e.revenue_reversed)`],
  ['voided', `SUM(e.revenue_reversed) FILTER (WHERE e.kind = 'void')`],
  [
    'refunded',
    `SUM(e.revenue_reversed) FILTER (WHERE e.event_type = 'reversal' AND e.kind <> 'void')`,
  ],
  [
    'known_reversed',
    `SUM(e.revenue_reversed) FILTER (WHERE e.cost_status = 'known')`,
  ],
  ['cogs', `SUM(e.cogs)`],
  [
    'cogs_reversed',
    `SUM(e.cogs_reversed) FILTER (WHERE e.cost_status = 'known')`,
  ],
  ['units_sold', `SUM(e.units_sold)`],
  ['units_returned', `SUM(e.units_returned)`],
  ['units_refund_only', `SUM(e.units_refund_only)`],
  [
    'known_lines',
    `COUNT(*) FILTER (WHERE e.event_type = 'sale' AND e.cost_status = 'known')`,
  ],
  [
    'unknown_lines',
    `COUNT(*) FILTER (WHERE e.event_type = 'sale' AND e.cost_status <> 'known')`,
  ],
  ['known_events', `COUNT(*) FILTER (WHERE e.cost_status = 'known')`],
  ['unknown_events', `COUNT(*) FILTER (WHERE e.cost_status <> 'known')`],
];

const AGGREGATE_SQL = AGGREGATES.map(
  ([name, expr]) => `COALESCE(${expr}, 0) AS ${name}`,
).join(',\n        ');

/** The same columns, cast for the wire: money exact as text, counts as int. */
const AGGREGATE_OUTPUT_SQL = AGGREGATES.map(([name]) =>
  name.startsWith('units_') ||
  name.endsWith('_lines') ||
  name.endsWith('_events')
    ? `${name}::int AS ${name}`
    : `${name}::text AS ${name}`,
).join(', ');

/** What `derive` produces from one aggregate row: all money as exact strings. */
interface DerivedFigures {
  grossSalesRevenue: string;
  revenueReversed: string;
  voidedRevenue: string;
  refundedRevenue: string;
  netSalesRevenue: string;
  unitsSold: number;
  unitsReturned: number;
  unitsRefundedWithoutReturn: number;
  knownCost: {
    grossRevenue: string;
    revenueReversed: string;
    netRevenue: string;
    cogs: string;
    cogsReversed: string;
    netCogs: string;
    grossProfit: string;
    grossMarginPercent: string | null;
    lineCount: number;
  };
  unknownCost: {
    grossRevenue: string;
    revenueReversed: string;
    netRevenue: string;
    pendingFulfilmentRevenue: string;
    unvaluedRevenue: string;
    lineCount: number;
  };
  coveragePercent: string | null;
  costCoverage: 'complete' | 'partial' | 'none';
}

/**
 * The formulas of contract §1, in BigInt, from one aggregate row. The single
 * place a net figure, a profit, a margin or a coverage is computed.
 */
function derive(row: AggRow): DerivedFigures {
  const gross = toRialBigInt(row.gross);
  const knownGross = toRialBigInt(row.known_gross);
  const reversed = toRialBigInt(row.reversed);
  const knownReversed = toRialBigInt(row.known_reversed);
  const cogs = toRialBigInt(row.cogs);
  const cogsReversed = toRialBigInt(row.cogs_reversed);

  const knownNet = knownGross - knownReversed;
  const netCogs = cogs - cogsReversed;
  const grossProfit = knownNet - netCogs;
  const unknownGross = gross - knownGross;
  const unknownReversed = reversed - knownReversed;

  const knownEvents = toCount(row.known_events);
  const unknownEvents = toCount(row.unknown_events);

  return {
    grossSalesRevenue: gross.toString(),
    revenueReversed: reversed.toString(),
    voidedRevenue: toRial(row.voided),
    refundedRevenue: toRial(row.refunded),
    netSalesRevenue: (gross - reversed).toString(),
    unitsSold: toCount(row.units_sold),
    unitsReturned: toCount(row.units_returned),
    unitsRefundedWithoutReturn: toCount(row.units_refund_only),
    knownCost: {
      grossRevenue: knownGross.toString(),
      revenueReversed: knownReversed.toString(),
      netRevenue: knownNet.toString(),
      cogs: cogs.toString(),
      cogsReversed: cogsReversed.toString(),
      netCogs: netCogs.toString(),
      grossProfit: grossProfit.toString(),
      grossMarginPercent: percentString(grossProfit, knownNet),
      lineCount: toCount(row.known_lines),
    },
    unknownCost: {
      grossRevenue: unknownGross.toString(),
      revenueReversed: unknownReversed.toString(),
      netRevenue: (unknownGross - unknownReversed).toString(),
      pendingFulfilmentRevenue: toRial(row.pending_gross),
      unvaluedRevenue: toRial(row.unvalued_gross),
      lineCount: toCount(row.unknown_lines),
    },
    coveragePercent: percentString(knownGross, gross),
    costCoverage:
      unknownEvents === 0 ? 'complete' : knownEvents === 0 ? 'none' : 'partial',
  };
}

/** The flat money block of a breakdown row / order row (contract §13). */
function rowMoney(d: DerivedFigures) {
  const none = d.costCoverage === 'none';
  return {
    grossSalesRevenue: d.grossSalesRevenue,
    revenueReversed: d.revenueReversed,
    netSalesRevenue: d.netSalesRevenue,
    unitsSold: d.unitsSold,
    unitsReturned: d.unitsReturned,
    knownNetRevenue: d.knownCost.netRevenue,
    unknownNetRevenue: d.unknownCost.netRevenue,
    netCogs: d.knownCost.netCogs,
    grossProfit: none ? null : d.knownCost.grossProfit,
    grossMarginPercent: none ? null : d.knownCost.grossMarginPercent,
    coveragePercent: d.coveragePercent,
    costCoverage: d.costCoverage,
    warning: d.costCoverage === 'complete' ? null : PROFIT_INCOMPLETE_WARNING,
  };
}

/** Per-groupBy key/label SQL over the `events e` relation. */
function groupSql(
  groupBy: ProfitGroupBy,
  bindTimezone: () => string,
): { key: string; label: string; join: string; numericKey: boolean } {
  switch (groupBy) {
    case 'day': {
      // Bound only here: an unreferenced bind parameter is a PostgreSQL error.
      const day = `to_char((e.event_at AT TIME ZONE ${bindTimezone()})::date, 'YYYY-MM-DD')`;
      return { key: day, label: day, join: '', numericKey: false };
    }
    case 'branch':
      return {
        key: 'e.branch_id',
        label: 'MAX(e.branch_name)',
        join: '',
        numericKey: true,
      };
    case 'channel':
      return {
        key: 'e.channel',
        label: 'e.channel',
        join: '',
        numericKey: false,
      };
    case 'cashier':
      return {
        key: 'e.cashier_id',
        label: 'MAX(e.cashier_name)',
        join: '',
        numericKey: true,
      };
    case 'product':
      return {
        key: 'e.product_id',
        label: 'MAX(e.product_title)',
        join: '',
        numericKey: true,
      };
    case 'variant':
      return {
        key: 'e.variant_id',
        label: `MAX(e.product_title || COALESCE(' / ' || COALESCE(e.variant_code, e.sku), ''))`,
        join: '',
        numericKey: true,
      };
    case 'category':
      return {
        key: 'pc.category_id',
        label: 'MAX(c.title)',
        join:
          'LEFT JOIN product_category pc ON pc.product_id = e.product_id\n' +
          '        LEFT JOIN categories c ON c.id = pc.category_id',
        numericKey: true,
      };
  }
}

@Injectable()
export class ProfitReportService {
  private readonly timezone: string;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    configService: ConfigService,
  ) {
    this.timezone = resolveReportTimezone(
      configService.get<string>('REPORT_TIMEZONE'),
    );
  }

  // ===================================================================
  // Scope / permissions
  // ===================================================================

  /**
   * DEFENCE IN DEPTH, the same rule as `ReportsService.assertReportViewer`:
   * cost and profit are the main administrator's, by the built-in ROLE and
   * never by a delegable capability (contract §8). `ReportsController` already
   * carries `@Roles(super_admin)` + `@Audiences('admin')`; every public method
   * here asserts it again so a moved handler or a new caller (the dashboard)
   * cannot open the data by omission.
   */
  private assertProfitViewer(viewer: ReportViewer): void {
    if (!viewer.roles.includes(UserRoleEnum.superAdmin)) {
      throw new ForbiddenException(OrderMessages.ORDER_ACCESS_DENIED);
    }
  }

  // ===================================================================
  // Range + predicates
  // ===================================================================

  private hasRange(query: ProfitReportQueryDto): boolean {
    return Boolean(query.from || query.to);
  }

  /** Inclusive local days → half-open UTC instants, in PostgreSQL. */
  private async resolveRange(
    query: ProfitReportQueryDto,
  ): Promise<ResolvedRange> {
    if (!this.hasRange(query)) {
      return { from: null, to: null, startUtc: null, endUtc: null };
    }
    const from = query.from ?? query.to!;
    const to = query.to ?? query.from!;
    const rows: Array<{ start_utc: Date; end_utc: Date }> =
      await this.dataSource.query(
        `SELECT (CAST(CAST($1 AS date) AS timestamp) AT TIME ZONE $3) AS start_utc,
                (CAST(CAST($2 AS date) + INTERVAL '1 day' AS timestamp) AT TIME ZONE $3) AS end_utc`,
        [from, to, this.timezone],
      );
    return {
      from,
      to,
      startUtc: rows[0].start_utc.toISOString(),
      endUtc: rows[0].end_utc.toISOString(),
    };
  }

  /** `<event> in [start, end)` for the query's local days, or null if unranged. */
  private rangePredicate(
    eventSql: string,
    query: ProfitReportQueryDto,
    p: SqlParams,
  ): string | null {
    if (!this.hasRange(query)) return null;
    const from = query.from ?? query.to!;
    const to = query.to ?? query.from!;
    const tz = p.bind(this.timezone);
    return (
      `(${eventSql} >= CAST(CAST(${p.bind(from)} AS date) AS timestamp) AT TIME ZONE ${tz}` +
      ` AND ${eventSql} < CAST(CAST(${p.bind(to)} AS date) + INTERVAL '1 day' AS timestamp) AT TIME ZONE ${tz})`
    );
  }

  /** Product / variant / category filters, over a line's product and variant columns. */
  private lineFilters(
    query: ProfitReportQueryDto,
    productCol: string,
    variantCol: string,
    p: SqlParams,
  ): string[] {
    const clauses: string[] = [];
    if (query.productId !== undefined) {
      clauses.push(`${productCol} = ${p.bind(query.productId)}`);
    }
    if (query.variantId !== undefined) {
      clauses.push(`${variantCol} = ${p.bind(query.variantId)}`);
    }
    if (query.categoryId !== undefined) {
      clauses.push(
        `EXISTS (SELECT 1 FROM product_category pcf
                  WHERE pcf.product_id = ${productCol}
                    AND pcf.category_id = ${p.bind(query.categoryId)})`,
      );
    }
    return clauses;
  }

  /**
   * THE event relation every route aggregates: `lines` (eligible-sale lines in
   * filter scope) and `events` (one row per sale event and per reversal event).
   *
   * `lines` is NOT date-bounded by revenue alone, because a reversal in range
   * may belong to a sale of an earlier period; on a ranged query it keeps a
   * line whose revenue date OR any of whose adjustments falls in range.
   */
  private eventsCte(
    query: ProfitReportQueryDto,
    p: SqlParams,
    opts: { orderId?: number } = {},
  ): string {
    const where: string[] = [
      // THE eligible-sale predicate, exactly ReportsService's.
      `(o.status::text = ANY (${p.bind([...ELIGIBLE_SALE_STATUSES])}::text[])` +
        ` OR (o."voidedAt" IS NOT NULL AND o."paidAt" IS NOT NULL))`,
    ];
    if (opts.orderId !== undefined) {
      where.push(`o.id = ${p.bind(opts.orderId)}`);
    }
    if (query.branchId !== undefined) {
      where.push(`o."branchId" = ${p.bind(query.branchId)}`);
    }
    if (query.channel) {
      where.push(`o.channel::text = ${p.bind(query.channel)}`);
    }
    if (query.cashierUserId !== undefined) {
      where.push(`o."cashierUserId" = ${p.bind(query.cashierUserId)}`);
    }
    where.push(
      ...this.lineFilters(query, 'oi."productId"', 'oi."variantId"', p),
    );

    const revenueRange = this.rangePredicate(REVENUE_DATE_SQL, query, p);
    const reversalRangeForLines = this.rangePredicate('ax."eventAt"', query, p);
    if (revenueRange && reversalRangeForLines) {
      where.push(
        `(${revenueRange} OR EXISTS (SELECT 1 FROM order_item_adjustments ax
                                    WHERE ax."orderItemId" = oi.id
                                      AND ax."eventAt" IS NOT NULL
                                      AND ${reversalRangeForLines}))`,
      );
    }

    const saleRange = this.rangePredicate('l.revenue_at', query, p);
    const reversalRange = this.rangePredicate('a."eventAt"', query, p);

    return `
      lines AS (
        SELECT oi.id                        AS item_id,
               oi."orderId"                 AS order_id,
               oi."productId"               AS product_id,
               oi."variantId"               AS variant_id,
               oi."productTitleSnapshot"    AS product_title,
               oi."variantCodeSnapshot"     AS variant_code,
               oi."variantSkuSnapshot"      AS sku,
               oi.quantity,
               oi.total_price,
               oi."costStatus"              AS cost_status,
               oi."cogsTotal"               AS cogs_total,
               o."orderNumber"              AS order_number,
               o.channel::text              AS channel,
               o."branchId"                 AS branch_id,
               o."branchNameSnapshot"       AS branch_name,
               o."cashierUserId"            AS cashier_id,
               o."cashierDisplaySnapshot"   AS cashier_name,
               ${REVENUE_DATE_SQL}          AS revenue_at
          FROM order_items oi
          JOIN orders o ON o.id = oi."orderId"
         WHERE ${where.join('\n           AND ')}
      ),
      events AS (
        -- SALE EVENTS: the line's revenue, units and (known lines only) COGS,
        -- in the period of the order's revenue date.
        SELECT l.*,
               'sale'::text                 AS event_type,
               l.revenue_at                 AS event_at,
               NULL::text                   AS kind,
               l.total_price::numeric       AS sale_revenue,
               l.quantity::bigint           AS units_sold,
               CASE WHEN l.cost_status = 'known' THEN l.cogs_total ELSE 0 END::numeric AS cogs,
               0::numeric                   AS revenue_reversed,
               0::bigint                    AS units_returned,
               0::bigint                    AS units_refund_only,
               0::numeric                   AS cogs_reversed
          FROM lines l
         WHERE ${saleRange ?? 'TRUE'}
        UNION ALL
        -- REVERSAL EVENTS: one per order_item_adjustments row, by its eventAt.
        SELECT l.*,
               'reversal'::text,
               a."eventAt",
               a.kind,
               0::numeric,
               0::bigint,
               0::numeric,
               a."revenueReversed"::numeric,
               (COALESCE(a."restockedKnownQuantity", 0)
                  + COALESCE(a."restockedUnknownQuantity", 0))::bigint,
               (CASE WHEN a.kind = 'refund_only' THEN a."revenueQuantity" ELSE 0 END)::bigint,
               COALESCE(a."cogsReversed", 0)::numeric
          FROM lines l
          JOIN order_item_adjustments a ON a."orderItemId" = l.item_id
         WHERE ${reversalRange ? `a."eventAt" IS NOT NULL AND ${reversalRange}` : 'TRUE'}
      )`;
  }

  private filtersOf(query: ProfitReportQueryDto) {
    return {
      branchId: query.branchId ?? null,
      channel: query.channel ?? null,
      cashierUserId: query.cashierUserId ?? null,
      productId: query.productId ?? null,
      variantId: query.variantId ?? null,
      categoryId: query.categoryId ?? null,
    };
  }

  private rangeOf(range: ResolvedRange) {
    return {
      from: range.from,
      to: range.to,
      startUtc: range.startUtc,
      endUtc: range.endUtc,
    };
  }

  // ===================================================================
  // Queries
  // ===================================================================

  private async aggregateTotals(
    query: ProfitReportQueryDto,
    opts: { orderId?: number } = {},
  ): Promise<DerivedFigures> {
    const p = new SqlParams();
    const cte = this.eventsCte(query, p, opts);
    const rows: AggRow[] = await this.dataSource.query(
      `WITH ${cte},
       agg AS (SELECT ${AGGREGATE_SQL} FROM events e)
       SELECT ${AGGREGATE_OUTPUT_SQL} FROM agg`,
      p.values,
    );
    return derive(rows[0]);
  }

  /** Legacy reversal rows in scope that a ranged query cannot place. */
  private async unknownDateReversals(query: ProfitReportQueryDto) {
    if (!this.hasRange(query)) return { count: 0, revenueReversed: '0' };
    // The same `lines` scope with NO date bound: these rows have no date to
    // bound them by, so the line must not be required to have one in range.
    const p = new SqlParams();
    const unranged: ProfitReportQueryDto = {
      ...query,
      from: undefined,
      to: undefined,
    };
    const cte = this.eventsCte(unranged, p);
    const rows: Array<{ count: number; total: string }> =
      await this.dataSource.query(
        `WITH ${cte}
         SELECT COUNT(*)::int AS count,
                COALESCE(SUM(a."revenueReversed"), 0)::text AS total
           FROM lines l
           JOIN order_item_adjustments a ON a."orderItemId" = l.item_id
          WHERE a."eventAt" IS NULL`,
        p.values,
      );
    return {
      count: toCount(rows[0].count),
      revenueReversed: toRial(rows[0].total),
    };
  }

  private async inventoryLosses(query: ProfitReportQueryDto) {
    const p = new SqlParams();
    const where: string[] = [
      `m.reason::text IN ('inventory_correction', 'manual_adjustment')`,
      `m.delta < 0`,
      `m."costDelta" IS NOT NULL`,
      ...this.lineFilters(query, 'v."productId"', 'm."variantId"', p),
    ];
    const range = this.rangePredicate('m."createdAt"', query, p);
    if (range) where.push(range);
    const rows: Array<{ units: number; cost: string; unknown: number }> =
      await this.dataSource.query(
        `SELECT COALESCE(SUM(-m.delta), 0)::int                          AS units,
                COALESCE(SUM(-m."costDelta"), 0)::text                   AS cost,
                COALESCE(SUM(-COALESCE(m."unvaluedQuantityDelta", 0)), 0)::int AS unknown
           FROM stock_movements m
           JOIN product_variants v ON v.id = m."variantId"
          WHERE ${where.join('\n            AND ')}`,
        p.values,
      );
    return {
      units: toCount(rows[0].units),
      knownCostRemoved: toRial(rows[0].cost),
      unknownCostUnits: toCount(rows[0].unknown),
    };
  }

  // ===================================================================
  // Endpoints
  // ===================================================================

  /** `GET /reports/profit/summary` (contract §13). */
  async summary(query: ProfitReportQueryDto, viewer: ReportViewer) {
    this.assertProfitViewer(viewer);
    const range = await this.resolveRange(query);
    const [figures, losses, unknownDated] = await Promise.all([
      this.aggregateTotals(query),
      this.inventoryLosses(query),
      this.unknownDateReversals(query),
    ]);
    // `costCoverage` is a row classification; the summary states coverage as
    // `coveragePercent` and the two cost blocks instead.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { costCoverage, ...totals } = figures;
    return {
      timezone: this.timezone,
      range: this.rangeOf(range),
      filters: this.filtersOf(query),
      totals: { ...totals, inventoryLosses: losses },
      dataQuality: {
        reversalsWithUnknownEventDate: {
          ...unknownDated,
          note: PROFIT_SEMANTICS.reversalsWithUnknownEventDate,
        },
      },
      semantics: PROFIT_SEMANTICS,
    };
  }

  /** `GET /reports/profit/breakdown?groupBy=…` (contract §13). */
  async breakdown(query: ProfitBreakdownQueryDto, viewer: ReportViewer) {
    this.assertProfitViewer(viewer);
    const range = await this.resolveRange(query);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const p = new SqlParams();
    const cte = this.eventsCte(query, p);
    const g = groupSql(query.groupBy, () => p.bind(this.timezone));
    const grouped = `
      grouped AS (
        SELECT ${g.key} AS key, ${g.label} AS label,
               ${AGGREGATE_SQL}
          FROM events e
          ${g.join}
         GROUP BY ${g.key}
      ),
      ranked AS (
        SELECT gr.*,
               CASE WHEN gr.unknown_events = 0 THEN 0
                    WHEN gr.known_events = 0 THEN 2
                    ELSE 1 END AS coverage_rank,
               CASE WHEN gr.known_events = 0 THEN NULL
                    ELSE (gr.known_gross - gr.known_reversed) - (gr.cogs - gr.cogs_reversed)
               END AS gross_profit_numeric
          FROM grouped gr
      )`;

    const countRows: Array<{ total: number }> = await this.dataSource.query(
      `WITH ${cte}, ${grouped} SELECT COUNT(*)::int AS total FROM ranked`,
      p.values,
    );
    const limitParam = p.bind(limit);
    const offsetParam = p.bind((page - 1) * limit);
    const rows: AggRow[] = await this.dataSource.query(
      `WITH ${cte}, ${grouped}
       SELECT key, label, ${AGGREGATE_OUTPUT_SQL}
         FROM ranked
        -- NUMERIC ordering on the profit, never on a cast string ("9" > "10").
        ORDER BY coverage_rank ASC,
                 gross_profit_numeric DESC NULLS LAST,
                 key ASC NULLS LAST
        LIMIT ${limitParam} OFFSET ${offsetParam}`,
      p.values,
    );

    const total = toCount(countRows[0].total);
    return {
      timezone: this.timezone,
      range: this.rangeOf(range),
      filters: this.filtersOf(query),
      groupBy: query.groupBy,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 0,
      data: rows.map((r) => ({
        key:
          r.key === null ? null : g.numericKey ? toCount(r.key) : String(r.key),
        label: r.label === null ? null : String(r.label),
        ...rowMoney(derive(r)),
      })),
      semantics: PROFIT_SEMANTICS,
    };
  }

  /** `GET /reports/profit/orders` — one row per order with an event in range. */
  async orders(query: ProfitReportQueryDto, viewer: ReportViewer) {
    this.assertProfitViewer(viewer);
    const range = await this.resolveRange(query);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const p = new SqlParams();
    const cte = this.eventsCte(query, p);
    const grouped = `
      grouped AS (
        SELECT e.order_id,
               MAX(e.order_number)  AS order_number,
               MAX(e.channel)       AS channel,
               MAX(e.branch_name)   AS branch_name,
               MAX(e.cashier_name)  AS cashier_name,
               MAX(e.revenue_at)    AS revenue_at,
               ${AGGREGATE_SQL}
          FROM events e
         GROUP BY e.order_id
      )`;
    const countRows: Array<{ total: number }> = await this.dataSource.query(
      `WITH ${cte}, ${grouped} SELECT COUNT(*)::int AS total FROM grouped`,
      p.values,
    );
    const limitParam = p.bind(limit);
    const offsetParam = p.bind((page - 1) * limit);
    const rows: Array<AggRow & { revenue_at: Date }> =
      await this.dataSource.query(
        `WITH ${cte}, ${grouped}
         SELECT order_id, order_number, channel, branch_name, cashier_name,
                revenue_at, ${AGGREGATE_OUTPUT_SQL}
           FROM grouped
          ORDER BY revenue_at DESC, order_id DESC
          LIMIT ${limitParam} OFFSET ${offsetParam}`,
        p.values,
      );

    const total = toCount(countRows[0].total);
    return {
      timezone: this.timezone,
      range: this.rangeOf(range),
      filters: this.filtersOf(query),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 0,
      data: rows.map((r) => ({
        orderId: toCount(r.order_id),
        orderNumber: r.order_number,
        channel: r.channel,
        branchNameSnapshot: r.branch_name,
        cashierDisplaySnapshot: r.cashier_name,
        revenueAt: r.revenue_at,
        ...rowMoney(derive(r)),
      })),
      semantics: {
        ...PROFIT_SEMANTICS,
        membership:
          'An order is listed when any of its in-scope lines has a sale or reversal event in the range; its figures are the sums of exactly those events. Ordered by revenue date DESC, then order id DESC.',
      },
    };
  }

  /** `GET /reports/profit/orders/:orderId` — every line with its cost snapshot. */
  async orderDetail(orderId: number, viewer: ReportViewer) {
    const orderRows: Array<{
      id: number;
      orderNumber: string | null;
      channel: string;
      status: string;
      fulfillmentState: string;
      soldAt: Date;
      paidAt: Date | null;
      voidedAt: Date | null;
      refundedAt: Date | null;
      branchId: number | null;
      branchNameSnapshot: string | null;
      cashierUserId: number | null;
      cashierDisplaySnapshot: string | null;
      totalPrice: string;
    }> = await this.dataSource.query(
      `SELECT o.id, o."orderNumber", o.channel::text AS channel,
              o.status::text AS status, o."fulfillmentState"::text AS "fulfillmentState",
              o."soldAt", o."paidAt", o."voidedAt", o."refundedAt",
              o."branchId", o."branchNameSnapshot",
              o."cashierUserId", o."cashierDisplaySnapshot",
              o.total_price::text AS "totalPrice"
         FROM orders o
        WHERE o.id = $1`,
      [orderId],
    );
    const order = orderRows[0];
    if (!order) throw new NotFoundException(OrderMessages.ORDER_NOT_FOUND);
    // After the 404, exactly as ReportsService.detail: "no such sale" and "not
    // for you" stay distinguishable to the one caller entitled to tell them apart.
    this.assertProfitViewer(viewer);

    const lineRows: Array<{
      id: number;
      productId: number | null;
      variantId: number | null;
      productTitle: string;
      productCode: string | null;
      variantCode: string | null;
      sku: string | null;
      quantity: number;
      unitPrice: string;
      totalPrice: string;
      costStatus: 'pending' | 'known' | 'unknown';
      cogsTotal: string | null;
      costKnownQuantity: number | null;
      costUnknownQuantity: number | null;
      costAllocatedAt: Date | null;
    }> = await this.dataSource.query(
      `SELECT oi.id, oi."productId", oi."variantId",
              oi."productTitleSnapshot" AS "productTitle",
              oi."productCodeSnapshot"  AS "productCode",
              oi."variantCodeSnapshot"  AS "variantCode",
              oi."variantSkuSnapshot"   AS sku,
              oi.quantity,
              oi.unit_price::text       AS "unitPrice",
              oi.total_price::text      AS "totalPrice",
              oi."costStatus", oi."cogsTotal"::text AS "cogsTotal",
              oi."costKnownQuantity", oi."costUnknownQuantity", oi."costAllocatedAt"
         FROM order_items oi
        WHERE oi."orderId" = $1
        ORDER BY oi.id ASC`,
      [orderId],
    );

    const adjustmentRows: Array<{
      id: number;
      orderItemId: number;
      kind: string;
      scope: string;
      revenueQuantity: number;
      revenueReversed: string;
      restockedKnownQuantity: number | null;
      restockedUnknownQuantity: number | null;
      cogsReversed: string | null;
      eventAt: Date | null;
      actorUserId: number | null;
      actorDisplaySnapshot: string | null;
      reason: string | null;
      createdAt: Date;
    }> = await this.dataSource.query(
      `SELECT a.id, a."orderItemId", a.kind, a.scope, a."revenueQuantity",
              a."revenueReversed"::text AS "revenueReversed",
              a."restockedKnownQuantity", a."restockedUnknownQuantity",
              a."cogsReversed"::text AS "cogsReversed",
              a."eventAt", a."actorUserId", a."actorDisplaySnapshot",
              a.reason, a."createdAt"
         FROM order_item_adjustments a
        WHERE a."orderId" = $1
        ORDER BY a.id ASC`,
      [orderId],
    );

    // All-time figures for this one order, through the same event relation
    // and the same formulas as every other route.
    const totals = await this.aggregateTotals({} as ProfitReportQueryDto, {
      orderId,
    });

    const countsAsSale =
      ELIGIBLE_SALE_STATUSES.includes(order.status as OrderStatusEnum) ||
      (order.voidedAt !== null && order.paidAt !== null);

    return {
      timezone: this.timezone,
      data: {
        order: {
          id: toCount(order.id),
          orderNumber: order.orderNumber,
          channel: order.channel,
          status: order.status,
          fulfillmentState: order.fulfillmentState,
          soldAt: order.soldAt,
          paidAt: order.paidAt,
          revenueAt: order.paidAt ?? order.soldAt,
          voidedAt: order.voidedAt,
          refundedAt: order.refundedAt,
          countsAsSale,
          branchId: order.branchId,
          branchNameSnapshot: order.branchNameSnapshot,
          cashierUserId: order.cashierUserId,
          cashierDisplaySnapshot: order.cashierDisplaySnapshot,
          totalPrice: toRial(order.totalPrice),
        },
        lines: lineRows.map((l) => {
          const mine = adjustmentRows.filter(
            (a) => toCount(a.orderItemId) === toCount(l.id),
          );
          const quantity = toCount(l.quantity);
          const knownQty =
            l.costKnownQuantity === null ? null : toCount(l.costKnownQuantity);
          const unknownQty =
            l.costUnknownQuantity === null
              ? null
              : toCount(l.costUnknownQuantity);
          // Units that physically left: none while pending; the recorded
          // split once consumed; the whole quantity for a legacy unknown line
          // (no split was recorded, the goods did leave).
          const consumed =
            l.costStatus === 'pending'
              ? 0
              : knownQty === null && unknownQty === null
                ? quantity
                : (knownQty ?? 0) + (unknownQty ?? 0);
          let revenueUnitsDone = 0;
          let restockDone = 0;
          for (const a of mine) {
            revenueUnitsDone += toCount(a.revenueQuantity);
            restockDone +=
              toCount(a.restockedKnownQuantity) +
              toCount(a.restockedUnknownQuantity);
          }
          return {
            orderItemId: toCount(l.id),
            productId: l.productId,
            productTitle: l.productTitle,
            productCode: l.productCode,
            variantCode: l.variantCode,
            variantId: l.variantId,
            sku: l.sku,
            quantity,
            unitPrice: toRial(l.unitPrice),
            totalPrice: toRial(l.totalPrice),
            costStatus: l.costStatus,
            cogsTotal: l.cogsTotal === null ? null : toRial(l.cogsTotal),
            // DISPLAY ONLY (contract §4): floor(cogsTotal / costKnownQuantity).
            // cogsTotal stays the authoritative figure.
            unitCostDisplay:
              l.cogsTotal !== null && knownQty !== null && knownQty > 0
                ? (toRialBigInt(l.cogsTotal) / BigInt(knownQty)).toString()
                : null,
            costKnownQuantity: knownQty,
            costUnknownQuantity: unknownQty,
            costAllocatedAt: l.costAllocatedAt,
            remaining: {
              revenueUnits: quantity - revenueUnitsDone,
              restockUnits: consumed - restockDone,
            },
            adjustments: mine.map((a) => ({
              id: toCount(a.id),
              kind: a.kind,
              scope: a.scope,
              revenueQuantity: toCount(a.revenueQuantity),
              revenueReversed: toRial(a.revenueReversed),
              restockedKnownQuantity:
                a.restockedKnownQuantity === null
                  ? null
                  : toCount(a.restockedKnownQuantity),
              restockedUnknownQuantity:
                a.restockedUnknownQuantity === null
                  ? null
                  : toCount(a.restockedUnknownQuantity),
              cogsReversed:
                a.cogsReversed === null ? null : toRial(a.cogsReversed),
              eventAt: a.eventAt,
              actorUserId: a.actorUserId,
              actorDisplaySnapshot: a.actorDisplaySnapshot,
              reason: a.reason,
              createdAt: a.createdAt,
            })),
          };
        }),
        totals: { ...totals, ...rowMoney(totals) },
      },
      semantics: {
        ...PROFIT_SEMANTICS,
        orderTotals:
          "data.totals are this order's ALL-TIME figures (no date range): every sale event and every reversal event of its lines, through the same formulas as the summary. An order that is not an eligible sale (countsAsSale=false) has no events and therefore zero totals.",
        remaining:
          "remaining.revenueUnits = quantity - sum of revenueQuantity over the line's adjustments; remaining.restockUnits = units that physically left (0 while pending; costKnownQuantity + costUnknownQuantity once consumed; quantity for a legacy unknown line) - units restocked so far.",
      },
    };
  }

  /**
   * The five headline profit figures for one local calendar day, for the
   * financial dashboard. Delegates to `aggregateTotals` — the same formulas as
   * `summary` — so the dashboard and `/reports/profit/summary?from=D&to=D`
   * cannot disagree.
   */
  async dayHeadline(date: string, viewer: ReportViewer) {
    this.assertProfitViewer(viewer);
    const figures = await this.aggregateTotals({
      from: date,
      to: date,
    } as ProfitReportQueryDto);
    return {
      grossProfit: figures.knownCost.grossProfit,
      grossMarginPercent: figures.knownCost.grossMarginPercent,
      coveragePercent: figures.coveragePercent,
      knownNetRevenue: figures.knownCost.netRevenue,
      unknownNetRevenue: figures.unknownCost.netRevenue,
    };
  }
}
