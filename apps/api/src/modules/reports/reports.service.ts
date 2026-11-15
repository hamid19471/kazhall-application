import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SalesReportQueryDto } from './dto/sales-report-query.dto';
import { OrderStatusEnum } from '../orders/enums/order-status.enum';
import { OrderMessages } from 'src/common/constants/order.messages';
import UserRoleEnum from '../user/enums/user-role.enum';
import { resolveReportTimezone } from '../orders/business-time';
import {
  OrderAction,
  OrderActionType,
} from '../orders/entities/order-action.entity';
import { subtractRial, toCount, toRial } from 'src/common/money/rial';

/** The authenticated principal, exactly as the token describes it. */
export interface ReportViewer {
  userId: number;
  roles: UserRoleEnum[];
  branchId: number | null;
}

// ===========================================================================
// ELIGIBLE SALE STATES
// ===========================================================================

/**
 * The statuses in which THE MONEY WAS ACTUALLY TAKEN.
 *
 * WHY THIS LIST EXISTS AND WHY IT IS NOT A BLACKLIST. Every total used to be
 * computed as "status NOT IN (CANCELED, FAILED)". PENDING is neither of those,
 * so it passed — and an ONLINE order sits in PENDING from the moment
 * `OrdersService.create` writes it until the gateway confirms payment. Every
 * abandoned online basket was therefore booked as revenue and as units sold,
 * and the number only ever went back down if the gateway got round to failing
 * it. A blacklist silently admits every state added later, too; this whitelist
 * refuses anything it was not told about.
 *
 *   PAID / PROCESSING / SHIPPED / DELIVERED — money taken, goods in some stage
 *       of moving. POS sales are created directly as PAID
 *       (`OrdersService.recordPosSale`: status PAID, `soldAt` = `paid_at` = the
 *       instant it was rung up), so an in-store sale is eligible the moment it
 *       exists.
 *   REFUNDED — money WAS taken and has since been given back. It stays in gross
 *       and is subtracted through `refundedTotal`, so that a period can show
 *       both what was sold and what was returned instead of the two silently
 *       cancelling to nothing.
 *
 * PENDING, FAILED and CANCELED are NOT here: no money was ever taken.
 */
export const ELIGIBLE_SALE_STATUSES: readonly OrderStatusEnum[] = Object.freeze(
  [
    OrderStatusEnum.PAID,
    OrderStatusEnum.PROCESSING,
    OrderStatusEnum.SHIPPED,
    OrderStatusEnum.DELIVERED,
    OrderStatusEnum.REFUNDED,
  ],
);

/**
 * The complement of {@link ELIGIBLE_SALE_STATUSES}: no money was taken in any of
 * these. Exported so a consumer can assert the two sets partition the enum
 * rather than re-deriving one from the other.
 */
export const NON_SALE_STATUSES: readonly OrderStatusEnum[] = Object.freeze([
  OrderStatusEnum.PENDING,
  OrderStatusEnum.CANCELED,
  OrderStatusEnum.FAILED,
]);

/** The `order_actions` rows that record a reversal (as opposed to a status move). */
const REVERSAL_ACTIONS: readonly OrderActionType[] = Object.freeze([
  OrderActionType.VOID,
  OrderActionType.RETURN,
  OrderActionType.REFUND,
]);

/**
 * TOTALS SEMANTICS -- returned verbatim in every summary response so a consumer
 * never has to guess what a number means.
 *
 * EVERY SENTENCE HERE MUST BE TRUE OF THE SQL BELOW. The previous version was
 * not: it promised refunds were attributed to the month of the return while the
 * code ranged every figure, refunds included, on `orders."soldAt"`. Consumers
 * read this block as a contract, so it is rewritten whenever the predicates
 * change and never before.
 */
