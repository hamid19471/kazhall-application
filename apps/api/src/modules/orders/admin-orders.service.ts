import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { OrderMessages } from 'src/common/constants/order.messages';
import { resolveReportTimezone } from './business-time';
import {
  ADMIN_ORDER_RECONCILIATION_NONE,
  AdminOrderDateField,
  AdminOrderQueryDto,
} from './dto/admin-order-query.dto';
import { OrderAction } from './entities/order-action.entity';
import { Order } from './entities/order.entity';
import {
  ADMIN_ORDER_PAYMENT_STATE_SQL,
  AdminOrderActionListView,
  AdminOrderDetailView,
  AdminOrderListView,
  AdminOrderRawItem,
  AdminOrderRawPayment,
  AdminOrderRawRow,
  AdminOrderRowView,
  toAdminOrderActionView,
  toAdminOrderDetailView,
  toAdminOrderRowView,
} from './views/admin-order.view';

/**
 * Positional bind-parameter accumulator.
 *
 * The same device `ReportsService` uses, and for the same reason: the predicate
 * is assembled from a dozen optional fragments that each need their own
 * placeholder, and tracking `$n` by hand at the call sites is how two fragments
 * end up sharing an offset. It is NOT exported from there, and reports is a
 * module this work may not edit, so it is restated here rather than reached
 * into. Nothing is ever interpolated: every value goes through `bind`.
 */
class SqlParams {
  readonly values: unknown[] = [];

