import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { resolveReportTimezone } from '../orders/business-time';
import {
  ELIGIBLE_SALE_STATUSES,
  REVENUE_DATE_SQL,
  TOTALS_SEMANTICS,
  ReportViewer,
} from '../reports/reports.service';
import { ProfitReportService } from '../reports/profit-report.service';
import { OrderStatusEnum } from '../orders/enums/order-status.enum';
import { FulfillmentStateEnum } from '../orders/enums/fulfillment-state.enum';
import { DashboardQueryDto } from './dto/dashboard-query.dto';
import { subtractRial } from 'src/common/money/rial';

/**
 * Variants at or below this count (but above zero) are shown as "low stock".
 *
 * A DISPLAY HEURISTIC, NOT A BUSINESS RULE. Nobody has told us what a low
 * stock level is for a tent versus a head torch, and per-variant reorder points
 * are not modelled anywhere in this schema. The dashboard therefore says "N
 * variants are down to 5 or fewer" — a sentence that is true — rather than
 * "N variants need reordering", which would be a claim the data cannot support.
 * The caller may override it.
 */
export const DEFAULT_LOW_STOCK_THRESHOLD = 5;

export interface DashboardMoney {
  /** Integer Rial, as a STRING: these are bigint sums and must not round. */
  grossSales: string;
  refundedTotal: string;
  voidedTotal: string;
  /**
   * PARTIAL refunds recorded today through the line endpoint, dated by the
   * adjustment's own `eventAt` — `/reports/sales/summary`'s field of the same
   * name, on the same predicate.
   */
  lineRefundedTotal: string;
  netSales: string;
}

/**
 * ===========================================================================
 * TODAY'S FIGURES — EVERY FIELD NAMED AFTER THE TIMESTAMP THAT PLACES IT
 * ===========================================================================
 *
 * WHY THE NAMES ARE THIS LONG. There used to be a single `orderCount` here,
 * described on screen as «تعداد سفارش امروز» — "today's order count". It was
 * `COUNT(*) FILTER (WHERE in_revenue_period)`: orders whose REVENUE DATE
 * (`COALESCE("paidAt","soldAt")`) fell today, whatever their status. That is
 * three different things wearing one label:
 *
 *   - a POS sale rung up today          → placed by `paidAt`, and IS revenue;
 *   - an online order paid today but
 *     checked out yesterday             → placed by `paidAt`, and IS revenue;
 *   - an abandoned online basket created
 *     today and still PENDING           → placed by `soldAt`, which is stamped
 *                                         at CHECKOUT while the order is still
 *                                         pending, and is NOT revenue at all.
 *
 * So the number moved for two unrelated reasons and a store manager could not
 * tell which. Worse, it did NOT move when an order was created today and paid
 * tomorrow — the one reading a manager would most naturally expect from a
 * field called "today's orders".
 *
 * The fix is not a better label on one number; it is separate numbers. Every
 * field below carries its axis in its own name:
 *
 *   `ordersCreated*`      → `orders.created_at`, the row's birth instant.
 *   `*ByRevenueDate` /
 *   `salesCount` /
 *   `unitsSold` /
 *   `grossSales`          → `COALESCE(o."paidAt", o."soldAt")`, the instant the
 *                           money was taken. IDENTICAL to `ReportsService`.
 *   `refunded*`           → `orders."refundedAt"`, the instant it was given back.
 *   `voided*`             → `orders."voidedAt"`, the instant it was reversed.
 *
 * None of them is a subset or superset of another, and adding them together is
 * meaningless. That is precisely why they are no longer one field.
 */
/**
 * THE OPERATIONAL HALF: counts only, no money.
 *
 * WHY THE MONEY LEFT. `dashboard.read` is a DELEGATABLE capability — a shift
 * supervisor is meant to hold it — and the payload used to weld today's gross,
 * refunds, voids, net, the per-channel and per-BRANCH revenue split and the
 * top-selling variants' takings into the same response as the work queue. That
 * made "sales totals, refunds, void totals, cashier performance and branch
 * sales" reachable by anybody who could see the pending-order count.
 *
 * They now live on `GET /admin/dashboard/financial`, gated on the built-in
 * `super_admin` role exactly as `/reports/*` is. See `financialSummary` below.
 *
 * COUNTS STAY HERE, DELIBERATELY. `salesCount`, `unitsSold` and the refund and
 * void counts are how many, not how much: a supervisor needs "eleven sales so
 * far, two returns" to run a shift, and none of it states a figure of money.
 */
export interface DashboardCounts {
  // ---- axis: orders.created_at (pinned to UTC — see `CREATED_AT_SQL`) ------

  /**
   * Orders whose ROW WAS CREATED today, whatever their status and whether or
   * not any money has since been taken. This is the "how busy were we today"
   * number; it is NOT revenue and it never was.
   */
  ordersCreated: number;

  /**
   * Of {@link ordersCreated}, those whose money has since been taken. The
   * PAYMENT may well have landed on a LATER day — this counts the order on the
   * day it was created, not the day it was paid, which is exactly why it must
   * not be added to `salesCount`.
   */
  ordersCreatedPaid: number;

  /** Of {@link ordersCreated}, those still awaiting payment. Never revenue. */
  ordersCreatedPending: number;

  /**
   * Of {@link ordersCreated}, those that FAILED or were CANCELED without the
   * money ever being taken. A voided POS sale also carries status `canceled`,
   * but the money WAS taken at the till, so it is excluded here and reported
   * as a void instead.
   */
  ordersCreatedFailedOrCanceled: number;

  // ---- axis: COALESCE(o."paidAt", o."soldAt") — the revenue date -----------

