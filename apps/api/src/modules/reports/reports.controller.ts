import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ReportsService, ReportViewer } from './reports.service';
import { SalesReportQueryDto } from './dto/sales-report-query.dto';
import {
  ProfitBreakdownQueryDto,
  ProfitReportQueryDto,
} from './dto/profit-report-query.dto';
import { ProfitReportService } from './profit-report.service';
import { UserRequest } from 'src/common/interfaces/user-request.interface';
import {
  ACCESS_TOKEN_SECURITY_SCHEME,
  ApiAuthRequired,
  ApiErrorEnvelope,
  ApiInvalidInput,
  ApiNotFound,
  PARSE_INT_PIPE_400,
  VALIDATION_PIPE_400,
  successEnvelopeSchema,
} from 'src/configs/swagger.config';
import { Audiences } from 'src/modules/auth/decorators/audience.decorator';
import { Roles } from 'src/modules/auth/decorators/role.decorator';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';

/**
 * THE MONEY CONTRACT, stated once and appended to every schema below that
 * carries a monetary field, so a reader of any single route sees it without
 * having to find this file's header.
 */
const MONEY_CONTRACT =
  'EVERY MONETARY VALUE ON THIS CONTROLLER IS INTEGER RIAL AS A BASE-10 ' +
  'STRING (e.g. "9007199254740993"), never a JSON number. These are ' +
  'PostgreSQL bigint columns and SUM()s over them; a JSON number is exact ' +
  'only to 2^53-1 = 9007199254740991, so parsing one is silent data loss ' +
  'above that -- and netSales, a subtraction of two such values, goes wrong ' +
  'before either operand does. Add and subtract them with BigInt and format ' +
  'them by grouping the digit string. Counts and unit quantities remain JSON ' +
  'numbers: they are bounded by the number of rows and line quantities in ' +
  'the database. The unit is always Rial and nothing here converts to Toman.';

/**
 * Sales reporting.
 *
 * ROUTES (the full paths, exactly as mounted):
 *   GET /reports/sales/summary     totals for a range
 *   GET /reports/sales             paginated rows behind those totals
 *   GET /reports/sales/by-cashier  the same totals grouped by the SELLER,
 *                                  plus reversalsByActor grouped by whoever
 *                                  processed the reversal
 *   GET /reports/sales/:id         one sale with its line items and audit trail
 *
 * The cashier filter is `cashierUserId` (the numeric user id of the SELLER) on
 * every one of them, e.g.
 *   GET /reports/sales/summary?from=2026-09-01&to=2026-09-30&cashierUserId=4
 *
 * ==========================================================================
 * AUTHORISATION: THE BUILT-IN `super_admin` ROLE, ON AN `admin` SESSION.
 * ==========================================================================
 *
 * The owner's rule is not negotiable and not delegable:
 *
 *   "Sales reports are available only to the main administrator, represented
 *    by the built-in `super_admin` role."
 *
 * Two independent gates, both of which must pass:
 *
 *   `@Audiences('admin')`  the session must be an ADMIN session. A
 *                          `super_admin` holding a valid POS cookie is
 *                          refused 401 here — same person, wrong surface.
 *                          The till is for selling; reporting is a console
 *                          activity.
 *   `@Roles(superAdmin)`   the principal must hold the BUILT-IN role. Roles
 *                          are read from the database by `JwtStrategy` on
 *                          every request, so demoting an administrator takes
 *                          effect on their next call, not at their next login.
 *
 * `ReportsService.assertReportViewer` re-asserts the same rule below the
 * controller, so removing a decorator does not open the route.
 *
 * WHY NO CAPABILITY CODE. `reports.read` used to gate this controller, and
 * migration 0028 retired it. A catalogue permission exists so that it CAN be
 * delegated — the RBAC editor lists it and any custom role may hold it — so
 * publishing one for sales reporting made the rule a convention rather than a
 * control, and the convention had already broken: a delegated "accountant"
 * role was being created, documented and asserted against. A retired code
 * grants nothing even when a stale `role_permissions` row still names it,
 * because `PermissionService` filters `retiredAt IS NULL` everywhere.
 *
 * WHAT A CASHIER STILL GETS, and why it is not reporting: the receipt for the
 * sale they themselves rang up, from the `POST /orders/pos` response and from
 * `GET /orders/:id` under `pos.receipt.read_own`, which refuses another
 * cashier's sale with a 404. Seeing your own sale is not a sales report.
 *
 * EVERY FIGURE IS DATED BY ITS OWN EVENT. Revenue is dated by when the money
 * was taken, refunds by when they were recorded, voids by when the sale was
 * reversed -- so an October return of a September sale reduces October. See
 * `TOTALS_SEMANTICS`, which every summary response carries verbatim.
 *
 * PROFIT IS GROSS PROFIT, ON ITS OWN ROUTES. `/reports/sales/*` stays
 * order-level revenue with no cost figure. `/reports/profit/*`
 * (`ProfitReportService`, docs/PURCHASE-COST-ACCOUNTING.md §9/§13) reports
 * GROSS profit from the order-line cost snapshots — never "net profit",
 * because operating costs are not modelled:
 *   GET /reports/profit/summary            totals, known vs unknown cost
 *   GET /reports/profit/breakdown          grouped by day|branch|channel|
 *                                          cashier|product|variant|category
 *   GET /reports/profit/orders             one row per order
 *   GET /reports/profit/orders/:orderId    lines with cost snapshots
 */
@ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
@ApiTags('Reports')
/*
 * BOTH gates, at class level, so no handler can be added without them.
 *
 * `@Audiences('admin')` alone was previously `('admin', 'pos')`, which let a
 * `super_admin` read the whole business's takings from a till. The POS
 * application no longer has a reporting screen at all, and the API no longer
 * has a door for one.
 */
@Roles(UserRoleEnum.superAdmin)
@Controller('reports')
@Audiences('admin')
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly profitReportService: ProfitReportService,
  ) {}

  @ApiOperation({
    summary: 'Sales totals for a date range',
    description:
      'GET /reports/sales/summary?from=2026-09-01&to=2026-09-30&cashierUserId=4\n\n' +
      'Date ranges are inclusive local calendar days in REPORT_TIMEZONE ' +
      '(default Asia/Tehran) converted to a half-open UTC instant range in SQL. ' +
      'The response states the timezone, the resolved UTC bounds and the exact ' +
      'meaning of every total in its `semantics` block.\n\n' +
      'Only orders in which the money was actually taken count as sales: ' +
      'paid, processing, shipped, delivered, refunded, plus voided sales whose ' +
      'money had been taken at the till. A pending online order is NOT revenue ' +
      'and appears only as pendingCount.\n\n' +
      'Each figure is placed in the range by its own event date: grossSales and ' +
      'unitsSold by when the money was taken, refundedTotal by when the refund ' +
      'was recorded, voidedTotal by when the sale was reversed. A September sale ' +
      'refunded in October therefore appears in September grossSales and in ' +
      'October refundedTotal, and in neither twice.',
  })
  @ApiOkResponse({
    description:
      'The totals. Every key is spread at the TOP level of the success ' +
      'envelope — there is NO `data` wrapper on this route.',
    schema: successEnvelopeSchema({
      properties: {
        timezone: { type: 'string', example: 'Asia/Tehran' },
        range: {
          type: 'object',
          properties: {
            from: { type: 'string', example: '2026-09-01' },
            to: { type: 'string', example: '2026-09-30' },
            startUtc: { type: 'string', format: 'date-time' },
            endUtc: {
              type: 'string',
              format: 'date-time',
              description: 'EXCLUSIVE — the range is half-open.',
            },
            boundarySql: { type: 'string' },
          },
        },
        filters: {
          type: 'object',
          description:
            'The filters actually applied, INCLUDING the branch the server ' +
            'resolved for the caller.',
        },
        totals: {
          type: 'object',
          description:
            'orderCount, salesCount, nonSaleCount, pendingCount, ' +
            'canceledOrFailedCount, voidedCount, refundedCount, unitsSold, ' +
            'unitsVoided and unitsRefunded are integers. grossSales, ' +
            'refundedTotal, voidedTotal and netSales are DECIMAL INTEGER ' +
            'STRINGS of Rial. ' +
            MONEY_CONTRACT,
          properties: {
            grossSales: { type: 'string', example: '17000000' },
            refundedTotal: { type: 'string', example: '4000000' },
            voidedTotal: { type: 'string', example: '3000000' },
            netSales: {
              type: 'string',
              example: '10000000',
              description:
                'grossSales - refundedTotal - voidedTotal, computed in BigInt. ' +
                'May be negative, e.g. "-6000000", when a period returns more ' +
                'than it sold.',
            },
            salesCount: { type: 'integer', example: 4 },
            unitsSold: { type: 'integer', example: 11 },
          },
        },
        dataQuality: {
          type: 'object',
          description:
            'Deliberately OUTSIDE `totals`: refunds whose event date could ' +
            'not be recovered. A data-quality figure, not a number to add to ' +
            'a period. Shape: ' +
            '`{ refundsWithUnknownEventDate: { count, total, note } }`, where ' +
            '`total` is a decimal integer string of Rial.',
          properties: {
            refundsWithUnknownEventDate: {
              type: 'object',
              properties: {
                count: { type: 'integer', example: 1 },
                total: { type: 'string', example: '9000000' },
                note: { type: 'string' },
              },
            },
          },
        },
        semantics: {
          type: 'object',
          description:
            'The exact meaning of every total, returned verbatim on every ' +
            'summary so a consumer never has to guess.',
        },
      },
    }),
  })
  @ApiInvalidInput(
    `${VALIDATION_PIPE_400}. \`from\` and \`to\` must be YYYY-MM-DD local ` +
      'calendar days.',
  )
  @ApiAuthRequired()
  @ApiErrorEnvelope(
    403,
    'The principal does not hold the built-in `super_admin` role. Sales ' +
      'reporting is not delegable: no capability code grants it and no custom ' +
      'role can hold it.',
  )
  @Get('sales/summary')
  summary(@Query() query: SalesReportQueryDto, @Req() req: UserRequest) {
    return this.reportsService.summary(query, this.viewerOf(req));
  }

  @ApiOperation({
    summary: 'Paginated list of sales',
    description:
      'GET /reports/sales?from=2026-09-01&to=2026-09-30&cashierUserId=4&page=1&limit=20\n\n' +
      'Filters: from, to, cashierUserId (the SELLER), branchId (super_admin ' +
      'only), channel, status, page, limit.\n\n' +
      'A row is listed when ANY of its money events falls in the range, so the ' +
      'list can explain the summary: each row carries countsAsSale plus ' +
      'soldInRange / refundedInRange / voidedInRange, which are exactly the ' +
      'booleans the summary aggregates.',
  })
  @ApiOkResponse({
    description:
      'One page of sales. Spread at the TOP level of the envelope: `data` ' +
      'holds the rows and `page` / `limit` / `total` / `totalPages` sit ' +
      'beside it, not inside it.',
    schema: successEnvelopeSchema({
      data: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            subtotal: { type: 'string', example: '5000000' },
            total_price: {
              type: 'string',
              example: '5000000',
              description: 'snake_case on this route, deliberately.',
            },
            unitCount: { type: 'integer', example: 2 },
          },
        },
        description:
          'One row per sale, each carrying countsAsSale plus soldInRange / ' +
          'refundedInRange / voidedInRange. `subtotal` and `total_price` are ' +
          'DECIMAL INTEGER STRINGS of Rial. ' +
          MONEY_CONTRACT,
      },
      properties: {
        timezone: { type: 'string', example: 'Asia/Tehran' },
        range: {
          type: 'object',
          properties: {
            from: { type: 'string', example: '2026-09-01' },
            to: { type: 'string', example: '2026-09-30' },
            startUtc: { type: 'string', format: 'date-time' },
            endUtc: {
              type: 'string',
              format: 'date-time',
              description: 'EXCLUSIVE — the range is half-open.',
            },
            boundarySql: { type: 'string' },
          },
        },
        filters: {
          type: 'object',
          description:
            'The filters actually applied, INCLUDING the branch the server ' +
            'resolved for the caller.',
        },
        page: { type: 'integer', example: 1 },
        limit: { type: 'integer', example: 20 },
        total: { type: 'integer', example: 184 },
        totalPages: { type: 'integer', example: 10 },
        semantics: { type: 'object' },
      },
    }),
  })
  @ApiInvalidInput(
    `${VALIDATION_PIPE_400}. \`from\` and \`to\` must be YYYY-MM-DD local ` +
      'calendar days.',
  )
  @ApiAuthRequired()
  @ApiErrorEnvelope(
    403,
    'The principal does not hold the built-in `super_admin` role. Sales ' +
      'reporting is not delegable: no capability code grants it and no custom ' +
      'role can hold it.',
  )
  @Get('sales')
  list(@Query() query: SalesReportQueryDto, @Req() req: UserRequest) {
    return this.reportsService.list(query, this.viewerOf(req));
  }

  @ApiOperation({
    summary: 'Sales totals grouped by cashier',
    description:
      'GET /reports/sales/by-cashier?from=2026-09-01&to=2026-09-30\n\n' +
      '`data` answers "who sold it": every figure on a row belongs to ' +
      'orders.cashierUserId, the original seller, which is never overwritten by ' +
      'a later reversal. `reversalsByActor` answers "who reversed it", from the ' +
      'order_actions audit trail. The two are the same money sliced by different ' +
      'people and must not be added together.',
  })
  @ApiOkResponse({
    description:
      'Two different slices of the same money, spread at the TOP level of the ' +
      'envelope. Do NOT add them together.',
    schema: successEnvelopeSchema({
      data: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            grossSales: { type: 'string', example: '5000000' },
            refundedTotal: { type: 'string', example: '0' },
            voidedTotal: { type: 'string', example: '0' },
            netSales: { type: 'string', example: '5000000' },
            salesCount: { type: 'integer', example: 1 },
            unitsSold: { type: 'integer', example: 1 },
          },
        },
        description:
          'One row per SELLER (orders.cashierUserId), which is never ' +
          'overwritten by a later reversal. Ordered by grossSales DESC with ' +
          'cashierUserId ASC as a total tie-break. Money is a DECIMAL ' +
          'INTEGER STRING of Rial. ' +
          MONEY_CONTRACT,
      },
      properties: {
        timezone: { type: 'string', example: 'Asia/Tehran' },
        range: {
          type: 'object',
          properties: {
            from: { type: 'string', example: '2026-09-01' },
            to: { type: 'string', example: '2026-09-30' },
            startUtc: { type: 'string', format: 'date-time' },
            endUtc: {
              type: 'string',
              format: 'date-time',
              description: 'EXCLUSIVE — the range is half-open.',
            },
            boundarySql: { type: 'string' },
          },
        },
        filters: {
          type: 'object',
          description:
            'The filters actually applied, INCLUDING the branch the server ' +
            'resolved for the caller.',
        },
        reversalsByActor: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              voidedTotal: { type: 'string', example: '800000' },
              refundedTotal: { type: 'string', example: '300000' },
              reversalCount: { type: 'integer', example: 2 },
            },
          },
          description:
            'One row per person who PROCESSED a reversal, from the ' +
            'order_actions audit trail and dated by the action itself. Its ' +
            'totals are the SAME money as `data`, sliced by a different ' +
            'person -- never add the two lists together. Money is a DECIMAL ' +
            'INTEGER STRING of Rial.',
        },
        semantics: { type: 'object' },
      },
    }),
  })
  @ApiInvalidInput(
    `${VALIDATION_PIPE_400}. \`from\` and \`to\` must be YYYY-MM-DD local ` +
      'calendar days.',
  )
  @ApiAuthRequired()
  @ApiErrorEnvelope(
    403,
    'The principal does not hold the built-in `super_admin` role. Sales ' +
      'reporting is not delegable: no capability code grants it and no custom ' +
      'role can hold it.',
  )
  @Get('sales/by-cashier')
  byCashier(@Query() query: SalesReportQueryDto, @Req() req: UserRequest) {
    return this.reportsService.byCashier(query, this.viewerOf(req));
  }

  // =========================================================================
  // GROSS PROFIT — /reports/profit/*  (docs/PURCHASE-COST-ACCOUNTING.md §9, §13)
  //
  // Declared BEFORE `sales/:id` so no parameterised route can ever shadow
  // them. Same class-level gates (super_admin role + admin audience), and
  // `ProfitReportService` re-asserts the role on every method. GROSS profit
  // only: no operating cost is modelled, so nothing here is net profit.
  // =========================================================================

  @ApiOperation({
    summary: 'Gross profit totals for a date range (NOT net profit)',
    description:
      'GET /reports/profit/summary?from=2026-09-01&to=2026-09-30\n\n' +
      'Line-based gross profit: net sales revenue minus the cost of goods sold, ' +
      'over lines whose purchase cost is known. Unknown or pending cost is never ' +
      'treated as zero: that revenue is reported under `unknownCost` and ' +
      '`coveragePercent` says how much of the revenue has a known cost. ' +
      'Inventory losses are reported separately and are never COGS. Filters: ' +
      'from, to (inclusive Asia/Tehran days), channel, branchId, cashierUserId, ' +
      'productId, variantId, categoryId. The `semantics` block states the exact ' +
      'meaning of every figure.',
  })
  @ApiOkResponse({
    description:
      'Spread at the top level of the envelope: `timezone`, `range`, ' +
      '`filters`, `totals` (with `knownCost`, `unknownCost`, `coveragePercent`, ' +
      '`inventoryLosses`), `dataQuality`, `semantics`. ' +
      MONEY_CONTRACT,
    schema: successEnvelopeSchema({
      properties: {
        timezone: { type: 'string', example: 'Asia/Tehran' },
        range: { type: 'object' },
        filters: { type: 'object' },
        totals: { type: 'object' },
        dataQuality: { type: 'object' },
        semantics: { type: 'object' },
      },
    }),
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiAuthRequired()
  @ApiErrorEnvelope(
    403,
    'The principal does not hold the built-in `super_admin` role. Cost and ' +
      'profit are not delegable.',
  )
  @Get('profit/summary')
  profitSummary(@Query() query: ProfitReportQueryDto, @Req() req: UserRequest) {
    return this.profitReportService.summary(query, this.viewerOf(req));
  }

  @ApiOperation({
    summary:
      'Gross profit grouped by day, branch, channel, cashier, product, variant or category',
    description:
      'GET /reports/profit/breakdown?groupBy=product&from=2026-09-01&to=2026-09-30\n\n' +
      'Rows are ordered complete cost coverage first, then partial, then none, ' +
      'and by grossProfit DESC within each class, so an unknown-cost product ' +
      'is never ranked as highly profitable. groupBy=category rows overlap ' +
      '(a product in two categories counts in both) and must not be summed.',
  })
  @ApiOkResponse({
    description:
      'One page of rows: `data` plus `page` / `limit` / `total` / ' +
      '`totalPages` beside it. ' +
      MONEY_CONTRACT,
    schema: successEnvelopeSchema({
      data: { type: 'array', items: { type: 'object' } },
      properties: {
        groupBy: { type: 'string', example: 'product' },
        page: { type: 'integer', example: 1 },
        limit: { type: 'integer', example: 20 },
        total: { type: 'integer', example: 3 },
        totalPages: { type: 'integer', example: 1 },
        semantics: { type: 'object' },
      },
    }),
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiAuthRequired()
  @ApiErrorEnvelope(
    403,
    'The principal does not hold the built-in `super_admin` role.',
  )
  @Get('profit/breakdown')
  profitBreakdown(
    @Query() query: ProfitBreakdownQueryDto,
    @Req() req: UserRequest,
  ) {
    return this.profitReportService.breakdown(query, this.viewerOf(req));
  }

  @ApiOperation({
    summary: 'Gross profit per order',
    description:
      'GET /reports/profit/orders?from=2026-09-01&to=2026-09-30&page=1&limit=20\n\n' +
      'One row per order with any in-scope line event (sale or reversal) in ' +
      'the range, carrying the same money fields as a breakdown row.',
  })
  @ApiOkResponse({
    description: 'One page of orders. ' + MONEY_CONTRACT,
    schema: successEnvelopeSchema({
      data: { type: 'array', items: { type: 'object' } },
      properties: {
        page: { type: 'integer', example: 1 },
        limit: { type: 'integer', example: 20 },
        total: { type: 'integer', example: 3 },
        totalPages: { type: 'integer', example: 1 },
        semantics: { type: 'object' },
      },
    }),
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiAuthRequired()
  @ApiErrorEnvelope(
    403,
    'The principal does not hold the built-in `super_admin` role.',
  )
  @Get('profit/orders')
  profitOrders(@Query() query: ProfitReportQueryDto, @Req() req: UserRequest) {
    return this.profitReportService.orders(query, this.viewerOf(req));
  }

  @ApiOperation({
    summary: 'One order with every line’s cost snapshot and reversals',
    description:
      'The header, each line with its immutable cost snapshot, a display-only ' +
      'unit cost, what can still be reversed or restocked, the line’s ' +
      'adjustments, and the order’s all-time gross-profit totals.',
  })
  @ApiParam({
    name: 'orderId',
    type: Number,
    description: 'Numeric `orders.id`.',
    example: 41,
  })
  @ApiOkResponse({
    description: 'One order. ' + MONEY_CONTRACT,
    schema: successEnvelopeSchema({
      data: { type: 'object' },
      properties: {
        timezone: { type: 'string', example: 'Asia/Tehran' },
        semantics: { type: 'object' },
      },
    }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiErrorEnvelope(
    403,
    'The principal does not hold the built-in `super_admin` role.',
  )
  @ApiNotFound('No order has that id.')
  @Get('profit/orders/:orderId')
  profitOrderDetail(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Req() req: UserRequest,
  ) {
    return this.profitReportService.orderDetail(orderId, this.viewerOf(req));
  }

  @ApiOperation({
    summary: 'One sale with its line items and audit trail',
    description:
      'Line items are rendered from the immutable sale-time snapshots, so the ' +
      'response is stable even after the catalog changes or a product is deleted.',
  })
  @ApiParam({
    name: 'id',
    type: Number,
    description: 'Numeric `orders.id` of the sale.',
    example: 41,
  })
  @ApiOkResponse({
    description: 'One sale, its line items and its audit trail.',
    schema: successEnvelopeSchema({
      data: {
        type: 'object',
        description:
          'Carries `seller` (as recorded at sale time), `reversedBy` (who ' +
          'reversed it, or null), `customer`, `items` from the immutable ' +
          'snapshots, and `actions`. `subtotal`, `totalPrice` and each ' +
          "item's `unitPrice` / `totalPrice` are DECIMAL INTEGER STRINGS " +
          'of Rial. ' +
          MONEY_CONTRACT,
        properties: {
          subtotal: { type: 'string', example: '5000000' },
          totalPrice: { type: 'string', example: '5000000' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                quantity: { type: 'integer', example: 2 },
                unitPrice: { type: 'string', example: '2500000' },
                totalPrice: { type: 'string', example: '5000000' },
              },
            },
          },
        },
      },
      properties: {
        timezone: { type: 'string', example: 'Asia/Tehran' },
        semantics: { type: 'object' },
      },
    }),
  })
  @ApiInvalidInput(PARSE_INT_PIPE_400)
  @ApiAuthRequired()
  @ApiErrorEnvelope(
    403,
    'The principal does not hold the built-in `super_admin` role.',
  )
  @ApiNotFound('No order has that id.')
  @Get('sales/:id')
  detail(@Param('id', ParseIntPipe) id: number, @Req() req: UserRequest) {
    return this.reportsService.detail(id, this.viewerOf(req));
  }

  /** The viewer is always derived from the verified token, never from the query. */
  private viewerOf(req: UserRequest): ReportViewer {
    return {
      userId: req.user.sub,
      roles: req.user.roles,
      branchId: req.user.branch,
    };
  }
}
