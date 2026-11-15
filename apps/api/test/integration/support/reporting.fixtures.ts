/**
 * Fixtures for the CROSS-PERIOD reporting cases.
 *
 * `pos.fixtures.seedSale` plants a sale at a chosen `soldAt`, which was enough
 * while every report figure ranged on that one column. It is not enough now:
 * a sale, a refund and a void are three separate business events with three
 * separate dates, and the whole point of migration 0009 is that a September
 * sale refunded in October must be provable. These helpers wrap `seedSale` and
 * add the money-event columns rather than duplicating it.
 *
 * WHY THE COLUMNS ARE SET WITH AN UPDATE AND NOT ON THE INSERT: migration 0009
 * installs a BEFORE trigger that stamps `paidAt` when a row is inserted already
 * PAID. Going through `seedSale` therefore exercises that trigger exactly as
 * production does, and the UPDATE afterwards only moves the value to the
 * specific instant a date-boundary test needs. The trigger fires on
 * `UPDATE OF "status"` only, so it never fights this UPDATE.
 */
import { DataSource } from 'typeorm';
import { Order } from 'src/modules/orders/entities/order.entity';
import { OrderActionType } from 'src/modules/orders/entities/order-action.entity';
import { OrderStatusEnum } from 'src/modules/orders/enums/order-status.enum';
import { OrderChannel } from 'src/modules/orders/enums/order-channel.enum';
import { seedSale } from './pos.fixtures';

/** Exactly the statuses ReportsService treats as "the money was taken". */
const MONEY_TAKEN: OrderStatusEnum[] = [
  OrderStatusEnum.PAID,
  OrderStatusEnum.PROCESSING,
  OrderStatusEnum.SHIPPED,
  OrderStatusEnum.DELIVERED,
  OrderStatusEnum.REFUNDED,
];

export interface ReportingSaleInput {
  soldAt: Date;
  branchId: number;
  branchName: string;
  cashierUserId: number;
  cashierDisplay: string;
  total: number;
  quantity?: number;
  variantId?: number | null;
  status?: OrderStatusEnum;
  channel?: OrderChannel;
  productTitle?: string;
  /** Void event instant. */
  voidedAt?: Date | null;
  /**
   * Money-taken instant. Defaults to `soldAt` whenever the row represents money
   * that really was taken (an eligible status, or a void of a paid sale), and to
   * NULL otherwise -- which is what makes a PENDING online basket contribute
   * nothing without the test having to say so.
   */
  paidAt?: Date | null;
  /** Refund event instant. NULL models a refund whose date was never recorded. */
  refundedAt?: Date | null;
}

export async function seedReportingSale(
  ds: DataSource,
  input: ReportingSaleInput,
): Promise<Order> {
  const status = input.status ?? OrderStatusEnum.PAID;
  const order = await seedSale(ds, { ...input, status });

  const defaultPaidAt =
    MONEY_TAKEN.includes(status) || input.voidedAt ? input.soldAt : null;
  const paidAt = input.paidAt === undefined ? defaultPaidAt : input.paidAt;
  const refundedAt = input.refundedAt ?? null;

  await ds.query(
    `UPDATE orders SET "paidAt" = $2, "refundedAt" = $3 WHERE id = $1`,
    [order.id, paidAt, refundedAt],
  );

  order.paidAt = paidAt;
  order.refundedAt = refundedAt;
  return order;
}

/**
 * Simulates the ONE statement PaymentService runs when the gateway confirms:
 * pending -> paid. Deliberately raw SQL in the same shape, so the `paidAt`
 * trigger is exercised by the real transition rather than by a fixture that
 * writes the column directly.
 *
 * `at` is applied afterwards, and only where a test needs the payment to land
 * on a specific calendar day; leave it out to assert what the trigger does.
 */
export async function confirmOnlinePayment(
  ds: DataSource,
  orderId: number,
  at?: Date,
): Promise<void> {
  await ds.query(
    `UPDATE orders
        SET status = 'paid', paid_at = now(), "fulfillmentState" = 'pending'
      WHERE id = $1`,
    [orderId],
  );
  if (at) {
    await ds.query(`UPDATE orders SET "paidAt" = $2 WHERE id = $1`, [
      orderId,
      at,
    ]);
  }
}

/**
 * Appends a reversal to the audit trail with an explicit actor and instant.
 *
 * The actor here is the person who PROCESSED THE REVERSAL, which is a different
 * question from `orders."cashierUserId"` (who sold it) and must stay that way.
 */
export async function seedReversalAction(
  ds: DataSource,
  input: {
    orderId: number;
    action: OrderActionType;
    actorUserId: number;
    actorDisplay: string;
    at: Date;
    fromStatus?: string;
    toStatus?: string;
    reason?: string;
  },
): Promise<void> {
  await ds.query(
    `INSERT INTO order_actions
       ("orderId", action, "fromStatus", "toStatus", "actorUserId",
        "actorDisplaySnapshot", reason, "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.orderId,
      input.action,
      input.fromStatus ?? OrderStatusEnum.PAID,
      input.toStatus ?? null,
      input.actorUserId,
      input.actorDisplay,
      input.reason ?? null,
      input.at,
    ],
  );
}

export interface MoneyEvents {
  status: string;
  soldAt: Date;
  paidAt: Date | null;
  voidedAt: Date | null;
  refundedAt: Date | null;
}

/** The money-event columns of one order, as the database actually holds them. */
export async function moneyEventsOf(
  ds: DataSource,
  orderId: number,
): Promise<MoneyEvents> {
  const rows: MoneyEvents[] = await ds.query(
    `SELECT status::text AS status, "soldAt", "paidAt", "voidedAt", "refundedAt"
       FROM orders WHERE id = $1`,
    [orderId],
  );
  return rows[0];
}