  /**
   * Every order ATTRIBUTED TO TODAY BY REVENUE DATE, sales and non-sales
   * alike. This is the old `orderCount`, kept under a name that says what it
   * is, because `/reports/sales/summary` reports the same figure as
   * `totals.orderCount` and the two must remain comparable. It is
   * `salesCount + pendingByRevenueDate + canceledOrFailedByRevenueDate`.
   *
   * A manager should read `ordersCreated` instead; this one exists so the two
   * screens can be reconciled.
   */
  ordersByRevenueDate: number;

  /** Orders whose MONEY WAS TAKEN TODAY. The revenue count. */
  salesCount: number;

  /** `ordersByRevenueDate` minus `salesCount`. No money was taken in any of these. */
  nonSaleCount: number;

  /** Non-sales attributed to today by revenue date because `soldAt` (checkout) fell today. */
  pendingByRevenueDate: number;

  /** Ditto, for orders that failed or were canceled without payment. */
  canceledOrFailedByRevenueDate: number;

  /** Line quantities over exactly the orders in `salesCount`. */
  unitsSold: number;

  // ---- axis: o."refundedAt" ----------------------------------------------

  /** Orders REFUNDED today, however long ago they were sold. */
  refundedCount: number;
  unitsRefunded: number;

  // ---- axis: o."voidedAt" -------------------------------------------------

  /** Paid sales VOIDED today, however long ago they were rung up. */
  voidedCount: number;
  unitsVoided: number;

  // ---- axis: order_item_adjustments."eventAt" (scope = line) -------------

  /**
   * Units physically returned today by PARTIAL returns (the line endpoint),
   * however long ago they were sold. A count, not money: the Rial amount is
   * `lineRefundedTotal` on the financial half.
   */
  unitsReturnedByLine: number;
}

/**
 * ===========================================================================
 * THE FINANCIAL HALF — `GET /admin/dashboard/financial`, super_admin only
 * ===========================================================================
 *
 * Everything the owner named as restricted: "sales totals, refunds, void
 * totals, cashier performance, branch sales and similar financial report
 * data". It is a SEPARATE CONTRACT rather than a nullable branch of the
 * operational one, for the same reason `/reports/*` is a separate controller:
 * a route either serves this or it does not, and that is visible in the route
 * table instead of being a condition inside a projection.
 *
 * The gate is identical to the reporting gate — `@Roles(super_admin)` plus
 * `@Audiences('admin')` — so there is one rule about financial data in this
 * API and not two that could drift.
 */
export interface DashboardFinancial {
  timezone: string;
  period: DashboardPeriod;
  /** Today's four headline figures, integer Rial as strings. */
  money: DashboardMoney;
  /** Revenue split by sales channel. */
  byChannel: Array<{
    channel: string;
    salesCount: number;
    unitsSold: number;
    grossSales: string;
    netSales: string;
  }>;
  /** BRANCH SALES — named explicitly by the owner as restricted. */
  byBranch: Array<{
    branchId: number | null;
    branchName: string | null;
    salesCount: number;
    grossSales: string;
    netSales: string;
  }>;
  /** Today's best sellers by revenue. */
  topVariants: Array<{
    variantId: number | null;
    sku: string | null;
    productId: number | null;
    productTitle: string;
    unitsSold: number;
    grossSales: string;
  }>;
  semantics: typeof FINANCIAL_SEMANTICS;
  /**
   * Today's GROSS profit headline (never net profit), for the same local day
   * as every other figure here. Computed by `ProfitReportService` — the same
   * formulas as `/reports/profit/summary?from=<day>&to=<day>` — so the two
   * cannot disagree. See `FINANCIAL_SEMANTICS.profit`.
   */
  profit: DashboardProfit;
}

/** `GET /admin/dashboard/financial` → `profit`. Money is integer Rial as strings. */
export interface DashboardProfit {
  /** knownCost.grossProfit: known-cost net revenue − net COGS. */
  grossProfit: string;
  /** Two-decimal string, or null when known-cost net revenue ≤ 0. */
  grossMarginPercent: string | null;
  /** Known-cost gross revenue / gross revenue; null when there was none. */
  coveragePercent: string | null;
  knownNetRevenue: string;
  /** Revenue whose purchase cost is unknown or pending — NOT zero-cost profit. */
  unknownNetRevenue: string;
}

/** The local calendar day both halves describe, and its UTC bounds. */
export interface DashboardPeriod {
  date: string;
  startUtc: string;
  endUtc: string;
  label: 'today';
}

export interface DashboardSummary {
  timezone: string;
  /** The local calendar day the figures describe, and its UTC half-open bounds. */
  period: DashboardPeriod;
  totals: DashboardCounts;
  pipeline: {
    /**
     * ONLINE orders sitting in PENDING right now, of ANY age. NOT revenue, and
     * not a figure about today: it is the size of the "waiting for the gateway
     * / abandoned basket" pile.
     */
    pendingWebOrders: number;
    awaitingFulfilment: number;
    fulfilmentFailed: number;
    paidAwaitingProcessing: number;
    openReconciliationCases: number;
    refundRequiredCases: number;
  };
  inventory: {
    lowStockVariants: number;
    outOfStockVariants: number;
    trackedVariants: number;
    lowStockThreshold: number;
    /** Stock is not modelled per branch. The UI must say so. */
    scope: 'global';
  };
  /**
   * The last few orders, as a WORK QUEUE — not as a ledger.
   *
   * `totalPrice` used to be here and is gone. It is per-order money on a screen
   * gated only by `dashboard.read`, which says nothing about whether the viewer
   * may see order values at all — that is `orders.read`, and the console already
   * gates the LINK to each order on it. Eight amounts with the cashier's name
   * beside them is a cashier-performance strip in miniature.
   *
   * `branchName` and `cashierDisplay` stay: attribution without amounts says
   * who is working, not who is earning.
   */
  recentOrders: Array<{
    id: number;
    orderNumber: string | null;
    channel: string;
    status: string;
    fulfillmentState: string;
    branchName: string | null;
    cashierDisplay: string | null;
    revenueAt: string | null;
    createdAt: string;
  }>;
  /** What each figure means, returned verbatim so no consumer has to guess. */
  semantics: typeof DASHBOARD_SEMANTICS;
}