  bind(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/**
 * WHICH COLUMN `from`/`to` RANGE ON, per `dateField`.
 *
 * `soldAt` and `paidAt` are `timestamptz` and compare directly against the
 * boundary instants PostgreSQL computes below.
 *
 * `created_at` is NOT: it is the baseline schema's naive `TIMESTAMP`, written by
 * the column default `now()`. Comparing a naive timestamp against a
 * `timestamptz` makes PostgreSQL silently reinterpret it in the SESSION's
 * timezone, which is a setting rather than a fact, so the same query could
 * answer differently on two connections. It is pinned to UTC here — which is
 * what `now()` stores under the deployed server's `TimeZone` — so the
 * comparison is at least stated rather than inherited. `soldAt` remains the
 * axis to range on for anything that matters; `created` is for support.
 */
const DATE_FIELD_SQL: Readonly<Record<AdminOrderDateField, string>> =
  Object.freeze({
    [AdminOrderDateField.SOLD]: 'o."soldAt"',
    [AdminOrderDateField.PAID]: 'o."paidAt"',
    [AdminOrderDateField.CREATED]: `(o.created_at AT TIME ZONE 'UTC')`,
  });

/**
 * The derived payment state, as ONE lateral aggregate over `payment`.
 *
 * A lateral rather than a correlated scalar subquery per column, so the five
 * `bool_or`s are evaluated in a single pass over this order's receipts, and a
 * lateral rather than a per-row query in Node, so a page of 100 orders is one
 * round trip and not 101.
 */
const PAYMENT_STATE_LATERAL = `
      LEFT JOIN LATERAL (
        SELECT ${ADMIN_ORDER_PAYMENT_STATE_SQL} AS state
          FROM payment p
         WHERE p."orderId" = o.id
      ) pay ON TRUE`;

/** Line counts, same single-pass argument as the payment lateral. */
const LINE_TOTALS_LATERAL = `
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS item_count,
               COALESCE(SUM(oi.quantity), 0)::int AS unit_count
          FROM order_items oi
         WHERE oi."orderId" = o.id
      ) li ON TRUE`;

/**
 * MINIMAL IDENTITY FOR THE LIST, and nothing more.
 *
 * An operator scanning an order table needs to recognise a row; they do not
 * need the customer's address, postal code or telephone number, and the old
 * handler shipped all three by loading the `user` and `address` relations into
 * a list response.
 *
 * The name is preferred where one is recorded. The fallback is a MASKED
 * telephone number, and the mask is applied to whatever string is chosen rather
 * than only to the `mobile` columns: `users.username` is the storefront login
 * identity and for an OTP-registered customer it IS their mobile number, so
 * masking only the column named `mobile` would have leaked exactly the value it
 * was written to protect. The detail endpoint returns the unmasked number,
 * which an operator has to open one order at a time to see.
 */
const CUSTOMER_IDENTITY_LATERAL = `
      LEFT JOIN LATERAL (
        SELECT COALESCE(NULLIF(c.name, ''), NULLIF(u.username, ''),
                        c.mobile, u.mobile) AS raw
      ) ident ON TRUE`;

const CUSTOMER_DISPLAY_SQL = `CASE
        WHEN ident.raw IS NULL THEN NULL
        WHEN ident.raw ~ '^[0-9]{7,}$' THEN '***' || RIGHT(ident.raw, 4)
        ELSE ident.raw
      END`;

const ROW_SELECT = `
      SELECT o.id,
             o."orderNumber",
             o.channel,
             o.status,
             o."fulfillmentState",
             pay.state AS "paymentState",
             o."reconciliationState",
             o."branchId",
             o."branchNameSnapshot",
             o."cashierUserId",
             o."cashierDisplaySnapshot",
             o."customerId",
             ${CUSTOMER_DISPLAY_SQL} AS "customerDisplay",
             o."userId",
             li.item_count AS "itemCount",
             li.unit_count AS "unitCount",
             o.subtotal::text AS "subtotal",
             o.total_price::text AS "totalPrice",
             o."soldAt",
             o."paidAt",
             o."voidedAt",
             o."refundedAt",
             o.created_at AS "createdAt"
        FROM orders o${PAYMENT_STATE_LATERAL}${LINE_TOTALS_LATERAL}
        LEFT JOIN customers c ON c.id = o."customerId"
        LEFT JOIN users u ON u.id = o."userId"${CUSTOMER_IDENTITY_LATERAL}`;

/**
 * ===========================================================================
 * THE ADMIN CONSOLE'S READS OF `orders`
 * ===========================================================================
 *
 * Separate from `OrdersService` on purpose. That service owns the WRITES — the
 * checkout transaction, the POS sale, the reversal and the status machine — and
 * every one of its reads exists to support one of them. These are projections
 * for a screen: they return views rather than entities, they are bounded, and
 * they must never acquire a write path. Keeping them in their own class is what
 * makes that reviewable.
 *
 * Nothing here loads the `address` relation or `items.product`. The delivery
 * address of an order is the frozen `addressSnapshot`, and every line fact
 * comes from the immutable `order_items.*Snapshot` columns.
 */
@Injectable()
export class AdminOrdersService {
  private readonly timezone: string;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    private readonly configService: ConfigService,
  ) {
    this.timezone = resolveReportTimezone(
      this.configService.get<string>('REPORT_TIMEZONE'),
    );
  }

  /**
   * One page of orders, newest sale first.
   *
   * ORDERING IS DETERMINISTIC. `soldAt DESC, id DESC`: timestamps collide — a
   * POS burst stamps several sales inside the same millisecond — so without the
   * unique tiebreaker two pages of the same result set can repeat a row and
   * skip another, which on an order list means an operator working a queue
   * silently misses one.
   *
   * `NULLS LAST` USED TO BE APPENDED HERE AND HAS BEEN REMOVED. It was written
   * when this class believed `soldAt` was nullable; the column has been
   * `NOT NULL DEFAULT now()` since migration 0003, so the clause sorted an
   * empty set and the comment justifying it described rows that cannot exist.
   * It was not free, either: `DESC NULLS LAST` is not the reverse of a plain
   * btree's `ASC NULLS LAST`, so it rules out a backward index scan over
   * `idx_orders_sold_at` (created by migration 0029) that plain `DESC` leaves
   * available to the planner.
   */
  async list(query: AdminOrderQueryDto): Promise<AdminOrderListView> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const p = new SqlParams();
    const where = this.buildFilters(query, p);
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    /**
     * The count joins ONLY what it filters on. The line-count and identity
     * laterals feed columns nobody counts, and running them for every candidate
     * row is work the count can never use.
     */
    const countJoins = query.paymentState ? PAYMENT_STATE_LATERAL : '';
    const countRows = await this.dataSource.query<Array<{ total: number }>>(
      `SELECT COUNT(*)::int AS total FROM orders o${countJoins} ${whereSql}`,
      [...p.values],
    );
    const total = Number(countRows[0]?.total ?? 0);

    const rows = await this.dataSource.query<AdminOrderRawRow[]>(
      `${ROW_SELECT}
        ${whereSql}
       ORDER BY o."soldAt" DESC, o.id DESC
       LIMIT ${p.bind(limit)} OFFSET ${p.bind((page - 1) * limit)}`,
      p.values,
    );

    return {
      data: rows.map(toAdminOrderRowView),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 0,
    };
  }

