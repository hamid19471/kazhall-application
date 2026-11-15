import { User } from 'src/modules/user/entities/user.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { OrderStatusEnum } from '../enums/order-status.enum';
import { Address } from 'src/modules/address/entities/address.entity';
import { OrderItems } from './order-item.entity';
import { Payment } from 'src/modules/payment/entities/payment.entity';
import { OrderChannel } from '../enums/order-channel.enum';
import { Branch } from 'src/modules/branch/entities/branch.entity';
import { Customer } from 'src/modules/customer/entities/customer.entity';
import { PaymentMethodEnum } from '../enums/payment-method.enum';
import { FulfillmentStateEnum } from '../enums/fulfillment-state.enum';
import { OrderReconciliationState } from '../enums/reconciliation-state.enum';
import { bigIntTransformer } from 'src/common/transformers/bigint.transformer';
import { ORDER_NUMBER_MAX_LENGTH } from '../order-number';

/**
 * The delivery address exactly as it read when the order was placed.
 * `capturedAt` is null (and `backfilled` true) on rows filled in by migration
 * 0015 from the address as it stood at migration time — which is not a claim
 * about what it said at order time.
 */
export interface OrderAddressSnapshot {
  addressId: number;
  province: string;
  city: string;
  address: string;
  postalCode: string;
  receiverMobile: string;
  capturedAt: string | null;
  backfilled?: boolean;
}

@Entity('orders')
// The reporting access paths from migration 0003, plus the bare `soldAt` index
// added by 0029. NAMES ARE `idx_orders_*`, NOT `idx_order_*`: these decorators
// previously said `idx_order_branch_sold_at` / `idx_order_cashier_sold_at`,
// which match nothing in any migration, so `schema:log` proposed dropping the
// real indexes and rebuilding them under the entity's names on every single
// run — a diff that looks like pending work but is pure renaming, and that
// buries the genuine drift underneath it. The migration is deployed and the
// entity is not, so the entity moved.
@Index('idx_orders_sold_at', ['soldAt'])
@Index('idx_orders_branch_sold_at', ['branchId', 'soldAt'])
@Index('idx_orders_cashier_sold_at', ['cashierUserId', 'soldAt'])
@Index('idx_orders_status_sold_at', ['status', 'soldAt'])
// Mirrors migration 0011 exactly, so entity metadata and the migrated schema
// cannot drift apart.
@Index('idx_orders_fulfillment_due', ['fulfillmentNextAttemptAt', 'id'], {
  where: `status = 'paid' AND "fulfillmentState" IN ('pending', 'awaiting_stock')`,
})
export class Order {
  @PrimaryGeneratedColumn()
  id: number;

  /**
   * Human-facing sale number. Deliberately NOT the primary key: it is printed
   * on receipts and quoted by customers, so it must stay stable and readable
   * even if the surrogate key strategy ever changes.
   * Format: `<POS|WEB>-<yyyyMMdd business-local>-<zero padded id>`.
   *
   * THE LENGTH COMES FROM `ORDER_NUMBER_MAX_LENGTH`, not from a literal.
   * Migration 0003 created this column as UNBOUNDED `character varying` while
   * this declaration said `varchar(40)`; nothing failed, because no generated
   * value has ever approached 40 characters, so the two simply disagreed and
   * `typeorm schema:log` proposed the same ALTER for ever. Migration 0026
   * aligns the database; sharing the constant with the generator and the query
   * DTO is what stops them drifting again.
   */
  @Column({
    type: 'varchar',
    length: ORDER_NUMBER_MAX_LENGTH,
    unique: true,
    nullable: true,
  })
  orderNumber: string | null;

  @Column({ type: 'enum', enum: OrderChannel })
  channel: OrderChannel;

  @ManyToOne(() => User, (user) => user.orders, { nullable: true })
  user: User | null;

  @Column({ nullable: true })
  userId: number | null;