/**
 * WHICH TIMESTAMP PLACES A CREATED-ORDER IN THE DAY — and why it is pinned.
 *
 * `orders.created_at` is the BASELINE SCHEMA's naive `TIMESTAMP` (migration
 * 0001, `TIMESTAMP NOT NULL DEFAULT now()`), NOT a `timestamptz` like `soldAt`,
 * `paidAt`, `voidedAt` and `refundedAt`. Comparing a naive timestamp against
 * the `timestamptz` boundaries computed below makes PostgreSQL reinterpret it
 * in the SESSION's `TimeZone` — a per-connection SETTING rather than a fact, so
 * the same query could answer differently on two connections of the same pool.
 *
 * It is therefore pinned to UTC explicitly, which is what `now()` stores under
 * the deployed server's `TimeZone`. The comparison is then STATED rather than
 * inherited. This is the same treatment, for the same reason, that
 * `AdminOrdersService.DATE_FIELD_SQL` gives `AdminOrderDateField.CREATED`.
 */
const CREATED_AT_SQL = `(o."created_at" AT TIME ZONE 'UTC')`;

/**
 * "The money was actually taken" — written ONCE for this module.
 *
 * `$3` is the bound `ELIGIBLE_SALE_STATUSES` array, imported from
 * `ReportsService` so the whitelist itself cannot drift. The second disjunct is
 * the VOID special case, identical to `ReportsService.eligibleSalePredicate`: a
 * voided POS sale carries status `canceled`, but the cash really did cross the
 * counter and `voidedTotal` subtracts it, so excluding it from gross would make
 * a void change nothing at all. `"paidAt" IS NOT NULL` is what keeps that
 * honest — voiding a basket nobody paid for adds nothing and subtracts nothing.
 *
 * It lives at module scope because the created-at aggregate needs the SAME
 * predicate as the revenue aggregate, and inlining it twice is how "canceled"
 * and "voided" quietly become the same number on one of the two.
 */
const IS_SALE_SQL = `(o."status"::text = ANY($3::text[])
                 OR (o."voidedAt" IS NOT NULL AND o."paidAt" IS NOT NULL))`;

/**
 * The contract, returned in every response.
 *
 * The revenue/refund/void sentences are IMPORTED from `ReportsService` rather
 * than paraphrased: the dashboard and the sales report are required to agree,
 * and two hand-written descriptions of the same predicate is how they stop
 * agreeing. Only the created-at axis — which the report does not have — is
 * written here.
 */
export const DASHBOARD_SEMANTICS = Object.freeze({
  currency: TOTALS_SEMANTICS.currency,
  moneyUnit:
    'Integer Rial, returned as a STRING. These are PostgreSQL bigint sums; parsing them into a JavaScript number is silent data loss. Format them as strings.',
  dayBoundary:
    'Every figure is placed in the LOCAL CALENDAR DAY of the timezone above. The boundaries are computed in PostgreSQL as CAST(CAST(:date AS date) AS timestamp) AT TIME ZONE :tz, half-open [startUtc, endUtc), never in the API process, so the zone database and the DST rules are the same ones the sales reports use.',
  createdDate:
    "ordersCreated, ordersCreatedPaid, ordersCreatedPending and ordersCreatedFailedOrCanceled are dated by orders.created_at -- the instant the row was written. That column is the baseline schema's NAIVE timestamp, so it is compared AT TIME ZONE 'UTC' explicitly rather than in whatever the session timezone happens to be. An order created today and paid tomorrow is in ordersCreated TODAY and in salesCount TOMORROW; the two numbers are not comparable and must never be added.",
  revenueDate: TOTALS_SEMANTICS.revenueDate,
  refundDate: TOTALS_SEMANTICS.refundDate,
  voidDate: TOTALS_SEMANTICS.voidDate,
  eligibleSaleStates: TOTALS_SEMANTICS.eligibleSaleStates,
  grossSales: TOTALS_SEMANTICS.grossSales,
  netSales: TOTALS_SEMANTICS.netSales,
  lineRefundedTotal: TOTALS_SEMANTICS.lineRefundedTotal,
  unitsReturnedByLine: TOTALS_SEMANTICS.unitsReturnedByLine,
  unitsSold: TOTALS_SEMANTICS.unitsSold,
  ordersByRevenueDate:
    'The figure /reports/sales/summary calls totals.orderCount, under a name that says which timestamp placed it. Sales plus pending plus canceled/failed, all attributed by REVENUE DATE. It replaced a field called orderCount, whose name implied orders.created_at and whose value did not use it.',
  pendingWebOrders:
    'pipeline.pendingWebOrders counts ONLINE orders that are PENDING right now, of any age. It is not a figure about today and it is NEVER revenue: an online order is pending from the checkout click until the gateway confirms, so this pile is where abandoned baskets live.',
  breakdowns:
    'byChannel, byBranch and topVariants are all on the REVENUE-DATE axis, with reversals (whole-order refunds and voids, and partial line refunds) subtracted by their own event date exactly as totals does. They do not describe orders created today.',
  agreement:
    'The revenue, refund and void predicates are imported from ReportsService (ELIGIBLE_SALE_STATUSES, REVENUE_DATE_SQL) rather than restated, so /admin/dashboard/summary and /reports/sales/summary for the same day cannot disagree.',
  notReported: 'No cost-derived figure is offered on this route.',
});

/**
 * The FINANCIAL route's semantics: everything above plus the gross-profit
 * sentences. Kept off `DASHBOARD_SEMANTICS` on purpose — `/admin/dashboard/summary`
 * is reachable with the delegable `dashboard.read`, and a delegated admin must
 * not be told anything about cost or profit, not even in prose.
 */