export const TOTALS_SEMANTICS = Object.freeze({
  currency: 'IRR',
  moneyUnit:
    'Integer Rial, returned as a base-10 STRING on every route in this module. These are PostgreSQL bigint columns and SUM()s over them (which PostgreSQL widens to numeric); node-postgres returns both as strings so the driver never rounds, and nothing on this path converts them back. Parsing one into a JavaScript number is exact only to 2^53-1 = 9007199254740991 Rial and is silent data loss above it — netSales, being a subtraction of two such values, goes wrong before either operand does. Add and subtract these with BigInt; format them by grouping the digit string. Divide by 10 for Toman AT THE POINT OF DISPLAY if you display Toman; nothing here ever appends or removes a zero. Counts and unit quantities are ordinary numbers: they are bounded by the row count and were never at risk.',
  eligibleSaleStates:
    'A figure counts as a completed sale only when the money was actually taken. That is orders.status IN (paid, processing, shipped, delivered, refunded), PLUS voided sales, which carry status=canceled but had money taken at the till (orders."paidAt" is set and orders."voidedAt" is set). pending, failed and plain canceled orders are never sales: an ONLINE order is pending from checkout until the gateway confirms, so counting pending would book every abandoned basket as revenue.',
  revenueDate:
    'Revenue is dated by COALESCE(orders."paidAt", orders."soldAt") -- the instant the money was taken. For a POS sale that is the instant it was rung up. For an ONLINE sale it is the gateway confirmation, NOT the checkout click, because "soldAt" on an online order is stamped while it is still pending. The fallback to "soldAt" only applies to rows whose payment instant is unrecoverable (see refundsWithUnknownEventDate for the equivalent refund case).',
  refundDate:
    'Refunds are dated by orders."refundedAt", the instant the return was recorded -- NOT by the sale date. A September sale returned in October reduces OCTOBER. September still shows the sale in grossSales; October shows it in refundedTotal and in nothing else.',
  voidDate:
    'Voids are dated by orders."voidedAt", the instant the sale was reversed at the till, on the same principle as refunds.',
  grossSales:
    'Sum of orders.total_price over eligible sales whose REVENUE DATE falls in the range. Voided sales ARE included, because voidedTotal subtracts them separately: counting them in neither place would leave netSales unchanged by a void and would hide the reversal entirely.',
  refundedTotal:
    'Sum of orders.total_price over orders in status refunded whose REFUND DATE falls in the range. On an unranged (all-time) query it is every refunded order, including those whose refund date is unknown.',
  voidedTotal:
    'Sum of orders.total_price over orders whose VOID DATE falls in the range and whose money had actually been taken.',
  lineRefundedTotal:
    'Sum of order_item_adjustments."revenueReversed" over PARTIAL refunds (scope = line: POST /admin/orders/:id/line-adjustments, kinds return_refund and refund_only) whose adjustment "eventAt" falls in the range, on orders that are eligible sales and that match the non-date filters (branch, cashier, channel, status). Dated by when the partial refund was recorded, never by the sale date. A line adjustment never changes the order status, voidedAt or refundedAt, and once an order has one a whole-order void/return/refund is refused -- so no sale is ever in both refundedTotal/voidedTotal and lineRefundedTotal. On an unranged query it is every partial refund.',
  unitsReturnedByLine:
    'Units physically put back on the shelf by those same partial adjustments (return_refund and return_only), on the same predicate and the same event date as lineRefundedTotal. A refund_only adjustment returns no units; a return_only adjustment returns units but no money, so it is here and not in lineRefundedTotal.',
  netSales:
    'grossSales - refundedTotal - voidedTotal - lineRefundedTotal, each figure taken from the SAME range but from its OWN event date. Across two periods nothing is counted twice: the September sale is in September gross only, the October refund is in October refundedTotal (or, when only part of it was refunded, lineRefundedTotal) only. With no partial refunds lineRefundedTotal is 0 and this is exactly grossSales - refundedTotal - voidedTotal.',
  unitsSold:
    'Sum of order_items.quantity over exactly the orders counted in grossSales -- same predicate, same range, same event date. An order with no line items contributes 0 rather than dropping out of the count.',
  countsAgreeWithMoney:
    'salesCount, unitsSold and grossSales are produced by ONE shared SQL predicate, as are refundedCount/unitsRefunded/refundedTotal and voidedCount/unitsVoided/voidedTotal. They cannot disagree about which orders they describe.',
  orderCount:
    'Orders ATTRIBUTED TO THIS PERIOD by revenue date, whatever their status -- sales plus pending plus failed plus canceled. It is salesCount + nonSaleCount. A reversal of an EARLIER period is not in it (its order belongs to the period it was sold in) but does appear in refundedTotal/voidedTotal.',
  nonSaleCount:
    'Orders in the period that are not sales, split out as pendingCount and canceledOrFailedCount. This is where an abandoned online basket appears, and it is the ONLY place it appears.',
  refundsWithUnknownEventDate:
    'Refunded orders in scope with no recorded refund date -- refunded before the order_actions audit trail existed, or by a direct data fix. Migration 0009 deliberately left these NULL rather than dating them from the sale, which is the bug it fixed. They are EXCLUDED from a ranged refundedTotal and INCLUDED in an unranged one. This is a data-quality figure, not a period total: do not add it across periods.',
  attribution:
    'Every money figure is attributed to orders."cashierUserId", the ORIGINAL SELLER, which is written once at sale time and never overwritten. A refund, partial refund or void is NOT re-attributed to whoever processed it. The reversal actor lives in order_actions."actorUserId" and is reported separately as reversalsByActor on /reports/sales/by-cashier.',
  cancellationRule:
    'CANCELED and FAILED orders never contribute to grossSales, refundedTotal, voidedTotal or unitsSold - the money was never taken. They are reported only as canceledOrFailedCount.',
  pendingRule:
    'PENDING orders never contribute to grossSales, salesCount or unitsSold either. They are reported only as pendingCount, because a pending order is a basket, not a sale.',
  profit:
    'NOT REPORTED ON THESE SALES ROUTES. Gross profit (net sales revenue minus the COGS recognised on each order line) is reported line by line on /reports/profit/*; see docs/PURCHASE-COST-ACCOUNTING.md. Net profit is not reported anywhere: operating expenses are not modelled.',
});

/**
 * The SQL expression every revenue figure is dated by.
 *
 * Exported because migration 0009 indexes exactly this expression
 * (`idx_orders_revenue_at`); if one changes without the other the index stops
 * being used and nothing fails loudly.
 */
export const REVENUE_DATE_SQL = 'COALESCE(o."paidAt", o."soldAt")';

interface RangeBounds {
  from: string | null;
  to: string | null;
  startUtc: string | null;
  endUtc: string | null;
  timezone: string;
  boundarySql: string;
}

/**
 * Positional bind-parameter accumulator.
 *
 * Every predicate below is assembled from several helpers that each need their
 * own placeholders, and the previous code tracked `$n` by hand with
 * `params.length + 1` arithmetic at the call site. That is how the ad-hoc
 * predicates drifted apart in the first place: adding a parameter meant editing
 * offsets in three unrelated strings. Nothing here is ever interpolated.
 */
class SqlParams {
  readonly values: unknown[] = [];