  /**
   * WHO SOLD IT. Written once, from the authenticated principal only, and
   * never overwritten -- a later void/return/status change is appended to
   * `order_actions` with its own actor instead.
   *
   * ON DELETE RESTRICT: a staff member who has sales cannot be hard-deleted.
   * Retiring staff is done with `users.deactivatedAt`.
   */
  @Column({ type: 'int', nullable: true })
  cashierUserId: number | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'cashierUserId' })
  cashierUser: User | null;

  /** Survives renaming or deactivating the cashier. */
  @Column({ type: 'varchar', nullable: true })
  cashierDisplaySnapshot: string | null;

  /** Survives renaming the branch. */
  @Column({ type: 'varchar', nullable: true })
  branchNameSnapshot: string | null;

  @ManyToOne(() => Branch, { nullable: true })
  branch: Branch | null;

  @Column({ nullable: true })
  branchId: number | null;

  @ManyToOne(() => Customer, (customer) => customer.orders, {
    nullable: true,
  })
  customer: Customer | null;

  @Column({ nullable: true })
  customerId: number | null;

  @Column({
    type: 'enum',
    enum: OrderStatusEnum,
    default: OrderStatusEnum.PENDING,
  })
  status: OrderStatusEnum;

  /** Commercial state of the goods, independent of the money state. */
  @Column({
    type: 'enum',
    enum: FulfillmentStateEnum,
    default: FulfillmentStateEnum.NOT_REQUIRED,
  })
  fulfillmentState: FulfillmentStateEnum;

  @Column({ type: 'enum', enum: PaymentMethodEnum, nullable: true })
  paymentMethod: PaymentMethodEnum | null;

  // -------------------------------------------------------------------------
  // Fulfilment retry bookkeeping (migration 0011)
  //
  // WHY IT IS ON THE ORDER. The recovery worker used to select
  // `... ORDER BY id ASC LIMIT $batch` with no notion of "tried recently", so a
  // handful of permanently unfulfillable orders held the lowest ids and filled
  // every batch forever -- a later, fulfillable order was never reached at all.
  // These columns turn that scan into a due-time queue that rotates.
  //
  // `fulfillmentNextAttemptAt IS NULL` MEANS "DUE NOW", which is deliberately
  // the state of every pre-0011 row and of every freshly paid order, so nothing
  // that was recoverable before becomes invisible after.
  // -------------------------------------------------------------------------

  @Column({ type: 'int', default: 0 })
  fulfillmentAttempts: number;

  @Column({ type: 'timestamptz', nullable: true })
  fulfillmentLastAttemptAt: Date | null;

  /** NULL = due now. Otherwise the capped-backoff instant this order is next eligible. */
  @Column({ type: 'timestamptz', nullable: true })
  fulfillmentNextAttemptAt: Date | null;

  /** Last failure reason, for the operator looking at an overdue order. */
  @Column({ type: 'varchar', nullable: true })
  fulfillmentLastError: string | null;

  // -------------------------------------------------------------------------
  // Manual reconciliation case lifecycle (migration 0018, owner decision D-2)
  //
  // A case is an ORDER that needs a human — money arrived that could not be
  // applied, or the order is PAID with its goods never allocated. See
  // `OrderReconciliationState` for the full lifecycle and for why it lives here
  // rather than on `payment`.
  //
  // NEITHER COLUMN IS EXPOSED TO THE CUSTOMER. `customer-order.view.ts` is an
  // allow-list and projects only a derived, customer-safe `reviewState`.
  // -------------------------------------------------------------------------

  /**
   * NULL = never touched. Otherwise one of `OrderReconciliationState`, enforced
   * by CHECK `ck_orders_reconciliation_state`.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  reconciliationState: OrderReconciliationState | null;

  /**
   * When the case was closed. CHECK `ck_orders_reconciliation_resolved` allows
   * this to be non-NULL only for `refund_confirmed` / `resolved`, so "resolved"
   * cannot be claimed without naming which resolution it was.
   */
  @Column({ type: 'timestamptz', nullable: true })
  reconciliationResolvedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  paid_at: Date | null;

  /**
   * The authoritative reporting time axis: the instant the sale was rung up.
   * `timestamptz` on purpose -- report ranges are inclusive *local calendar
   * days* in REPORT_TIMEZONE converted to UTC instants, which is only
   * expressible against a zone-aware column.
   *
   * NOT NULL, WITH NO `nullable` AND NO `default` RESTATED HERE. Migration 0003
   * made this column `NOT NULL DEFAULT now()` and wrote down why: a nullable
   * `soldAt` fails silently, because a write path that forgets it drops the
   * order out of every date-ranged report in ARCHITECTURE section 5 with no
   * error anywhere. This declaration said `nullable: true` anyway, which made
   * `schema:log` propose `DROP NOT NULL` + `DROP DEFAULT` for ever -- i.e. it
   * proposed reinstating exactly the failure mode 0003 removed.
   *
   * The DEFAULT is deliberately NOT mirrored as `default: () => 'now()'`:
   * 0003's coordination note requires that this property is either set to a
   * real Date or left `undefined`, never written as an explicit `null`
   * (TypeORM omits an undefined property and lets the default apply, but sends
   * a literal NULL for a null one, which the constraint rejects). Typing it
   * `Date` rather than `Date | null` is what makes that a compile error instead
   * of a runtime 23502.
   *
   * MEASURED COST OF THAT CHOICE, so the next reader does not rediscover it:
   * leaving the default off the entity keeps `schema:log` proposing
   * `ALTER COLUMN "soldAt" DROP DEFAULT`, and because TypeORM rebuilds every
   * index that touches a column it believes is changing, that single line also
   * drags `idx_orders_branch_sold_at`, `idx_orders_cashier_sold_at` and
   * `idx_orders_status_sold_at` through a pointless drop-and-recreate in the
   * diff. Adding `default: () => 'now()'` here was measured to take the whole
   * diff from 46 statements to 39 and to silence all of it -- at the price of
   * implying the application relies on the default, which 0003 says it must
   * not.
   */
  @Column({ type: 'timestamptz' })
  soldAt: Date;

  /**
   * MONEY TAKEN. The zone-aware instant the customer's money actually arrived,
   * and the axis every revenue figure is attributed to (migration 0009).
   *
   * NOT the same thing as `soldAt` for an ONLINE order: `soldAt` is stamped when
   * the basket is checked out and the order is still PENDING, so attributing
   * revenue to it books an abandoned basket's would-be money on the day the
   * customer clicked "pay" rather than the day (possibly the month) the gateway
   * confirmed. For a POS sale the two are the same instant by construction.
   *
   * NOT the same thing as `paid_at` either: that column is `timestamp` WITHOUT
   * time zone and its two writers disagree about which clock it holds, so it
   * cannot be converted to a local calendar day. See migration 0009.
   *
   * NULL means "money was never taken", or (for pre-0009 rows) "taken, but the
   * instant is unrecoverable" — reports fall back to `soldAt` in that case.
   */
  @Column({ type: 'timestamptz', nullable: true })
  paidAt: Date | null;

  /** Set when the sale is reversed. The original cashier is left untouched. */
  @Column({ type: 'timestamptz', nullable: true })
  voidedAt: Date | null;

  /**
   * MONEY GIVEN BACK. The zone-aware instant the refund was recorded.
   *
   * A refund is a SECOND business event with its OWN date: an October return of
   * a September sale reduces October, not September. That rule was documented
   * long before it was true — every total used to range on `soldAt` — and it is
   * only expressible with a separate column.
   *
   * NULL on a REFUNDED order means the refund date is genuinely unknown (no
   * `order_actions` row to backfill from). Such rows are reported separately by
   * ReportsService instead of being dated by guesswork.
   */
  @Column({ type: 'timestamptz', nullable: true })
  refundedAt: Date | null;

  @ManyToOne(() => Address, (address) => address.orders, { nullable: true })
  address: Address | null;

  @Column({ nullable: true })
  addressId: number | null;

  /**
   * WHERE THE GOODS WERE ACTUALLY SENT, frozen at checkout (migration 0015).
   *
   * `addressId` above is provenance only. It points at a LIVE `addresses` row
   * that the customer can edit or delete at any time, so reading the delivery
   * address through it meant a past order's address changed whenever the
   * customer updated their address book. This snapshot is the authoritative
   * record for fulfilment and for any dispute.
   *
   * NULL only on pre-0015 orders whose source address had already been deleted.
   */
  @Column({ type: 'jsonb', nullable: true })
  addressSnapshot: OrderAddressSnapshot | null;

  /** Sum of the line totals, before order-level discounts. Integer Rial. */
  @Column({ type: 'bigint', default: 0, transformer: bigIntTransformer })
  subtotal: number;

  /** What the customer actually paid. Integer Rial. */
  @Column({ type: 'bigint', default: 0, transformer: bigIntTransformer })
  total_price: number;

  @Column({ type: 'varchar', nullable: true })
  discount_code?: string | null;

  @OneToMany(() => OrderItems, (orderitem) => orderitem.order)
  items: OrderItems[];

  @OneToMany(() => Payment, (payment) => payment.order)
  payments: Payment[];

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