  /**
   * The list row for ONE order, so that a mutation can answer with the same
   * shape the list renders — including the derived `paymentState`, which is a
   * fact about the `payment` table and cannot be read off the order entity a
   * mutation happens to return.
   */
  async findRow(id: number): Promise<AdminOrderRowView> {
    return toAdminOrderRowView(await this.findRawRow(id));
  }

  /** One order, with its lines, receipts and what the caller may do to it. */
  async findDetail(
    id: number,
    permissions: readonly string[],
  ): Promise<AdminOrderDetailView> {
    const row = await this.findRawRow(id);

    /**
     * `customer` and `user` only. `items` and `payments` are read below as
     * PROJECTIONS rather than relations, because their money columns must reach
     * the wire as text: the entities carry `bigIntTransformer`, which converts
     * `bigint` to a JS `number` on the way in, and a view that then stringifies
     * that number is reporting what survived the round trip rather than what the
     * database holds. `address` is deliberately absent — see the view header.
     */
    const order = await this.orderRepository.findOne({
      where: { id },
      relations: { customer: true, user: true },
    });
    if (!order) throw new NotFoundException(OrderMessages.ORDER_NOT_FOUND);

    const items = await this.dataSource.query<AdminOrderRawItem[]>(
      `SELECT oi.id,
              oi."productId",
              oi."variantId",
              oi."productTitleSnapshot",
              oi."variantSkuSnapshot",
              oi."attributesSnapshot",
              oi.quantity,
              oi.unit_price::text AS "unitPrice",
              oi.total_price::text AS "totalPrice"
         FROM order_items oi
        WHERE oi."orderId" = $1
        ORDER BY oi.id ASC`,
      [id],
    );

    /**
     * `track_id` IS NOT SELECTED. It is the gateway SESSION identifier and the
     * entire credential `POST /payment/verify` accepts, so it is excluded here
     * exactly as `payment/dto/reconciliation.view.ts` excludes it — a column
     * list rather than a `delete`, so a future migration cannot add it back by
     * accident. The re-verification scheduler's columns are absent for the same
     * reason: they are worker bookkeeping, not facts about the money.
     */
    const payments = await this.dataSource.query<AdminOrderRawPayment[]>(
      `SELECT pm.id,
              pm.status,
              pm.amount::text AS "amount",
              pm.gateway_amount::text AS "gatewayAmount",
              pm.ref_number AS "refNumber",
              pm.paid_at AS "paidAt",
              pm.requires_reconciliation AS "requiresReconciliation",
              pm.reconciliation_reason AS "reconciliationReason",
              pm.reconciled_at AS "reconciledAt",
              pm.created_at AS "createdAt"
         FROM payment pm
        WHERE pm."orderId" = $1
        ORDER BY pm.id ASC`,
      [id],
    );

    return toAdminOrderDetailView({ row, order, items, payments, permissions });
  }

  /**
   * One page of an order's append-only administrative history, OLDEST FIRST.
   *
   * Oldest first is kept from the unpaginated version it replaces: this is a
   * narrative — what happened to the order, in the order it happened — and
   * reversing it to match the order list would make page 1 the end of the story.
   */
  async findActions(
    orderId: number,
    page: number,
    limit: number,
  ): Promise<AdminOrderActionListView> {
    const [data, total] = await this.dataSource
      .getRepository(OrderAction)
      .findAndCount({
        where: { orderId },
        // `createdAt` collides for actions written in the same transaction, so
        // the unique tiebreaker is what keeps paging stable.
        order: { createdAt: 'ASC', id: 'ASC' },
        skip: (page - 1) * limit,
        take: limit,
      });

    return {
      data: data.map(toAdminOrderActionView),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 0,
    };
  }

  // =====================================================================
  // Internals
  // =====================================================================

