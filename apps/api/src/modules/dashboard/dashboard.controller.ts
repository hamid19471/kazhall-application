import { Controller, Get, Query, Req } from '@nestjs/common';
import { UserRequest } from 'src/common/interfaces/user-request.interface';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { DashboardQueryDto } from './dto/dashboard-query.dto';
import { Audiences } from 'src/modules/auth/decorators/audience.decorator';
import { RequirePermissions } from 'src/modules/auth/permissions/permission.decorator';
import { Roles } from 'src/modules/auth/decorators/role.decorator';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import {
  ACCESS_TOKEN_SECURITY_SCHEME,
  ApiAuthRequired,
  ApiErrorEnvelope,
  ApiInvalidInput,
  ApiPermissionForbidden,
  VALIDATION_PIPE_400,
  successEnvelopeSchema,
} from 'src/configs/swagger.config';

/**
 * ONE request for the whole opening screen.
 *
 * The alternative — the console calling `/reports/sales/summary`, the
 * reconciliation queue, the inventory list and a branch breakdown separately —
 * costs four round trips on first paint and grows a request per branch the
 * moment a "sales by branch" strip is added. Everything below is aggregated
 * server-side in six bounded queries, none of which scales with the number of
 * branches, cashiers or products.
 *
 * ===========================================================================
 * TWO ROUTES, TWO AUTHORISATION RULES, BECAUSE THEY ARE TWO KINDS OF DATA
 * ===========================================================================
 *
 *   GET /admin/dashboard/summary     `dashboard.read`  — counts, queues, stock
 *   GET /admin/dashboard/financial   `super_admin`     — today's money
 *
 * `dashboard.read` is a DELEGATABLE capability: a shift supervisor is meant to
 * hold it. The summary used to carry today's gross, refunds, voids and net, the
 * per-channel and per-BRANCH revenue split, the top variants by revenue, and
 * eight recent order amounts — so everything the owner named as restricted
 * ("sales totals, refunds, void totals, cashier performance, branch sales") was
 * reachable by anybody who could see the pending-order count.
 *
 * Splitting the CONTRACT rather than redacting fields inside one response is
 * deliberate: a route either serves financial data or it does not, and that is
 * visible in the route table instead of being a condition buried in a
 * projection. The financial route carries the same gate as
 * `ReportsController` — `@Roles(super_admin)` + `@Audiences('admin')` — so
 * there is ONE rule about financial data in this API, not two that can drift.
 *
 * The badge counts in the admin shell read the SUMMARY, so a delegated
 * administrator's console never fetches a money figure at all.
 */
@ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)
@ApiTags('Admin: dashboard')
@Controller('admin/dashboard')
@Audiences('admin')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @RequirePermissions('dashboard.read')
  @ApiOperation({
    summary: 'Today’s figures, the work queue and stock alerts',
    description:
      'Boundaries are the **Asia/Tehran calendar day** (`REPORT_TIMEZONE`), ' +
      'computed in PostgreSQL so the zone database is the same one the sales ' +
      'reports use.\n\n' +
      '### Every count names the timestamp that places it\n\n' +
      'Four different event dates are in play, and a figure that mixes two of ' +
      'them is not a figure a store manager can act on. `totals` therefore ' +
      'carries no field called `orderCount`; it carries:\n\n' +
      '| field | dated by |\n' +
      '| --- | --- |\n' +
      '| `ordersCreated`, `ordersCreatedPaid`, `ordersCreatedPending`, `ordersCreatedFailedOrCanceled` | `orders.created_at` |\n' +
      '| `ordersByRevenueDate`, `salesCount`, `nonSaleCount`, `pendingByRevenueDate`, `canceledOrFailedByRevenueDate`, `unitsSold`, `grossSales` | `COALESCE(orders."paidAt", orders."soldAt")` |\n' +
      '| `refundedCount`, `refundedTotal`, `unitsRefunded` | `orders."refundedAt"` |\n' +
      '| `voidedCount`, `voidedTotal`, `unitsVoided` | `orders."voidedAt"` |\n\n' +
      'An order created today and paid tomorrow is in `ordersCreated` TODAY ' +
      'and in `salesCount` TOMORROW. The two are not comparable and must never ' +
      'be added. `netSales = grossSales - refundedTotal - voidedTotal`, each ' +
      'term from the same day but from its OWN event date, so a September sale ' +
      'refunded in October reduces October.\n\n' +
      '`orders.created_at` is the baseline schema’s **naive** `TIMESTAMP` while ' +
      'the money-event columns are `timestamptz`, so it is compared ' +
      "`AT TIME ZONE 'UTC'` explicitly rather than in whatever the session " +
      'timezone happens to be.\n\n' +
      'Money figures use the SAME definition of a completed sale as ' +
      '`/reports/sales/summary` — they import it rather than restate it — so ' +
      'the two screens cannot disagree. `totals.ordersByRevenueDate` is that ' +
      'endpoint’s `totals.orderCount`, field for field.\n\n' +
      'Every money value is an integer-Rial STRING: these are `bigint` sums ' +
      'and must not be parsed as floats.\n\n' +
      'Cost of goods is not modelled anywhere in this system, so no figure ' +
      'derived from it is offered — it would be revenue with a misleading label.\n\n' +
      'The work-queue counts (`pipeline`) are deliberately NOT limited to ' +
      'today: an order that has waited three days for stock is more urgent ' +
      'than one that arrived an hour ago. `pipeline.pendingWebOrders` in ' +
      'particular counts every ONLINE order pending RIGHT NOW, of any age, and ' +
      'is never revenue.\n\n' +
      '`byChannel`, `byBranch` and `topVariants` are all on the REVENUE-DATE ' +
      'axis — they describe money taken today, not orders created today.\n\n' +
      'Stock is GLOBAL, not per branch — `inventory.scope` says so explicitly ' +
      'so the console can state it rather than implying per-branch figures.\n\n' +
      'The response repeats all of this in `semantics`, so a consumer never ' +
      'has to guess.',
  })
  @ApiOkResponse({
    description: 'The dashboard payload.',
    schema: successEnvelopeSchema({ data: { type: 'object' } }),
  })
  @ApiInvalidInput(VALIDATION_PIPE_400)
  @ApiAuthRequired()
  @ApiPermissionForbidden('dashboard.read')
  @Get('summary')
  async summary(@Query() query: DashboardQueryDto) {
    return { data: await this.dashboard.summary(query) };
  }

  /**
   * TODAY'S MONEY. The main administrator only.
   *
   * Same rule, same words, as `ReportsController`: the built-in `super_admin`
   * role on an `admin`-audience session. No capability code participates — a
   * delegated role cannot be given this by granting it something, which is the
   * whole point of gating it on the role.
   *
   * There is no query parameter: the period is always today, exactly as the
   * summary's is, and both read it from the same `businessDay()` so the two
   * halves can never describe different days. A range is what
   * `/reports/sales/summary` is for.
   */
  @Roles(UserRoleEnum.superAdmin)
  @ApiOperation({
    summary: 'Today’s sales money — main administrator only',
    description:
      'Gross, refunds, voids and net for the Asia/Tehran calendar day, plus ' +
      'the revenue split by channel and by BRANCH and the day’s best sellers ' +
      'by revenue.\n\n' +
      'Requires the built-in `super_admin` role on an `admin` session. This is ' +
      'the same rule `/reports/*` enforces and it is not delegable: no ' +
      'capability code grants it, so no custom role can hold it.\n\n' +
      'Every money value is an integer-Rial STRING — these are `bigint` sums ' +
      'and must not be parsed as floats. The figures agree with ' +
      '`/reports/sales/summary` for the same day, field for field: both import ' +
      'the same definition of a completed sale and subtract with the same ' +
      'BigInt helper.',
  })
  @ApiOkResponse({
    description: 'Today’s financial figures.',
    schema: successEnvelopeSchema({ data: { type: 'object' } }),
  })
  @ApiAuthRequired()
  @ApiErrorEnvelope(
    403,
    'The principal does not hold the built-in `super_admin` role.',
  )
  @Get('financial')
  async financial(@Req() req: UserRequest) {
    // The viewer, from the verified token, for the profit service's own
    // super_admin assertion (defence in depth, as on /reports/*).
    return {
      data: await this.dashboard.financialSummary({
        userId: req.user.sub,
        roles: req.user.roles,
        branchId: req.user.branch,
      }),
    };
  }
}