  bind(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

@Injectable()
export class ReportsService {
  private readonly timezone: string;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {
    this.timezone = resolveReportTimezone(
      this.configService.get<string>('REPORT_TIMEZONE'),
    );
  }

  // ===================================================================
  // Scope / permissions
  // ===================================================================

  /**
   * ==========================================================================
   * DEFENCE IN DEPTH: the principal really is the main administrator.
   * ==========================================================================
   *
   * `ReportsController` declares `@Roles(super_admin)` and
   * `@Audiences('admin')`, and `RolesGuard` / `JwtStrategy` enforce both. This
   * method asserts the SAME rule again, one layer down, and every public method
   * on this service calls it first.
   *
   * WHY REPEAT A GUARD. The owner's rule is not delegable, and the failure mode
   * of a guard is silent: a decorator deleted in a refactor, a handler moved to
   * a controller without the class-level gate, or a future route added to this
   * service from somewhere else all open the data with nothing failing. A guard
   * protects a ROUTE; this protects the DATA. There is no code path to these
   * figures that does not pass through here.
   *
   * IT CONSULTS THE ROLE, NEVER A CAPABILITY. `roles` is written by
   * `JwtStrategy` from the database row read on the current request, so it is
   * not something a caller can present and not something a stale token carries.
   * No permission string participates: `reports.read` was retired by migration
   * 0028 precisely so that no grant, no `role_permissions` row and no request
   * body can influence this decision.
   */
  private assertReportViewer(viewer: ReportViewer): void {
    if (!viewer.roles.includes(UserRoleEnum.superAdmin)) {
      throw new ForbiddenException(OrderMessages.ORDER_ACCESS_DENIED);
    }
  }

  /**
   * Which branch the figures cover.
   *
   * Only the main administrator reaches this, so there is no branch PINNING
   * left to do: `super_admin` sees the whole business and may narrow to one
   * branch with `?branchId=`. The previous version carried two further
   * branches — a 403 for a branch-less non-administrator and a pin-to-own-branch
   * for a branch-attached one — which existed for the `sale` cashier and then
   * for a delegated `reports.read` accountant. Neither can reach this
   * controller any more, so both were dead code that only made the rule look
   * negotiable.
   */
  private resolveBranchScope(requested?: number): number | null {
    return requested ?? null;
  }

  // ===================================================================
  // Timezone-bounded range
  // ===================================================================

  /**
   * A date range is INCLUSIVE LOCAL CALENDAR DAYS in REPORT_TIMEZONE, converted
   * to UTC instants by PostgreSQL, never by the Node process's local clock:
   *
   *   start = CAST(CAST(:from AS date) AS timestamp) AT TIME ZONE :tz
   *   end   = CAST(CAST(:to   AS date) + INTERVAL '1 day' AS timestamp) AT TIME ZONE :tz
   *   filter: <event date> >= start AND <event date> < end
   *
   * `<naive timestamp> AT TIME ZONE '<IANA zone>'` yields a `timestamptz`,
   * resolving the offset with the zone's rules for that exact date. That is why
   * the zone name is used rather than a literal `+03:30`: it stays correct if
   * Iran reinstates DST, and the same code serves any other REPORT_TIMEZONE.
   * The end bound is half-open so the last local day is fully included without
   * a `23:59:59.999` fudge.
   *
   * WHICH event date is substituted depends on the figure: revenue uses
   * `COALESCE("paidAt","soldAt")`, refunds use `"refundedAt"`, voids use
   * `"voidedAt"`. Ranging all three on `"soldAt"` -- which is what this used to
   * do -- makes it impossible for an October return of a September sale to
   * reduce October, which is what the documentation has always promised.
   */
  private async resolveRange(from?: string, to?: string): Promise<RangeBounds> {
    const boundarySql =
      `-- inclusive local calendar days in :tz, half-open in UTC.\n` +
      `-- <event> is COALESCE(o."paidAt", o."soldAt") for revenue,\n` +
      `--            o."refundedAt" for refunds, o."voidedAt" for voids.\n` +
      `<event> >= CAST(CAST(:from AS date) AS timestamp) AT TIME ZONE :tz\n` +
      `AND <event> <  CAST(CAST(:to AS date) + INTERVAL '1 day' AS timestamp) AT TIME ZONE :tz`;

    if (!from && !to) {
      return {
        from: null,
        to: null,
        startUtc: null,
        endUtc: null,
        timezone: this.timezone,
        boundarySql,
      };
    }

    const effectiveFrom = from ?? to!;
    const effectiveTo = to ?? from!;

    const bounds: Array<{ start_utc: Date; end_utc: Date }> =
      await this.dataSource.query(
        `SELECT (CAST(CAST($1 AS date) AS timestamp) AT TIME ZONE $3) AS start_utc,
                (CAST(CAST($2 AS date) + INTERVAL '1 day' AS timestamp) AT TIME ZONE $3) AS end_utc`,
        [effectiveFrom, effectiveTo, this.timezone],
      );
    const row = bounds[0];

    return {
      from: effectiveFrom,
      to: effectiveTo,
      startUtc: row.start_utc.toISOString(),
      endUtc: row.end_utc.toISOString(),
      timezone: this.timezone,
      boundarySql,
    };
  }

  // ===================================================================
  // ONE shared predicate builder
  // ===================================================================

  /**
   * Half-open local-calendar-day window over an arbitrary timestamptz
   * expression, or `null` when the caller asked for no range at all.
   *
   * Returning `null` rather than the string `TRUE` matters: for an unranged
   * query a refunded order with an UNKNOWN refund date must still be counted
   * (all-time needs no date to place it), whereas for a ranged query it must be
   * excluded and reported separately. The two cases are different predicates,
   * not the same predicate with a different constant.
   */
  private rangePredicate(
    eventSql: string,
    query: SalesReportQueryDto,
    p: SqlParams,
  ): string | null {
    if (!query.from && !query.to) return null;
    const from = query.from ?? query.to!;
    const to = query.to ?? query.from!;
    const tz = p.bind(this.timezone);
    return (
      `${eventSql} >= CAST(CAST(${p.bind(from)} AS date) AS timestamp) AT TIME ZONE ${tz}` +
      ` AND ${eventSql} < CAST(CAST(${p.bind(to)} AS date) + INTERVAL '1 day' AS timestamp) AT TIME ZONE ${tz}`
    );
  }

  /** Filters that are NOT date filters, and therefore apply to every figure alike. */
  private nonDateFilters(
    query: SalesReportQueryDto,
    branchScope: number | null,
    p: SqlParams,
  ): string {
    const clauses: string[] = [];
    if (branchScope !== null) {
      clauses.push(`o."branchId" = ${p.bind(branchScope)}`);
    }
    if (query.cashierUserId !== undefined) {
      clauses.push(`o."cashierUserId" = ${p.bind(query.cashierUserId)}`);
    }
    if (query.channel) {
      clauses.push(`o.channel = ${p.bind(query.channel)}`);
    }
    if (query.status) {
      clauses.push(`o.status = ${p.bind(query.status)}`);
    }
    return clauses.length ? clauses.join('\n      AND ') : 'TRUE';
  }

  /**
   * THE eligibility predicate. `summary`, `list` and `byCashier` all read it
   * from here, which is the whole point: the three used to carry three
   * hand-written variants of "is this a sale", and they had already drifted --
   * `unitsSold` used one, `salesCount` another, `byCashier` a third.
   *
   * The second half is the VOID special case, made explicit. A voided POS sale
   * has status CANCELED, so the status whitelist alone would drop it out of
   * gross; but the money genuinely was taken at the till and `voidedTotal`
   * subtracts it, so dropping it from gross would leave `netSales` completely
   * unchanged by a void and hide the reversal. `"paidAt" IS NOT NULL` is what
   * keeps that re-inclusion honest: voiding an order the customer never paid
   * for (an online basket voided while PENDING) adds nothing to gross, so
   * nothing is subtracted from it either.
   */
  private eligibleSalePredicate(p: SqlParams): string {
    const statuses = p.bind([...ELIGIBLE_SALE_STATUSES]);
    return (
      `(o.status::text = ANY (${statuses}::text[])` +
      ` OR (o."voidedAt" IS NOT NULL AND o."paidAt" IS NOT NULL))`
    );
  }

  /**
   * The `scoped` CTE every endpoint builds on: one row per order, carrying the
   * shared booleans so that no downstream aggregate can re-invent them.
   */
  private scopedCte(
    query: SalesReportQueryDto,
    branchScope: number | null,
    p: SqlParams,
  ): string {
    const nonDate = this.nonDateFilters(query, branchScope, p);
    const isSale = this.eligibleSalePredicate(p);
    const revenueRange = this.rangePredicate(REVENUE_DATE_SQL, query, p);
    const refundRange = this.rangePredicate('o."refundedAt"', query, p);
    const voidRange = this.rangePredicate('o."voidedAt"', query, p);
    const lineRange = this.rangePredicate('a."eventAt"', query, p);

    const inRevenuePeriod = revenueRange ?? 'TRUE';
    // Ranged: the refund must have a known date inside the window. Unranged:
    // every refund belongs to "all time", including one whose date is unknown.
    const isRefundEvent = refundRange
      ? `(o.status::text = '${OrderStatusEnum.REFUNDED}' AND o."refundedAt" IS NOT NULL AND ${refundRange})`
      : `(o.status::text = '${OrderStatusEnum.REFUNDED}')`;
    const isVoidEvent = voidRange
      ? `(o."voidedAt" IS NOT NULL AND o."paidAt" IS NOT NULL AND ${voidRange})`
      : `(o."voidedAt" IS NOT NULL AND o."paidAt" IS NOT NULL)`;

    return `
      scoped AS (
        SELECT o.id,
               o."orderNumber",
               o.total_price,
               o.subtotal,
               o.status::text                AS status,
               o.channel::text               AS channel,
               o."fulfillmentState"::text    AS "fulfillmentState",
               o."paymentMethod",
               o."branchId",
               o."branchNameSnapshot",
               o."cashierUserId",
               o."cashierDisplaySnapshot",
               o."customerId",
               o."soldAt",
               o."paidAt",
               o."voidedAt",
               o."refundedAt",
               ${REVENUE_DATE_SQL}           AS revenue_at,
               ${isSale}                     AS is_sale,
               ${inRevenuePeriod}            AS in_revenue_period,
               ${isRefundEvent}              AS is_refund_event,
               ${isVoidEvent}                AS is_void_event,
               -- Aggregated per order in a scalar subquery rather than joined:
               -- a JOIN would multiply the order row by its line count for any
               -- aggregate computed alongside it, and an INNER join would drop
               -- an order that has no lines at all instead of scoring it 0.
               (SELECT COALESCE(SUM(oi.quantity), 0)::int
                  FROM order_items oi
                 WHERE oi."orderId" = o.id)  AS units,
               -- PARTIAL REFUNDS (docs/PURCHASE-COST-ACCOUNTING.md §5.1), dated
               -- by the adjustment's own "eventAt". Only an eligible sale can
               -- carry one (the line endpoint refuses anything else), and
               -- is_sale is required anyway so a later status change can never
               -- subtract money that gross never counted.
               (${isSale} AND la.events > 0) AS is_line_event,
               la.refunded                   AS line_refunded,
               la.units_returned             AS line_units_returned
          FROM orders o
          -- An aggregate with no GROUP BY yields exactly one row, so this
          -- widens the order row and can never multiply it.
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int                                           AS events,
                   COALESCE(SUM(a."revenueReversed"), 0)                   AS refunded,
                   COALESCE(SUM(COALESCE(a."restockedKnownQuantity", 0)
                              + COALESCE(a."restockedUnknownQuantity", 0)), 0)::int
                                                                           AS units_returned
              FROM order_item_adjustments a
             WHERE a."orderId" = o.id
               AND a.scope = 'line'
               ${lineRange ? `AND ${lineRange}` : ''}
          ) la ON TRUE
         WHERE ${nonDate}
      )`;
  }

  // ===================================================================
  // Endpoints
  // ===================================================================

  async summary(query: SalesReportQueryDto, viewer: ReportViewer) {
    this.assertReportViewer(viewer);
    const branchScope = this.resolveBranchScope(query.branchId);
    const range = await this.resolveRange(query.from, query.to);
    const p = new SqlParams();
    const cte = this.scopedCte(query, branchScope, p);

    const sql = `
      WITH ${cte}
      SELECT
        COUNT(*) FILTER (WHERE in_revenue_period)::int                       AS "orderCount",
        COUNT(*) FILTER (WHERE in_revenue_period AND is_sale)::int           AS "salesCount",
        COUNT(*) FILTER (WHERE in_revenue_period AND NOT is_sale)::int       AS "nonSaleCount",
        COUNT(*) FILTER (WHERE in_revenue_period AND NOT is_sale
                           AND status = '${OrderStatusEnum.PENDING}')::int   AS "pendingCount",
        COUNT(*) FILTER (WHERE in_revenue_period AND NOT is_sale
                           AND status IN ('${OrderStatusEnum.CANCELED}',
                                          '${OrderStatusEnum.FAILED}'))::int AS "canceledOrFailedCount",
        -- ::text ON EVERY MONEY AGGREGATE.
        -- SUM(bigint) is numeric, which node-postgres already returns as a
        -- string; casting states that intent in the query rather than relying
        -- on a driver default, and makes the column type match what the
        -- response contract promises. Nothing below converts it back.
        COALESCE(SUM(total_price) FILTER (WHERE in_revenue_period AND is_sale), 0)::text AS "grossSales",
        COALESCE(SUM(units)       FILTER (WHERE in_revenue_period AND is_sale), 0)::int  AS "unitsSold",
        COUNT(*)                  FILTER (WHERE is_refund_event)::int        AS "refundedCount",
        COALESCE(SUM(total_price) FILTER (WHERE is_refund_event), 0)::text   AS "refundedTotal",
        COALESCE(SUM(units)       FILTER (WHERE is_refund_event), 0)::int    AS "unitsRefunded",
        COUNT(*)                  FILTER (WHERE is_void_event)::int          AS "voidedCount",
        COALESCE(SUM(total_price) FILTER (WHERE is_void_event), 0)::text     AS "voidedTotal",
        COALESCE(SUM(units)       FILTER (WHERE is_void_event), 0)::int      AS "unitsVoided",
        COUNT(*)                  FILTER (WHERE is_line_event)::int          AS "lineAdjustedCount",
        COALESCE(SUM(line_refunded) FILTER (WHERE is_line_event), 0)::text   AS "lineRefundedTotal",
        COALESCE(SUM(line_units_returned) FILTER (WHERE is_line_event), 0)::int AS "unitsReturnedByLine",
        COUNT(*) FILTER (WHERE status = '${OrderStatusEnum.REFUNDED}'
                           AND "refundedAt" IS NULL)::int                    AS "unknownRefundCount",
        COALESCE(SUM(total_price) FILTER (WHERE status = '${OrderStatusEnum.REFUNDED}'
                           AND "refundedAt" IS NULL), 0)::text               AS "unknownRefundTotal"
      FROM scoped
    `;

    const summaryRows: Array<Record<string, string | number>> =
      await this.dataSource.query(sql, p.values);
    const row = summaryRows[0];

    // EXACT, NOT APPROXIMATE. These were `Number(...)` and `netSales` was a
    // floating-point subtraction of two of them, which is the one operation on
    // this route that loses precision FIRST: two operands can each be exactly
    // representable while their difference is not.
    const grossSales = toRial(row.grossSales);
    const refundedTotal = toRial(row.refundedTotal);
    const voidedTotal = toRial(row.voidedTotal);
    const lineRefundedTotal = toRial(row.lineRefundedTotal);

    return {
      timezone: range.timezone,
      range: {
        from: range.from,
        to: range.to,
        startUtc: range.startUtc,
        endUtc: range.endUtc,
        interpretation:
          'Inclusive local calendar days in the timezone above, converted to a half-open [startUtc, endUtc) instant range by PostgreSQL. Each figure is placed in the range by its OWN event date: revenue by when the money was taken, refunds by when they were recorded, voids by when the sale was reversed.',
        boundarySql: range.boundarySql,
      },
      filters: {
        branchId: branchScope,
        cashierUserId: query.cashierUserId ?? null,
        channel: query.channel ?? null,
        status: query.status ?? null,
      },
      totals: {
        // Counts stay numbers: bounded by the row count, explicitly safe.
        orderCount: toCount(row.orderCount),
        salesCount: toCount(row.salesCount),
        nonSaleCount: toCount(row.nonSaleCount),
        pendingCount: toCount(row.pendingCount),
        canceledOrFailedCount: toCount(row.canceledOrFailedCount),
        voidedCount: toCount(row.voidedCount),
        refundedCount: toCount(row.refundedCount),
        lineAdjustedCount: toCount(row.lineAdjustedCount),
        // Money is a base-10 string throughout, and the subtraction is BigInt.
        grossSales,
        refundedTotal,
        voidedTotal,
        lineRefundedTotal,
        netSales: subtractRial(
          grossSales,
          refundedTotal,
          voidedTotal,
          lineRefundedTotal,
        ),
        unitsSold: toCount(row.unitsSold),
        unitsVoided: toCount(row.unitsVoided),
        unitsRefunded: toCount(row.unitsRefunded),
        unitsReturnedByLine: toCount(row.unitsReturnedByLine),
      },
      // Deliberately OUTSIDE `totals`: this is a data-quality figure about rows
      // whose refund date migration 0009 could not recover, not a number to add
      // to a period. Putting it in `totals` would invite exactly that.
      dataQuality: {
        refundsWithUnknownEventDate: {
          count: toCount(row.unknownRefundCount),
          total: toRial(row.unknownRefundTotal),
          note: TOTALS_SEMANTICS.refundsWithUnknownEventDate,
        },
      },
      semantics: TOTALS_SEMANTICS,
    };
  }

  async list(query: SalesReportQueryDto, viewer: ReportViewer) {
    this.assertReportViewer(viewer);
    const branchScope = this.resolveBranchScope(query.branchId);
    const range = await this.resolveRange(query.from, query.to);
    const p = new SqlParams();
    const cte = this.scopedCte(query, branchScope, p);

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;

    // The same three event predicates the summary uses, OR'd: a row is listed
    // if ANY of its money events falls in the range. That is what makes the
    // list able to explain a period's refundedTotal -- a September sale
    // refunded in October is in the October list, flagged as a refund event and
    // NOT as a sale of October.
    const inRange = `(in_revenue_period OR is_refund_event OR is_void_event OR is_line_event)`;

    const countRows: Array<{ total: number }> = await this.dataSource.query(
      `WITH ${cte} SELECT COUNT(*)::int AS total FROM scoped WHERE ${inRange}`,
      p.values,
    );
    const countRow = countRows[0];

    const limitParam = p.bind(limit);
    const offsetParam = p.bind(offset);
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `WITH ${cte}
       SELECT id, "orderNumber", channel, status, "fulfillmentState",
              "paymentMethod", "soldAt", "paidAt", "voidedAt", "refundedAt",
              revenue_at AS "revenueAt",
              is_sale AS "countsAsSale",
              in_revenue_period AS "soldInRange",
              is_refund_event AS "refundedInRange",
              is_void_event AS "voidedInRange",
              is_line_event AS "lineAdjustedInRange",
              "branchId", "branchNameSnapshot",
              "cashierUserId", "cashierDisplaySnapshot",
              "customerId",
              -- The row's own money, cast at the boundary for the same reason
              -- the aggregates above are: these are bigint columns and the
              -- response contract says "decimal integer string".
              subtotal::text    AS subtotal,
              total_price::text AS total_price,
              units AS "unitCount",
              -- 0 unless a partial refund of this order falls in the range.
              (CASE WHEN is_line_event THEN line_refunded ELSE 0 END)::text
                                AS "lineRefundedTotal",
              (CASE WHEN is_line_event THEN line_units_returned ELSE 0 END)::int
                                AS "unitsReturnedByLine"
         FROM scoped
        WHERE ${inRange}
        ORDER BY revenue_at DESC, id DESC
        LIMIT ${limitParam} OFFSET ${offsetParam}`,
      p.values,
    );

    const total = toCount(countRow.total);

    return {
      timezone: range.timezone,
      range: {
        from: range.from,
        to: range.to,
        startUtc: range.startUtc,
        endUtc: range.endUtc,
        boundarySql: range.boundarySql,
      },
      filters: {
        branchId: branchScope,
        cashierUserId: query.cashierUserId ?? null,
        channel: query.channel ?? null,
        status: query.status ?? null,
      },
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 0,
      // Passed through untouched. The two money columns arrive as strings from
      // the ::text casts above and are re-normalised (never parsed) so a stray
      // leading zero or whitespace cannot reach a consumer; `unitCount` is
      // already an int4.
      data: rows.map((r) => ({
        ...r,
        subtotal: toRial(r.subtotal as string),
        total_price: toRial(r.total_price as string),
        lineRefundedTotal: toRial(r.lineRefundedTotal as string),
      })),
      semantics: {
        membership:
          "A row is listed when any of its money events falls in the range. countsAsSale says whether it is an eligible sale at all; soldInRange / refundedInRange / voidedInRange / lineAdjustedInRange say WHICH event put it here, and are exactly the booleans the summary aggregates. lineRefundedTotal and unitsReturnedByLine are this order's partial refunds and line returns dated in the range (0 otherwise).",
        lineRefundedTotal: TOTALS_SEMANTICS.lineRefundedTotal,
        eligibleSaleStates: TOTALS_SEMANTICS.eligibleSaleStates,
        revenueDate: TOTALS_SEMANTICS.revenueDate,
        refundDate: TOTALS_SEMANTICS.refundDate,
        attribution: TOTALS_SEMANTICS.attribution,
        profit: TOTALS_SEMANTICS.profit,
      },
    };
  }

  /**
   * Per-cashier breakdown: the direct answer to "who sold what".
   *
   * Grouped by `orders."cashierUserId"`, the ORIGINAL SELLER. That column is
   * written once from the authenticated principal and never overwritten, so a
   * refund or void processed by a supervisor cannot move the sale onto the
   * supervisor's line. Who performed the reversal is a different question with
   * a different answer, and it is returned separately as `reversalsByActor`
   * rather than mixed into the same rows.
   */
  async byCashier(query: SalesReportQueryDto, viewer: ReportViewer) {
    this.assertReportViewer(viewer);
    const branchScope = this.resolveBranchScope(query.branchId);
    const range = await this.resolveRange(query.from, query.to);
    const p = new SqlParams();
    const cte = this.scopedCte(query, branchScope, p);

    const rows: Array<Record<string, string | number | null>> =
      await this.dataSource.query(
        `WITH ${cte}
         SELECT "cashierUserId",
                MAX("cashierDisplaySnapshot")                                AS "cashierDisplaySnapshot",
                COUNT(*) FILTER (WHERE in_revenue_period)::int               AS "orderCount",
                COUNT(*) FILTER (WHERE in_revenue_period AND is_sale)::int   AS "salesCount",
                COALESCE(SUM(total_price) FILTER (WHERE in_revenue_period AND is_sale), 0)::text AS "grossSales",
                COALESCE(SUM(units)       FILTER (WHERE in_revenue_period AND is_sale), 0)::int   AS "unitsSold",
                COUNT(*)                  FILTER (WHERE is_refund_event)::int                     AS "refundedCount",
                COALESCE(SUM(total_price) FILTER (WHERE is_refund_event), 0)::text                AS "refundedTotal",
                COUNT(*)                  FILTER (WHERE is_void_event)::int                       AS "voidedCount",
                COALESCE(SUM(total_price) FILTER (WHERE is_void_event), 0)::text                  AS "voidedTotal",
                COALESCE(SUM(line_refunded) FILTER (WHERE is_line_event), 0)::text                AS "lineRefundedTotal",
                COALESCE(SUM(line_units_returned) FILTER (WHERE is_line_event), 0)::int           AS "unitsReturnedByLine"
           FROM scoped
          WHERE in_revenue_period OR is_refund_event OR is_void_event OR is_line_event
          GROUP BY "cashierUserId"
          -- ORDERED ON THE NUMERIC AGGREGATE, NOT ON THE CAST STRING.
          -- Ordering by the output alias "grossSales" would now sort the ::text
          -- column lexicographically -- "9" before "10000000" -- so the
          -- expression is repeated here in its numeric form. The tie-break on
          -- "cashierUserId" makes the order TOTAL rather than merely
          -- deterministic-by-luck: two sellers with identical gross used to
          -- come back in whatever order the grouping happened to produce.
          ORDER BY COALESCE(SUM(total_price) FILTER (WHERE in_revenue_period AND is_sale), 0) DESC NULLS LAST,
                   "cashierUserId" ASC`,
        p.values,
      );

    const reversalsByActor = await this.reversalsByActor(query, branchScope);

    return {
      timezone: range.timezone,
      range: {
        from: range.from,
        to: range.to,
        startUtc: range.startUtc,
        endUtc: range.endUtc,
      },
      data: rows.map((r) => {
        const grossSales = toRial(r.grossSales);
        const refundedTotal = toRial(r.refundedTotal);
        const voidedTotal = toRial(r.voidedTotal);
        const lineRefundedTotal = toRial(r.lineRefundedTotal);
        return {
          cashierUserId:
            r.cashierUserId === null ? null : toCount(r.cashierUserId),
          cashierDisplaySnapshot: r.cashierDisplaySnapshot,
          orderCount: toCount(r.orderCount),
          salesCount: toCount(r.salesCount),
          grossSales,
          unitsSold: toCount(r.unitsSold),
          refundedCount: toCount(r.refundedCount),
          refundedTotal,
          voidedCount: toCount(r.voidedCount),
          voidedTotal,
          lineRefundedTotal,
          unitsReturnedByLine: toCount(r.unitsReturnedByLine),
          // Same BigInt subtraction as the summary, from the same helper, so
          // the two routes cannot drift on what "net" means or on how exactly
          // it is computed.
          netSales: subtractRial(
            grossSales,
            refundedTotal,
            voidedTotal,
            lineRefundedTotal,
          ),
        };
      }),
      reversalsByActor,
      semantics: {
        ...TOTALS_SEMANTICS,
        sellerRows:
          '`data` answers "WHO SOLD IT". Every figure on a row, refundedTotal, voidedTotal and lineRefundedTotal included, belongs to the cashier who rang the sale up, never to whoever reversed it later.',
        reversalRows:
          '`reversalsByActor` answers "WHO REVERSED IT". It is built from the order_actions audit trail, grouped by actorUserId and dated by the action\'s own createdAt, so an employee who never sells anything but processes returns appears here and only here. Its totals are the SAME money as `data`\'s refundedTotal/voidedTotal, sliced by a different person -- do not add the two together. Partial refunds (lineRefundedTotal) write no order_actions row and are NOT in reversalsByActor; their actor is recorded on the super_admin-only order_item_adjustments rows.',
      },
    };
  }

  /**
   * "Who reversed it", from the append-only audit trail.
   *
   * Deliberately a separate query and a separate response key. Folding the
   * reversal actor into the per-cashier rows would mean one row could not say
   * whether its money was sold or un-sold by that person, which is precisely the
   * conflation this report exists to avoid.
   */
  private async reversalsByActor(
    query: SalesReportQueryDto,
    branchScope: number | null,
  ) {
    const p = new SqlParams();
    const nonDate = this.nonDateFilters(query, branchScope, p);
    // Dated by the ACTION's own timestamp. `order_actions."createdAt"` is
    // written in the same transaction that stamps `orders."voidedAt"` /
    // `orders."refundedAt"`, so this range agrees with the money figures above.
    const actionRange = this.rangePredicate('a."createdAt"', query, p);
    const actions = p.bind([...REVERSAL_ACTIONS]);

    const rows: Array<Record<string, string | number | null>> =
      await this.dataSource.query(
        `SELECT a."actorUserId",
                MAX(a."actorDisplaySnapshot")                                     AS "actorDisplaySnapshot",
                COUNT(*)::int                                                     AS "reversalCount",
                COUNT(*) FILTER (WHERE a.action::text = '${OrderActionType.VOID}')::int AS "voidCount",
                COUNT(*) FILTER (WHERE a.action::text <> '${OrderActionType.VOID}')::int AS "refundCount",
                COALESCE(SUM(o.total_price) FILTER (WHERE a.action::text = '${OrderActionType.VOID}'), 0)::text  AS "voidedTotal",
                COALESCE(SUM(o.total_price) FILTER (WHERE a.action::text <> '${OrderActionType.VOID}'), 0)::text AS "refundedTotal"
           FROM order_actions a
           JOIN orders o ON o.id = a."orderId"
          WHERE a.action::text = ANY (${actions}::text[])
            AND ${nonDate}
            ${actionRange ? `AND ${actionRange}` : ''}
          GROUP BY a."actorUserId"
          ORDER BY "reversalCount" DESC`,
        p.values,
      );

    return rows.map((r) => ({
      actorUserId: r.actorUserId === null ? null : toCount(r.actorUserId),
      actorDisplaySnapshot: r.actorDisplaySnapshot,
      reversalCount: toCount(r.reversalCount),
      voidCount: toCount(r.voidCount),
      refundCount: toCount(r.refundCount),
      voidedTotal: toRial(r.voidedTotal),
      refundedTotal: toRial(r.refundedTotal),
    }));
  }

  /**
   * Full sale detail, from the immutable snapshots rather than the live catalog.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS READS RAW SQL AND NOT `getRepository(Order).findOne(...)`.
   *
   * `orders.subtotal`, `orders.total_price`, `order_items.unit_price` and
   * `order_items.total_price` are `bigint` columns carrying
   * `bigIntTransformer`, whose `from()` does `Number(value)` and THROWS on
   * anything past `Number.MAX_SAFE_INTEGER`. Loading the entity therefore does
   * not merely round a large sale — it turns the whole request into a 500
   * before this method sees a single field, and there is no per-query way to
   * opt out of an entity-level transformer.
   *
   * Reading the columns directly, cast to `::text`, is what makes this route
   * obey the same contract as every aggregate above: the money leaves as an
   * exact base-10 string whatever its magnitude. The entity is still the
   * source of truth for the SHAPE — the column names below are its column
   * names — it is simply not the reader.
   *
   * `OrderAction` IS still read through its repository, because the audit trail
   * carries no money at all — only who did what, and when.
   * ---------------------------------------------------------------------------
   */
  async detail(id: number, viewer: ReportViewer) {
    const orderRows: Array<{
      id: number;
      orderNumber: string | null;
      channel: string;
      status: string;
      fulfillmentState: string;
      paymentMethod: string | null;
      /** NOT NULL since migration 0003, so `revenueAt` below always resolves. */
      soldAt: Date;
      paidAt: Date | null;
      voidedAt: Date | null;
      refundedAt: Date | null;
      branchId: number | null;
      branchNameSnapshot: string | null;
      cashierUserId: number | null;
      cashierDisplaySnapshot: string | null;
      customerId: number | null;
      customerMobile: string | null;
      customerName: string | null;
      subtotal: string;
      totalPrice: string;
    }> = await this.dataSource.query(
      `SELECT o."id",
              o."orderNumber",
              o."channel"::text            AS channel,
              o."status"::text             AS status,
              o."fulfillmentState"::text   AS "fulfillmentState",
              o."paymentMethod"::text      AS "paymentMethod",
              o."soldAt", o."paidAt", o."voidedAt", o."refundedAt",
              o."branchId", o."branchNameSnapshot",
              o."cashierUserId", o."cashierDisplaySnapshot",
              o."customerId",
              c."mobile"                   AS "customerMobile",
              c."name"                     AS "customerName",
              o."subtotal"::text           AS subtotal,
              o."total_price"::text        AS "totalPrice"
         FROM orders o
         LEFT JOIN customers c ON c."id" = o."customerId"
        WHERE o."id" = $1`,
      [id],
    );
    const order = orderRows[0];
    if (!order) throw new NotFoundException(OrderMessages.ORDER_NOT_FOUND);

    // The row exists; the principal must still be the main administrator.
    // Asserted AFTER the 404 so that "no such sale" and "not for you" stay
    // distinguishable to the one caller entitled to tell them apart.
    this.assertReportViewer(viewer);

    const itemRows: Array<{
      id: number;
      productId: number | null;
      variantId: number | null;
      productTitle: string | null;
      sku: string | null;
      attributes: Record<string, string> | null;
      quantity: number;
      unitPrice: string;
      totalPrice: string;
    }> = await this.dataSource.query(
      `SELECT oi."id",
              oi."productId",
              oi."variantId",
              oi."productTitleSnapshot"  AS "productTitle",
              oi."variantSkuSnapshot"    AS sku,
              oi."attributesSnapshot"    AS attributes,
              oi."quantity",
              oi."unit_price"::text      AS "unitPrice",
              oi."total_price"::text     AS "totalPrice"
         FROM order_items oi
        WHERE oi."orderId" = $1
        ORDER BY oi."id" ASC`,
      [id],
    );

    const actions = await this.dataSource.getRepository(OrderAction).find({
      where: { orderId: id },
      order: { createdAt: 'ASC', id: 'ASC' },
    });

    const reversal = actions.find((a) => REVERSAL_ACTIONS.includes(a.action));

    return {
      timezone: this.timezone,
      data: {
        id: toCount(order.id),
        orderNumber: order.orderNumber,
        channel: order.channel,
        status: order.status,
        fulfillmentState: order.fulfillmentState,
        paymentMethod: order.paymentMethod,
        soldAt: order.soldAt,
        // The money event axis, spelled out per order so a consumer can see
        // exactly which date each figure in the summary used.
        paidAt: order.paidAt,
        revenueAt: order.paidAt ?? order.soldAt,
        voidedAt: order.voidedAt,
        refundedAt: order.refundedAt,
        countsAsSale:
          ELIGIBLE_SALE_STATUSES.includes(order.status as OrderStatusEnum) ||
          (order.voidedAt !== null && order.paidAt !== null),
        // Attribution, as recorded at sale time and never rewritten.
        seller: {
          cashierUserId: order.cashierUserId,
          cashierDisplaySnapshot: order.cashierDisplaySnapshot,
          branchId: order.branchId,
          branchNameSnapshot: order.branchNameSnapshot,
        },
        // WHO REVERSED IT -- a different person from the seller in general, and
        // never allowed to overwrite `seller` above.
        reversedBy: reversal
          ? {
              action: reversal.action,
              actorUserId: reversal.actorUserId,
              actorDisplaySnapshot: reversal.actorDisplaySnapshot,
              reason: reversal.reason,
              at: reversal.createdAt,
            }
          : null,
        customer:
          order.customerId === null
            ? null
            : {
                id: order.customerId,
                mobile: order.customerMobile,
                name: order.customerName,
              },
        // Integer Rial as a decimal string, exactly like every other money
        // figure this module returns.
        subtotal: toRial(order.subtotal),
        totalPrice: toRial(order.totalPrice),
        items: itemRows.map((item) => ({
          id: toCount(item.id),
          productId: item.productId,
          variantId: item.variantId,
          productTitle: item.productTitle,
          sku: item.sku,
          attributes: item.attributes,
          quantity: toCount(item.quantity),
          unitPrice: toRial(item.unitPrice),
          totalPrice: toRial(item.totalPrice),
        })),
        // Who did what to this sale after it was rung up.
        actions: actions.map((a) => ({
          id: a.id,
          action: a.action,
          fromStatus: a.fromStatus,
          toStatus: a.toStatus,
          actorUserId: a.actorUserId,
          actorDisplaySnapshot: a.actorDisplaySnapshot,
          reason: a.reason,
          createdAt: a.createdAt,
        })),
      },
      semantics: {
        attribution: TOTALS_SEMANTICS.attribution,
        revenueDate: TOTALS_SEMANTICS.revenueDate,
        refundDate: TOTALS_SEMANTICS.refundDate,
        profit: TOTALS_SEMANTICS.profit,
      },
    };
  }
}