  private async findRawRow(id: number): Promise<AdminOrderRawRow> {
    const rows = await this.dataSource.query<AdminOrderRawRow[]>(
      `${ROW_SELECT} WHERE o.id = $1 LIMIT 1`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new NotFoundException(OrderMessages.ORDER_NOT_FOUND);
    return row;
  }

  private buildFilters(query: AdminOrderQueryDto, p: SqlParams): string[] {
    const where: string[] = [];

    if (query.search) {
      /**
       * An operator pastes whatever identifier they are holding. A receipt
       * carries the order NUMBER; a log line, a support ticket or a URL carries
       * the numeric id. Matching both from one box means they never have to
       * know which of the two they have.
       *
       * The LIKE metacharacters are escaped: an unescaped `%` would turn a
       * search for a literal percent sign into "match everything", and `_`
       * would quietly widen an otherwise exact order-number search.
       */
      const like = `%${escapeLike(query.search)}%`;
      const alternatives = [`o."orderNumber" ILIKE ${p.bind(like)}`];
      // Bounded to what an `int4` column can hold: a longer digit string is a
      // mistyped order number, and offering it to `o.id` is a 22003 rather than
      // an empty result.
      if (/^[0-9]{1,9}$/.test(query.search)) {
        alternatives.push(`o.id = ${p.bind(Number(query.search))}`);
      }
      where.push(`(${alternatives.join(' OR ')})`);
    }

    if (query.channel) where.push(`o.channel = ${p.bind(query.channel)}`);
    if (query.status) where.push(`o.status = ${p.bind(query.status)}`);
    if (query.fulfillmentState) {
      where.push(`o."fulfillmentState" = ${p.bind(query.fulfillmentState)}`);
    }
    if (query.paymentState) {
      where.push(`pay.state = ${p.bind(query.paymentState)}`);
    }
    if (query.branchId !== undefined) {
      where.push(`o."branchId" = ${p.bind(query.branchId)}`);
    }
    if (query.cashierUserId !== undefined) {
      where.push(`o."cashierUserId" = ${p.bind(query.cashierUserId)}`);
    }
    if (query.customerId !== undefined) {
      where.push(`o."customerId" = ${p.bind(query.customerId)}`);
    }
    if (query.userId !== undefined) {
      where.push(`o."userId" = ${p.bind(query.userId)}`);
    }
    if (query.reconciliationState) {
      where.push(
        query.reconciliationState === ADMIN_ORDER_RECONCILIATION_NONE
          ? `o."reconciliationState" IS NULL`
          : `o."reconciliationState" = ${p.bind(query.reconciliationState)}`,
      );
    }

    const range = this.rangePredicate(query, p);
    if (range) where.push(range);

    return where;
  }

  /**
   * A HALF-OPEN WINDOW OVER INCLUSIVE LOCAL CALENDAR DAYS, computed in
   * PostgreSQL.
   *
   *   <axis> >= CAST(CAST(:from AS date) AS timestamp) AT TIME ZONE :tz
   *   <axis> <  CAST(CAST(:to AS date) + INTERVAL '1 day' AS timestamp) AT TIME ZONE :tz
   *
   * This is `ReportsService.rangePredicate` verbatim, down to the parameter
   * shape, so that "orders sold on the 9th" on this screen and "sales on the
   * 9th" on the reports screen cannot disagree about where the day starts.
   *
   * THE CONVERSION IS THE DATABASE'S, NOT NODE'S. `<naive timestamp> AT TIME
   * ZONE '<IANA zone>'` resolves the offset with the zone's own rules FOR THAT
   * DATE, so the boundary stays correct if Iran reinstates DST and the same code
   * serves any other `REPORT_TIMEZONE`. Computing it in Node would bake in the
   * API process's local clock — a machine setting — as a business rule.
   *
   * The end bound is half-open so the last local day is fully included without a
   * `23:59:59.999` fudge that drops the final millisecond of every range.
   *
   * ONE BOUND MEANS ONE DAY: `from` alone (or `to` alone) selects that single
   * local day, which is what an operator typing one date means.
   */
  private rangePredicate(
    query: AdminOrderQueryDto,
    p: SqlParams,
  ): string | null {
    if (!query.from && !query.to) return null;
    const from = query.from ?? query.to!;
    const to = query.to ?? query.from!;
    const axis = DATE_FIELD_SQL[query.dateField ?? AdminOrderDateField.SOLD];
    const tz = p.bind(this.timezone);
    return (
      `${axis} >= CAST(CAST(${p.bind(from)} AS date) AS timestamp) AT TIME ZONE ${tz}` +
      ` AND ${axis} < CAST(CAST(${p.bind(to)} AS date) + INTERVAL '1 day' AS timestamp) AT TIME ZONE ${tz}`
    );
  }
}

/** Escapes the LIKE metacharacters so a search term matches itself. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