export const FINANCIAL_SEMANTICS = Object.freeze({
  ...DASHBOARD_SEMANTICS,
  notReported:
    'No NET profit is reported: operating expenses, salaries, rent, taxes, shipping and gateway fees are not modelled. The only cost figure is `profit`, which is GROSS profit.',
  profit:
    "profit (financial route only) is today's GROSS profit headline from /reports/profit/summary for the same local day: grossProfit = knownCost.grossProfit, grossMarginPercent = knownCost.grossMarginPercent, coveragePercent, knownNetRevenue = knownCost.netRevenue, unknownNetRevenue = unknownCost.netRevenue. It is line-based and its reversals are dated by order_item_adjustments.eventAt, so it is not derived from `money`. Revenue of unknown or pending cost is reported as unknownNetRevenue and never counted as zero-cost profit.",
});

/**
 * ===========================================================================
 * THE DASHBOARD — one bounded endpoint, six bounded queries
 * ===========================================================================
 *
 * WHY IT IS ITS OWN ENDPOINT rather than the console calling the pieces. The
 * figures come from five different tables, and a screen that assembled them
 * client-side would issue one request per branch and one per cashier as soon
 * as the business grew — which is exactly the N-per-branch fan-out the brief
 * forbids. Every query below is `GROUP BY` or `LIMIT`-bounded and none of them
 * scales with the number of branches, cashiers or products.
 *
 * WHY IT AGREES WITH `/reports/sales/summary`. It imports
 * `ELIGIBLE_SALE_STATUSES` and `REVENUE_DATE_SQL` from `ReportsService` rather
 * than restating them. Two definitions of "what counts as a sale" is how a
 * dashboard and a report end up disagreeing in front of the owner, and the
 * one that gets fixed is never the one they were looking at.
 *
 * WHAT IT DELIBERATELY DOES NOT REPORT: anything derived from cost of goods,
 * which is not modelled anywhere in this schema. Such a figure would be revenue
 * wearing a misleading label.
 *
 * WHY EVERY COUNT NAMES ITS OWN TIMESTAMP — see {@link DashboardTotals}. Four
 * different event dates are in play (created / revenue / refund / void) and the
 * previous single `orderCount` silently mixed two of them.
 */
@Injectable()
export class DashboardService {
  private readonly timezone: string;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    configService: ConfigService,
    private readonly profitReports: ProfitReportService,
  ) {
    this.timezone = resolveReportTimezone(
      configService.get<string>('REPORT_TIMEZONE'),
    );
  }

  /**
   * THE DAY, resolved in PostgreSQL so the calendar arithmetic uses the same
   * zone database the report boundaries use. Computing it in Node would put
   * Tehran's DST history in two places.
   *
   * Shared by both halves so the operational and financial views can never
   * describe different days.
   */
  private async businessDay(): Promise<{
    period: DashboardPeriod;
    startUtc: Date;
    endUtc: Date;
  }> {
    const bounds = await this.dataSource.query<
      Array<{ day: string; start_utc: Date; end_utc: Date }>
    >(
      `SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS day,
              (CAST((now() AT TIME ZONE $1)::date AS timestamp) AT TIME ZONE $1) AS start_utc,
              (CAST((now() AT TIME ZONE $1)::date + INTERVAL '1 day' AS timestamp) AT TIME ZONE $1) AS end_utc`,
      [this.timezone],
    );
    const { day, start_utc: startUtc, end_utc: endUtc } = bounds[0];
    return {
      period: {
        date: day,
        startUtc: startUtc.toISOString(),
        endUtc: endUtc.toISOString(),
        label: 'today',
      },
      startUtc,
      endUtc,
    };
  }

  /**
   * THE OPERATIONAL DASHBOARD — counts, queues and stock. No money.
   *
   * WHAT LEFT, AND WHY. This used to return today's gross, refunds, voids and
   * net, the per-channel and per-BRANCH revenue split, the top variants by
   * revenue, and eight recent order amounts — all behind `dashboard.read`, a
   * capability meant to be delegated to a shift supervisor. The owner's rule is
   * that financial report data belongs to the main administrator alone, so
   * those figures moved to {@link financialSummary} behind the `super_admin`
   * role.
   *
   * IT NO LONGER RUNS THE MONEY QUERIES AT ALL. Computing a figure and then
   * declining to serialise it would still be three unnecessary aggregate scans
   * on every admin page load, and would leave the value one careless spread
   * away from the wire. The three financial queries are simply not issued here.
   */
  async summary(query: DashboardQueryDto): Promise<DashboardSummary> {
    const lowStockThreshold =
      query.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
    const { period, startUtc, endUtc } = await this.businessDay();
    const statuses = [...ELIGIBLE_SALE_STATUSES];

    const [totals, pipeline, inventory, recent] = await Promise.all([
      this.queryTotals(startUtc, endUtc, statuses),
      this.queryPipeline(),
      this.queryInventory(lowStockThreshold),
      this.queryRecentOrders(),
    ]);

    return {
      timezone: this.timezone,
      period,
      totals: totals.counts,
      pipeline,
      inventory: { ...inventory, lowStockThreshold, scope: 'global' },
      recentOrders: recent,
      semantics: DASHBOARD_SEMANTICS,
    };
  }

  /**
   * THE FINANCIAL DASHBOARD — the figures the owner restricted.
   *
   * Reached only by `GET /admin/dashboard/financial`, which carries
   * `@Roles(super_admin)` and `@Audiences('admin')` — the same pair
   * `ReportsController` carries, because it is the same rule about the same
   * kind of data.
   *
   * Every figure here is integer Rial as a base-10 STRING and agrees with
   * `/reports/sales/summary` for the same day, field for field: both import
   * `ELIGIBLE_SALE_STATUSES` and `REVENUE_DATE_SQL` from `ReportsService` and
   * both subtract with the shared `subtractRial`, so the two screens cannot
   * drift.
   */
  async financialSummary(viewer: ReportViewer): Promise<DashboardFinancial> {
    const { period, startUtc, endUtc } = await this.businessDay();
    const statuses = [...ELIGIBLE_SALE_STATUSES];

    const [totals, byChannel, byBranch, topVariants] = await Promise.all([
      this.queryTotals(startUtc, endUtc, statuses),
      this.queryByChannel(startUtc, endUtc, statuses),
      this.queryByBranch(startUtc, endUtc, statuses),
      this.queryTopVariants(startUtc, endUtc, statuses),
    ]);

    return {
      timezone: this.timezone,
      period,
      money: totals.money,
      byChannel,
      byBranch,
      topVariants,
      semantics: FINANCIAL_SEMANTICS,
      // Gross profit for the SAME local day, from the profit report itself
      // (no second copy of the formula). It asserts super_admin on its own.
      profit: await this.profitReports.dayHeadline(period.date, viewer),
    };
  }

  // =========================================================================
  // The queries
  // =========================================================================

  /**
   * The shared `scoped` CTE.
   *
   * One row per order in the day, carrying the three booleans every figure is
   * built from, so no aggregate downstream can re-invent them and disagree.
   * Mirrors `ReportsService.scopedCte` clause for clause; the only differences
   * are that the range is always "today" and there are no viewer filters.
   */
  private scopedCte(): string {
    return `
      -- NOTE: membership is by MONEY EVENT only (revenue / refund / void
      -- date). An order merely CREATED today is deliberately NOT here: adding
      -- it would put zero-valued rows into the byChannel and byBranch GROUP BY
      -- and invent channels that sold nothing. The created-at counts are a
      -- separate CTE inside queryTotals, in the SAME round trip.
      scoped AS (
        SELECT o."id",
               o."channel"::text AS channel,
               o."status"::text  AS status,
               o."branchId",
               o."branchNameSnapshot",
               o."total_price",
               ${IS_SALE_SQL}
                 AS is_sale,
               (${REVENUE_DATE_SQL} >= $1 AND ${REVENUE_DATE_SQL} < $2)
                 AS in_revenue_period,
               (o."status"::text = '${OrderStatusEnum.REFUNDED}'
                 AND o."refundedAt" IS NOT NULL
                 AND o."refundedAt" >= $1 AND o."refundedAt" < $2)
                 AS is_refund_event,
               (o."voidedAt" IS NOT NULL AND o."paidAt" IS NOT NULL
                 AND o."voidedAt" >= $1 AND o."voidedAt" < $2)
                 AS is_void_event,
               -- PARTIAL refunds / returns dated today by the adjustment's own
               -- "eventAt" — the same predicate as ReportsService.scopedCte,
               -- is_sale included, so the two screens agree to the digit.
               (${IS_SALE_SQL} AND la.events > 0)
                 AS is_line_event,
               la.refunded       AS line_refunded,
               la.units_returned AS line_units_returned
          FROM "orders" o
          -- One row per order (an aggregate with no GROUP BY), never a fan-out.
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int                         AS events,
                   COALESCE(SUM(a."revenueReversed"), 0) AS refunded,
                   COALESCE(SUM(COALESCE(a."restockedKnownQuantity", 0)
                              + COALESCE(a."restockedUnknownQuantity", 0)), 0)::int
                                                         AS units_returned
              FROM "order_item_adjustments" a
             WHERE a."orderId" = o."id"
               AND a."scope" = 'line'
               AND a."eventAt" >= $1 AND a."eventAt" < $2
          ) la ON TRUE
         WHERE (${REVENUE_DATE_SQL} >= $1 AND ${REVENUE_DATE_SQL} < $2)
            OR (o."refundedAt" >= $1 AND o."refundedAt" < $2)
            OR (o."voidedAt"   >= $1 AND o."voidedAt"   < $2)
            OR EXISTS (SELECT 1 FROM "order_item_adjustments" x
                        WHERE x."orderId" = o."id" AND x."scope" = 'line'
                          AND x."eventAt" >= $1 AND x."eventAt" < $2)
      )`;
  }

  /**
   * EVERY headline figure, on all four axes, in ONE round trip.
   *
   * The created-at counts could have been a second query; they are a second CTE
   * instead. `queryTotals` is one of six calls already issued in parallel, and
   * the rule this endpoint exists to obey is that the query count is a constant
   * — so a new question gets folded into an existing statement rather than
   * granted a request of its own. Both CTEs are single-pass aggregates over an
   * index-backed predicate, so the combined plan is no worse than the two apart.
   *
   * `revenue` and `created` each produce exactly ONE row, which is why the
   * CROSS JOIN is a widening of the row and not a fan-out.
   */
  private async queryTotals(
    startUtc: Date,
    endUtc: Date,
    statuses: string[],
  ): Promise<{ counts: DashboardCounts; money: DashboardMoney }> {
    const rows = await this.dataSource.query<Array<Record<string, string>>>(
      `WITH ${this.scopedCte()},
       units AS (
         SELECT s."id",
                COALESCE(SUM(i."quantity"), 0)::bigint AS qty
           FROM scoped s
           LEFT JOIN "order_items" i ON i."orderId" = s."id"
          GROUP BY s."id"
       ),
       -- Axis 1: the money events. Identical predicates to ReportsService.
       revenue AS (
         SELECT COUNT(*) FILTER (WHERE s.in_revenue_period)::text
                  AS "ordersByRevenueDate",
                COUNT(*) FILTER (WHERE s.in_revenue_period AND s.is_sale)::text
                  AS "salesCount",
                COUNT(*) FILTER (WHERE s.in_revenue_period AND NOT s.is_sale)::text
                  AS "nonSaleCount",
                COUNT(*) FILTER (WHERE s.in_revenue_period AND NOT s.is_sale
                                   AND s.status = '${OrderStatusEnum.PENDING}')::text
                  AS "pendingByRevenueDate",
                COUNT(*) FILTER (WHERE s.in_revenue_period AND NOT s.is_sale
                                   AND s.status IN ('${OrderStatusEnum.CANCELED}',
                                                    '${OrderStatusEnum.FAILED}'))::text
                  AS "canceledOrFailedByRevenueDate",
                COALESCE(SUM(s."total_price")
                  FILTER (WHERE s.in_revenue_period AND s.is_sale), 0)::text
                  AS "grossSales",
                COALESCE(SUM(u.qty)
                  FILTER (WHERE s.in_revenue_period AND s.is_sale), 0)::text
                  AS "unitsSold",
                COUNT(*) FILTER (WHERE s.is_refund_event)::text
                  AS "refundedCount",
                COALESCE(SUM(s."total_price") FILTER (WHERE s.is_refund_event), 0)::text
                  AS "refundedTotal",
                COALESCE(SUM(u.qty) FILTER (WHERE s.is_refund_event), 0)::text
                  AS "unitsRefunded",
                COUNT(*) FILTER (WHERE s.is_void_event)::text
                  AS "voidedCount",
                COALESCE(SUM(s."total_price") FILTER (WHERE s.is_void_event), 0)::text
                  AS "voidedTotal",
                COALESCE(SUM(u.qty) FILTER (WHERE s.is_void_event), 0)::text
                  AS "unitsVoided",
                COALESCE(SUM(s.line_refunded) FILTER (WHERE s.is_line_event), 0)::text
                  AS "lineRefundedTotal",
                COALESCE(SUM(s.line_units_returned) FILTER (WHERE s.is_line_event), 0)::text
                  AS "unitsReturnedByLine"
           FROM scoped s
           JOIN units u ON u."id" = s."id"
       ),
       -- Axis 2: orders.created_at, pinned to UTC (see CREATED_AT_SQL). The
       -- same is_sale predicate as above, so a voided POS sale is reported as a
       -- void here too and never as a cancellation.
       created AS (
         SELECT COUNT(*)::text AS "ordersCreated",
                COUNT(*) FILTER (WHERE ${IS_SALE_SQL})::text
                  AS "ordersCreatedPaid",
                COUNT(*) FILTER (WHERE NOT ${IS_SALE_SQL}
                                   AND o."status"::text = '${OrderStatusEnum.PENDING}')::text
                  AS "ordersCreatedPending",
                COUNT(*) FILTER (WHERE NOT ${IS_SALE_SQL}
                                   AND o."status"::text IN ('${OrderStatusEnum.CANCELED}',
                                                            '${OrderStatusEnum.FAILED}'))::text
                  AS "ordersCreatedFailedOrCanceled"
           FROM "orders" o
          WHERE ${CREATED_AT_SQL} >= $1
            AND ${CREATED_AT_SQL} <  $2
       )
       SELECT * FROM revenue CROSS JOIN created`,
      [startUtc, endUtc, statuses],
    );

    const row = rows[0] ?? {};
    const int = (key: string): number => Number(row[key] ?? 0);
    const money = (key: string): string => row[key] ?? '0';

    const grossSales = money('grossSales');
    const refundedTotal = money('refundedTotal');
    const voidedTotal = money('voidedTotal');
    const lineRefundedTotal = money('lineRefundedTotal');

    /*
     * ONE QUERY, TWO CONTRACTS.
     *
     * The counts and the money come out of the same two CTEs — they are the
     * same rows counted and summed — so splitting the SQL would mean scanning
     * twice to produce figures that must agree. They are returned as separate
     * objects instead, and only `financialSummary` ever reads `money`.
     */
    return {
      counts: {
        ordersCreated: int('ordersCreated'),
        ordersCreatedPaid: int('ordersCreatedPaid'),
        ordersCreatedPending: int('ordersCreatedPending'),
        ordersCreatedFailedOrCanceled: int('ordersCreatedFailedOrCanceled'),

        ordersByRevenueDate: int('ordersByRevenueDate'),
        salesCount: int('salesCount'),
        nonSaleCount: int('nonSaleCount'),
        pendingByRevenueDate: int('pendingByRevenueDate'),
        canceledOrFailedByRevenueDate: int('canceledOrFailedByRevenueDate'),
        unitsSold: int('unitsSold'),

        refundedCount: int('refundedCount'),
        unitsRefunded: int('unitsRefunded'),
        voidedCount: int('voidedCount'),
        unitsVoided: int('unitsVoided'),

        unitsReturnedByLine: int('unitsReturnedByLine'),
      },
      money: {
        grossSales,
        refundedTotal,
        voidedTotal,
        lineRefundedTotal,
        netSales: subtract(
          grossSales,
          refundedTotal,
          voidedTotal,
          lineRefundedTotal,
        ),
      },
    };
  }

  private async queryByChannel(
    startUtc: Date,
    endUtc: Date,
    statuses: string[],
  ): Promise<DashboardFinancial['byChannel']> {
    const rows = await this.dataSource.query<
      Array<{
        channel: string;
        salesCount: string;
        unitsSold: string;
        grossSales: string;
        reversedTotal: string;
        lineRefundedTotal: string;
      }>
    >(
      `WITH ${this.scopedCte()},
       units AS (
         SELECT s."id", COALESCE(SUM(i."quantity"), 0)::bigint AS qty
           FROM scoped s
           LEFT JOIN "order_items" i ON i."orderId" = s."id"
          GROUP BY s."id"
       )
       SELECT s.channel,
              COUNT(*) FILTER (WHERE s.in_revenue_period AND s.is_sale)::text
                AS "salesCount",
              COALESCE(SUM(u.qty)
                FILTER (WHERE s.in_revenue_period AND s.is_sale), 0)::text
                AS "unitsSold",
              COALESCE(SUM(s."total_price")
                FILTER (WHERE s.in_revenue_period AND s.is_sale), 0)::text
                AS "grossSales",
              COALESCE(SUM(s."total_price")
                FILTER (WHERE s.is_refund_event OR s.is_void_event), 0)::text
                AS "reversedTotal",
              COALESCE(SUM(s.line_refunded)
                FILTER (WHERE s.is_line_event), 0)::text
                AS "lineRefundedTotal"
         FROM scoped s
         JOIN units u ON u."id" = s."id"
        GROUP BY s.channel
        ORDER BY s.channel ASC`,
      [startUtc, endUtc, statuses],
    );

    return rows.map((row) => ({
      channel: row.channel,
      salesCount: Number(row.salesCount),
      unitsSold: Number(row.unitsSold),
      grossSales: row.grossSales,
      netSales: subtract(
        row.grossSales,
        row.reversedTotal,
        row.lineRefundedTotal,
      ),
    }));
  }

  /**
   * ONE query grouped by branch — never one request per branch. The result set
   * is bounded by the number of branches, which is a single-digit business
   * fact, and the `branchId IS NULL` group (online orders with no branch) is
   * kept rather than dropped so the totals reconcile.
   */
  private async queryByBranch(
    startUtc: Date,
    endUtc: Date,
    statuses: string[],
  ): Promise<DashboardFinancial['byBranch']> {
    const rows = await this.dataSource.query<
      Array<{
        branchId: number | null;
        branchName: string | null;
        salesCount: string;
        grossSales: string;
        reversedTotal: string;
        lineRefundedTotal: string;
      }>
    >(
      `WITH ${this.scopedCte()}
       SELECT s."branchId",
              COALESCE(b."name", s."branchNameSnapshot") AS "branchName",
              COUNT(*) FILTER (WHERE s.in_revenue_period AND s.is_sale)::text
                AS "salesCount",
              COALESCE(SUM(s."total_price")
                FILTER (WHERE s.in_revenue_period AND s.is_sale), 0)::text
                AS "grossSales",
              COALESCE(SUM(s."total_price")
                FILTER (WHERE s.is_refund_event OR s.is_void_event), 0)::text
                AS "reversedTotal",
              COALESCE(SUM(s.line_refunded)
                FILTER (WHERE s.is_line_event), 0)::text
                AS "lineRefundedTotal"
         FROM scoped s
         LEFT JOIN "branches" b ON b."id" = s."branchId"
        GROUP BY s."branchId", COALESCE(b."name", s."branchNameSnapshot")
        ORDER BY COALESCE(SUM(s."total_price")
                   FILTER (WHERE s.in_revenue_period AND s.is_sale), 0) DESC,
                 s."branchId" ASC NULLS LAST`,
      [startUtc, endUtc, statuses],
    );

    return rows.map((row) => ({
      branchId: row.branchId === null ? null : Number(row.branchId),
      branchName: row.branchName,
      salesCount: Number(row.salesCount),
      grossSales: row.grossSales,
      netSales: subtract(
        row.grossSales,
        row.reversedTotal,
        row.lineRefundedTotal,
      ),
    }));
  }

  /**
   * THE WORK QUEUE. Deliberately NOT limited to today: an order that has been
   * waiting three days for stock is more urgent than one that arrived an hour
   * ago, and a dashboard that only counted today's would show zero on the
   * morning the problem mattered most.
   */
  private async queryPipeline(): Promise<DashboardSummary['pipeline']> {
    const rows = await this.dataSource.query<
      Array<{
        pendingWebOrders: string;
        awaitingFulfilment: string;
        fulfilmentFailed: string;
        paidAwaitingProcessing: string;
        openReconciliationCases: string;
        refundRequiredCases: string;
      }>
    >(
      `SELECT
         COUNT(*) FILTER (
           WHERE o."status"::text = '${OrderStatusEnum.PENDING}'
             AND o."channel"::text = 'online')::text AS "pendingWebOrders",
         COUNT(*) FILTER (
           WHERE o."status"::text = '${OrderStatusEnum.PAID}'
             AND o."fulfillmentState"::text IN
                 ('${FulfillmentStateEnum.PENDING}', '${FulfillmentStateEnum.AWAITING_STOCK}'))::text
           AS "awaitingFulfilment",
         COUNT(*) FILTER (
           WHERE o."fulfillmentState"::text = '${FulfillmentStateEnum.FAILED}')::text
           AS "fulfilmentFailed",
         COUNT(*) FILTER (
           WHERE o."status"::text = '${OrderStatusEnum.PAID}'
             AND o."fulfillmentState"::text = '${FulfillmentStateEnum.FULFILLED}')::text
           AS "paidAwaitingProcessing",
         COUNT(*) FILTER (
           WHERE o."reconciliationState" IS NOT NULL
             AND o."reconciliationResolvedAt" IS NULL)::text
           AS "openReconciliationCases",
         COUNT(*) FILTER (
           WHERE o."reconciliationState" = 'refund_required'
             AND o."reconciliationResolvedAt" IS NULL)::text
           AS "refundRequiredCases"
       FROM "orders" o`,
    );

    const row = rows[0];
    return {
      pendingWebOrders: Number(row?.pendingWebOrders ?? 0),
      awaitingFulfilment: Number(row?.awaitingFulfilment ?? 0),
      fulfilmentFailed: Number(row?.fulfilmentFailed ?? 0),
      paidAwaitingProcessing: Number(row?.paidAwaitingProcessing ?? 0),
      openReconciliationCases: Number(row?.openReconciliationCases ?? 0),
      refundRequiredCases: Number(row?.refundRequiredCases ?? 0),
    };
  }

  /**
   * Availability uses the SAME definition `InventoryService.computeAvailability`
   * uses — physical stock minus ACTIVE, UNEXPIRED basket reservations and order
   * allocations. A dashboard counting raw `product_variants.stock` would call a
   * variant "in stock" while every unit of it sat in somebody's basket.
   *
   * Only ACTIVE variants are counted: a retired variant is not something to
   * reorder.
   */
  private async queryInventory(threshold: number): Promise<{
    lowStockVariants: number;
    outOfStockVariants: number;
    trackedVariants: number;
  }> {
    const rows = await this.dataSource.query<
      Array<{ low: string; out: string; tracked: string }>
    >(
      `WITH avail AS (
         SELECT v."id",
                v."stock"
                  - COALESCE(SUM(r."quantity") FILTER (WHERE r."kind" = 'basket'), 0)
                  - COALESCE(SUM(r."quantity") FILTER (WHERE r."kind" = 'order'), 0)
                  AS available
           FROM "product_variants" v
           LEFT JOIN "stock_reservations" r
                  ON r."variantId" = v."id"
                 AND r."status" = 'active'
                 AND r."expiresAt" > now()
          WHERE v."isActive" = true
          GROUP BY v."id", v."stock"
       )
       SELECT COUNT(*) FILTER (WHERE available > 0 AND available <= $1)::text AS low,
              COUNT(*) FILTER (WHERE available <= 0)::text AS out,
              COUNT(*)::text AS tracked
         FROM avail`,
      [threshold],
    );

    const row = rows[0];
    return {
      lowStockVariants: Number(row?.low ?? 0),
      outOfStockVariants: Number(row?.out ?? 0),
      trackedVariants: Number(row?.tracked ?? 0),
    };
  }

  /**
   * Top sellers, read from the IMMUTABLE ITEM SNAPSHOTS.
   *
   * `order_items.productTitleSnapshot` / `variantSkuSnapshot` are what the
   * receipt said; the product and variant FKs are `ON DELETE SET NULL`. Reading
   * the live catalogue instead would make a renamed product look like a
   * different product and a deleted one vanish from its own sales.
   */
  private async queryTopVariants(
    startUtc: Date,
    endUtc: Date,
    statuses: string[],
  ): Promise<DashboardFinancial['topVariants']> {
    const rows = await this.dataSource.query<
      Array<{
        variantId: number | null;
        sku: string | null;
        productId: number | null;
        productTitle: string;
        unitsSold: string;
        grossSales: string;
      }>
    >(
      `WITH ${this.scopedCte()}
       SELECT i."variantId",
              MAX(i."variantSkuSnapshot") AS sku,
              MAX(i."productId")          AS "productId",
              MAX(i."productTitleSnapshot") AS "productTitle",
              SUM(i."quantity")::text     AS "unitsSold",
              SUM(i."total_price")::text  AS "grossSales"
         FROM scoped s
         JOIN "order_items" i ON i."orderId" = s."id"
        WHERE s.in_revenue_period AND s.is_sale
        GROUP BY i."variantId"
        ORDER BY SUM(i."quantity") DESC, i."variantId" ASC
        LIMIT 5`,
      [startUtc, endUtc, statuses],
    );

    return rows.map((row) => ({
      variantId: row.variantId === null ? null : Number(row.variantId),
      sku: row.sku,
      productId: row.productId === null ? null : Number(row.productId),
      productTitle: row.productTitle,
      unitsSold: Number(row.unitsSold),
      grossSales: row.grossSales,
    }));
  }

  /** The last eight orders, whatever their state. Bounded by LIMIT, not by date. */
  private async queryRecentOrders(): Promise<DashboardSummary['recentOrders']> {
    const rows = await this.dataSource.query<
      Array<{
        id: number;
        orderNumber: string | null;
        channel: string;
        status: string;
        fulfillmentState: string;
        branchName: string | null;
        cashierDisplay: string | null;
        revenueAt: Date | null;
        createdAt: Date;
      }>
    >(
      `SELECT o."id", o."orderNumber", o."channel"::text AS channel,
              o."status"::text AS status,
              o."fulfillmentState"::text AS "fulfillmentState",
              COALESCE(b."name", o."branchNameSnapshot") AS "branchName",
              o."cashierDisplaySnapshot" AS "cashierDisplay",
              ${REVENUE_DATE_SQL} AS "revenueAt",
              o."created_at" AS "createdAt"
         FROM "orders" o
         LEFT JOIN "branches" b ON b."id" = o."branchId"
        ORDER BY o."created_at" DESC, o."id" DESC
        LIMIT 8`,
    );

    return rows.map((row) => ({
      id: Number(row.id),
      orderNumber: row.orderNumber,
      channel: row.channel,
      status: row.status,
      fulfillmentState: row.fulfillmentState,
      branchName: row.branchName,
      cashierDisplay: row.cashierDisplay,
      revenueAt: row.revenueAt ? row.revenueAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}

/**
 * Subtraction over integer-Rial STRINGS.
 *
 * DELEGATES TO THE SHARED HELPER. This used to be a private copy, and
 * `ReportsService` computed the same figure with `-` on two JavaScript
 * numbers. Two implementations of "net sales" is one too many when the whole
 * point of `/admin/dashboard/summary` is that it agrees with
 * `/reports/sales/summary` to the digit: the two screens are reconciled by
 * operators, and a difference of one Rial between them is indistinguishable
 * from a bug in the data.
 *
 * Kept as a named local function rather than inlining `subtractRial` at the
 * call sites so the reason above has somewhere to live.
 */
function subtract(base: string, ...deductions: string[]): string {
  return subtractRial(base, ...deductions);
}
