import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { PaymentReconciliationReason } from 'src/modules/payment/enums/payment-status-enum';
import { OrderAction } from '../entities/order-action.entity';
import { Order, OrderAddressSnapshot } from '../entities/order.entity';
import {
  canAdvancePastPaid,
  FulfillmentStateEnum,
} from '../enums/fulfillment-state.enum';
import { OrderChannel } from '../enums/order-channel.enum';
import { OrderStatusEnum } from '../enums/order-status.enum';
import { OrderReconciliationState } from '../enums/reconciliation-state.enum';
import {
  allowedNextOrderStatuses,
  isPostPaymentOperationalStatus,
} from '../order-status.machine';

/**
 * ===========================================================================
 * THE ADMINISTRATOR'S VIEW OF AN ORDER — BOUNDED, ALLOW-LIST, NO ENTITIES
 * ===========================================================================
 *
 * WHY THIS FILE EXISTS. `GET /orders` was
 * `orderRepository.find({ where: {}, relations: { user, address, cashierUser,
 * items: { product } } })` — every order that has ever been placed, each one
 * fully hydrated with four relations, in one unpaginated response. Two separate
 * problems, and both are fixed here rather than in the controller:
 *
 *   1. UNBOUNDED. The response grew with the table. There was no page, no
 *      filter and no projection, so the only way to answer "which orders were
 *      sold in Sanandaj yesterday" was to download every order ever sold.
 *   2. RAW ENTITIES. `JSON.stringify` on an `Order` publishes every column the
 *      table has ever grown, `fulfillmentLastError` (raw internal failure text)
 *      included, and the `user` / `address` relations published whole other
 *      entities — a customer's postal code and telephone number landed in a
 *      LIST that an operator opens to scan order numbers.
 *
 * As in `dto/customer-order.view.ts`, the property that matters is not the
 * current field list but that the mapping is an ALLOW-LIST built by pure
 * functions: a column added to `orders` by a future migration cannot appear in
 * an admin response until somebody comes here and names it.
 *
 * EVERY MONETARY FIELD IS A STRING, exactly as `payment/dto/reconciliation.view.ts`
 * does it. These are `bigint` INTEGER RIAL columns; they are cast with `::text`
 * in SQL and never converted back, so what an operator reads is exactly what the
 * database holds rather than whatever survived a round trip through a JS
 * `number`.
 *
 * WHAT IS DELIBERATELY EXCLUDED, and why:
 *
 *   payment.track_id            the gateway SESSION identifier and the entire
 *                               credential `POST /payment/verify` accepts. The
 *                               reconciliation view excludes it for that reason
 *                               and this view matches it exactly.
 *   payment.reverify_attempts   re-verification scheduler bookkeeping
 *   payment.last_reverified_at  idem
 *   payment.next_reverify_at    idem — the due-time queue key
 *   payment.gateway_amount_raw  evidence for the reconciliation operator, not a
 *                               fact about the order; it is served by
 *                               `/payment/admin/reconciliation`.
 *   orders.address (relation)   a LIVE, editable, deletable row. The delivery
 *                               address of an order is `addressSnapshot`; see
 *                               `AdminOrderDetailView.address`.
 *   items.product (relation)    the live catalogue row. Every line fact comes
 *                               from the immutable `order_items.*Snapshot`
 *                               columns, so a later rename or re-price cannot
 *                               rewrite a historical order.
 *   the customer's address, postal code and full telephone number
 *                               NOT IN THE LIST. See `customerDisplay`.
 */

// ===========================================================================
// Derived payment state
// ===========================================================================

/**
 * THE MONEY STATE OF AN ORDER, DERIVED FROM ITS RECEIPTS.
 *
 * `orders.status` is the commercial state and is written by the order
 * lifecycle; this is a different question — what did the `payment` ledger
 * actually record for this order — and the two can legitimately disagree (a
 * `pending` order with a `failed` attempt behind it, a `canceled` order whose
 * money is still held).
 *
 * PRECEDENCE. An order may have several receipts, so one has to win. In order,
 * first match wins:
 *
 *   1. `success`   at least one receipt settled the order. The partial unique
 *                  index `uq_payment_one_success_per_order` guarantees there is
 *                  at most one, so this is the strongest and least ambiguous
 *                  fact available and it outranks everything else.
 *   2. `refunded`  no settling receipt survives, but money was reported back.
 *                  Ranked above `pending` because a refund is a completed
 *                  financial event and an open attempt is not.
 *   3. `pending`   an attempt is open and nothing has concluded.
 *   4. `failed`    every receipt concluded, none of them favourably.
 *   5. `none`      no receipt in any of the four states above.
 *
 * `confirmed_unapplied` IS NOT MAPPED. It is real money that deliberately
 * settled nothing, and calling it any of the five would be a false statement:
 * `success` claims the order is paid, `pending` claims nothing arrived. An
 * order whose only receipt is `confirmed_unapplied` therefore reads `none`
 * here, and the queue that owns it — `GET /payment/admin/reconciliation` — is
 * the screen that states it truthfully. This field is a coarse list filter, not
 * a reconciliation report, and it must not be read as one.
 */
export enum AdminOrderPaymentState {
  SUCCESS = 'success',
  REFUNDED = 'refunded',
  PENDING = 'pending',
  FAILED = 'failed',
  NONE = 'none',
}

/**
 * The precedence above, as ONE aggregate over `payment`.
 *
 * Written as a single lateral rather than a per-row lookup on purpose: the list
 * is a page of up to 100 orders and a per-order query would be exactly the N+1
 * the conventions forbid. `bool_or` over an empty receipt set is NULL for every
 * branch, so an order with no payment row falls through to `'none'` without a
 * special case.
 */
export const ADMIN_ORDER_PAYMENT_STATE_SQL = `CASE
        WHEN bool_or(p.status = 'success')  THEN 'success'
        WHEN bool_or(p.status = 'refunded') THEN 'refunded'
        WHEN bool_or(p.status = 'pending')  THEN 'pending'
        WHEN bool_or(p.status = 'failed')   THEN 'failed'
        ELSE 'none'
      END`;

// ===========================================================================
// Raw rows, as the projection SQL returns them
// ===========================================================================

/**
 * One row of the admin list exactly as PostgreSQL hands it back.
 *
 * Money arrives as `string` because the SQL casts it with `::text`; timestamps
 * arrive as `Date` because node-postgres parses `timestamptz`. The mapper below
 * is the only place either is reshaped.
 */
export interface AdminOrderRawRow {
  id: number;
  orderNumber: string | null;
  channel: OrderChannel;
  status: OrderStatusEnum;
  fulfillmentState: FulfillmentStateEnum;
  paymentState: AdminOrderPaymentState;
  reconciliationState: OrderReconciliationState | null;
  branchId: number | null;
  branchNameSnapshot: string | null;
  cashierUserId: number | null;
  cashierDisplaySnapshot: string | null;
  customerId: number | null;
  customerDisplay: string | null;
  userId: number | null;
  itemCount: number;
  unitCount: number;
  subtotal: string;
  totalPrice: string;
  /** NOT NULL in `orders` since migration 0003; the projection is a plain scan
   *  of that table, so no join can widen it back to null. */
  soldAt: Date;
  paidAt: Date | null;
  voidedAt: Date | null;
  refundedAt: Date | null;
  createdAt: Date | null;
}

/** One line of the detail, already cast to text by the projection SQL. */
export interface AdminOrderRawItem {
  id: number;
  productId: number | null;
  variantId: number | null;
  productTitleSnapshot: string;
  variantSkuSnapshot: string | null;
  attributesSnapshot: Record<string, string> | null;
  quantity: number;
  unitPrice: string;
  totalPrice: string;
}

/** One receipt of the detail. `track_id` is not selected — see the header. */
export interface AdminOrderRawPayment {
  id: number;
  status: string;
  amount: string;
  gatewayAmount: string | null;
  refNumber: string | null;
  paidAt: Date | null;
  requiresReconciliation: boolean;
  reconciliationReason: PaymentReconciliationReason | null;
  reconciledAt: Date | null;
  createdAt: Date | null;
}

// ===========================================================================
// Wire shapes
// ===========================================================================

/**
 * ONE ROW OF THE ADMIN ORDER LIST.
 *
 * Everything an order table needs to render and to be scanned by an operator,
 * and nothing a line-item drawer or a dispute needs. The detail endpoint is
 * where lines, receipts and the delivery address live.
 */
export class AdminOrderRowView {
  @ApiProperty({ example: 41, description: 'Numeric `orders.id`.' })
  id: number;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'POS-20260910-000041',
    description:
      'The human-facing sale number. NULL only for a row observed between ' +
      'insert and numbering.',
  })
  orderNumber: string | null;

  @ApiProperty({ enum: OrderChannel, example: OrderChannel.POS })
  channel: OrderChannel;

  @ApiProperty({
    enum: OrderStatusEnum,
    example: OrderStatusEnum.PAID,
    description: 'The MONEY / commercial state of the order.',
  })
  status: OrderStatusEnum;

  @ApiProperty({
    enum: FulfillmentStateEnum,
    example: FulfillmentStateEnum.FULFILLED,
    description: 'The state of the GOODS, tracked independently of the money.',
  })
  fulfillmentState: FulfillmentStateEnum;

  @ApiProperty({
    enum: AdminOrderPaymentState,
    example: AdminOrderPaymentState.SUCCESS,
    description:
      'DERIVED from this order’s `payment` rows, not stored. Precedence: ' +
      'success > refunded > pending > failed > none. A `confirmed_unapplied` ' +
      'receipt is deliberately not represented here and reads `none`; the ' +
      'reconciliation queue owns it.',
  })
  paymentState: AdminOrderPaymentState;

  @ApiProperty({
    enum: OrderReconciliationState,
    nullable: true,
    example: null,
    description:
      'NULL means the case has never been touched, which is NOT the same as ' +
      '`open`. Filter for it with `reconciliationState=none`.',
  })
  reconciliationState: OrderReconciliationState | null;

  @ApiProperty({ type: Number, nullable: true, example: 3 })
  branchId: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Sanandaj',
    description: 'The branch name AS IT WAS at sale time. Survives a rename.',
  })
  branchNameSnapshot: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 7 })
  cashierUserId: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'hosseini',
    description:
      'WHO SOLD IT, as it read at sale time. Never overwritten by a later ' +
      'void, return or status change — those name their own actor in ' +
      '`GET /orders/{id}/actions`.',
  })
  cashierDisplaySnapshot: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 12 })
  customerId: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Maryam R.',
    description:
      'MINIMAL IDENTITY ONLY, so that an operator can recognise a row. The ' +
      'customer’s name where one is recorded, otherwise a MASKED telephone ' +
      'number (`***1234`); a value that is all digits is masked whichever ' +
      'column it came from. The address, postal code and full telephone ' +
      'number are NOT in this list at all — they are on the detail endpoint, ' +
      'which an operator has to open deliberately.',
  })
  customerDisplay: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 88,
    description: 'The storefront account that placed it. NULL for a POS sale.',
  })
  userId: number | null;

  @ApiProperty({ example: 3, description: 'Distinct lines on the order.' })
  itemCount: number;

  @ApiProperty({ example: 7, description: 'Sum of the line quantities.' })
  unitCount: number;

  @ApiProperty({
    example: '750000',
    description: 'Sum of the line totals. INTEGER RIAL as a STRING.',
  })
  subtotal: string;

  @ApiProperty({
    example: '750000',
    description: 'What the customer paid. INTEGER RIAL as a STRING.',
  })
  totalPrice: string;

  /** Always present — see `AdminOrderRawRow.soldAt`. */
  @ApiProperty({ type: String, format: 'date-time' })
  soldAt: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  paidAt: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  voidedAt: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  refundedAt: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  createdAt: string | null;
}

/** One page of the admin order list, newest sale first. */
export class AdminOrderListView {
  @ApiProperty({ type: [AdminOrderRowView] })
  data: AdminOrderRowView[];

  @ApiProperty({ example: 412, description: 'Rows matching the filters.' })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 10 })
  limit: number;

  @ApiProperty({ example: 42 })
  totalPages: number;
}

/** One sold line, read from the IMMUTABLE `order_items.*Snapshot` columns. */
export class AdminOrderItemView {
  @ApiProperty({ example: 88, description: 'Numeric `order_items.id`.' })
  id: number;

  @ApiProperty({ type: Number, nullable: true, example: 12 })
  productId: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 34 })
  variantId: number | null;

  @ApiProperty({ example: 'iPhone 17 Pro' })
  productTitleSnapshot: string;

  @ApiProperty({ type: String, nullable: true, example: 'IPH17-BLK-128' })
  variantSkuSnapshot: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    nullable: true,
    example: { Colour: 'Black' },
  })
  attributesSnapshot: Record<string, string> | null;

  @ApiProperty({ example: 3 })
  quantity: number;

  @ApiProperty({ example: '250000', description: 'INTEGER RIAL as a STRING.' })
  unitPrice: string;

  @ApiProperty({ example: '750000', description: 'INTEGER RIAL as a STRING.' })
  totalPrice: string;
}

/**
 * WHERE THE GOODS WERE ACTUALLY SENT, frozen at checkout.
 *
 * This is `orders.addressSnapshot` and NOT the live `addresses` row the
 * `addressId` points at. The live row is editable and deletable by the
 * customer, so reading the delivery address through the relation meant a past
 * order's address changed whenever the customer tidied their address book —
 * which is the same defect migration 0015 created this column to close, and the
 * reason the customer view refuses to load the relation either.
 */
export class AdminOrderAddressView {
  @ApiProperty({
    example: 41,
    description:
      'Provenance only — the live row may since have been edited or deleted.',
  })
  addressId: number;

  @ApiProperty({ example: 'Tehran' })
  province: string;

  @ApiProperty({ example: 'Tehran' })
  city: string;

  @ApiProperty({ example: 'Somewhere 12' })
  address: string;

  @ApiProperty({ example: '1234567890' })
  postalCode: string;

  @ApiProperty({ example: '09120000000' })
  receiverMobile: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'NULL on pre-0015 orders, where the text is a reconstruction and not a ' +
      'claim about what the address said at order time.',
  })
  capturedAt: string | null;
}

/** The person the goods are for, as the ORDER directory records them. */
export class AdminOrderCustomerView {
  @ApiProperty({ example: 12 })
  id: number;

  @ApiProperty({ example: '09120000000' })
  mobile: string;

  @ApiProperty({ type: String, nullable: true, example: 'Maryam R.' })
  name: string | null;
}

/** The storefront account that placed the order, if it was placed online. */
export class AdminOrderUserView {
  @ApiProperty({ example: 88 })
  id: number;

  @ApiProperty({
    example: 'maryam',
    description: '`username`, falling back to `mobile` — the login identity.',
  })
  identifier: string;
}

/** One receipt. `track_id` is NEVER projected — see the file header. */
export class AdminOrderPaymentView {
  @ApiProperty({ example: 12, description: 'Numeric `payment.id`.' })
  id: number;

  @ApiProperty({ example: 'success' })
  status: string;

  @ApiProperty({
    example: '750000',
    description: 'What WE asked for. INTEGER RIAL as a STRING.',
  })
  amount: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '750000',
    description:
      'What the GATEWAY reported. NULL when it reported nothing usable; the ' +
      'verbatim text is kept in `payment.gateway_amount_raw` and is served by ' +
      'the reconciliation queue, not here.',
  })
  gatewayAmount: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'ZBL-88213',
    description:
      'The reference an operator quotes. NOT the gateway session id.',
  })
  refNumber: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  paidAt: string | null;

  @ApiProperty({ type: Boolean, example: false })
  requiresReconciliation: boolean;

  @ApiProperty({
    enum: PaymentReconciliationReason,
    nullable: true,
    example: null,
  })
  reconciliationReason: PaymentReconciliationReason | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  reconciledAt: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  createdAt: string | null;
}

/**
 * The phase-2 retry queue for this order.
 *
 * `lastError` IS exposed here and deliberately nowhere else: it is raw internal
 * failure text, which is exactly what an administrator diagnosing a stuck order
 * needs and exactly what the customer view exists to withhold.
 */
export class AdminOrderFulfilmentView {
  @ApiProperty({ enum: FulfillmentStateEnum })
  state: FulfillmentStateEnum;

  @ApiProperty({ example: 0 })
  attempts: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastAttemptAt: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'NULL means DUE NOW, not "never".',
  })
  nextAttemptAt: string | null;

  @ApiProperty({ type: String, nullable: true })
  lastError: string | null;
}

/** The manual reconciliation case attached to this order, if any. */
export class AdminOrderReconciliationView {
  @ApiProperty({ enum: OrderReconciliationState, nullable: true })
  state: OrderReconciliationState | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  resolvedAt: string | null;
}

/**
 * ONE ORDER, for the administrator.
 *
 * Everything in the list row, plus the things an operator opens a single order
 * to see. `allowedStatusTransitions`, `canVoid` and `canReturn` are computed
 * from the SAME conditions the mutation endpoints enforce, so the console never
 * offers a button the server will refuse — see `adminOrderCapabilities`.
 */
export class AdminOrderDetailView extends AdminOrderRowView {
  @ApiProperty({ type: [AdminOrderItemView] })
  items: AdminOrderItemView[];

  @ApiProperty({
    type: AdminOrderAddressView,
    nullable: true,
    description:
      'The FROZEN `orders.addressSnapshot`, never the live `addresses` row.',
  })
  address: AdminOrderAddressView | null;

  @ApiProperty({ type: AdminOrderCustomerView, nullable: true })
  customer: AdminOrderCustomerView | null;

  @ApiProperty({ type: AdminOrderUserView, nullable: true })
  user: AdminOrderUserView | null;

  @ApiProperty({ type: [AdminOrderPaymentView] })
  payments: AdminOrderPaymentView[];

  @ApiProperty({ type: AdminOrderFulfilmentView })
  fulfilment: AdminOrderFulfilmentView;

  @ApiProperty({ type: AdminOrderReconciliationView })
  reconciliation: AdminOrderReconciliationView;

  @ApiProperty({
    enum: OrderStatusEnum,
    isArray: true,
    example: [OrderStatusEnum.SHIPPED],
    description:
      'The statuses `PATCH /orders/status/{id}` would ACCEPT from this order, ' +
      'for THIS caller. Already filtered: a voided order offers none, ' +
      '`canceled`/`refunded` are never offered (void/return own them so stock ' +
      'is restored), a `paid` order whose goods are not allocated offers no ' +
      'post-payment status, and a caller without `orders.status.update` is ' +
      'offered nothing.',
  })
  allowedStatusTransitions: OrderStatusEnum[];

  @ApiProperty({
    example: true,
    description:
      'Whether `POST /orders/{id}/void` would be accepted for this caller.',
  })
  canVoid: boolean;

  @ApiProperty({
    example: false,
    description:
      'Whether `POST /orders/{id}/return` would be accepted for this caller.',
  })
  canReturn: boolean;
}

/** One append-only entry of an order's administrative history. */
export class AdminOrderActionView {
  @ApiProperty({ example: 5, description: 'Numeric `order_actions.id`.' })
  id: number;

  @ApiProperty({
    example: 'void',
    description: '`status_change`, `void`, `return` or `refund`.',
  })
  action: string;

  @ApiProperty({ type: String, nullable: true, example: 'paid' })
  fromStatus: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'canceled' })
  toStatus: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 7 })
  actorUserId: number | null;

  @ApiProperty({
    example: 'hosseini',
    description:
      'WHO DID IT, frozen at the time of the act. Survives renaming, ' +
      'deactivating or deleting that staff member.',
  })
  actorDisplaySnapshot: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  reason: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: string;
}

/** One page of an order's administrative history, oldest first. */
export class AdminOrderActionListView {
  @ApiProperty({ type: [AdminOrderActionView] })
  data: AdminOrderActionView[];

  @ApiProperty({ example: 3 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 50 })
  limit: number;

  @ApiProperty({ example: 1 })
  totalPages: number;
}

// ===========================================================================
// The mapping. Pure functions, allow-list, no `delete`.
// ===========================================================================

/** `Date | null` -> ISO-8601, which is what the wire shows anyway. */
const iso = (value: Date | string | null | undefined): string | null =>
  value === null || value === undefined ? null : new Date(value).toISOString();

/**
 * Same conversion for a column the SCHEMA guarantees is present, returning
 * `string` rather than `string | null`.
 *
 * Separate from `iso` on purpose: routing a NOT NULL column through `iso` and
 * then asserting `as string` at the call site hides the guarantee behind a cast
 * that would keep compiling if the column ever became nullable again.
 */
const isoRequired = (value: Date | string): string =>
  new Date(value).toISOString();

export function toAdminOrderRowView(row: AdminOrderRawRow): AdminOrderRowView {
  return {
    id: Number(row.id),
    orderNumber: row.orderNumber,
    channel: row.channel,
    status: row.status,
    fulfillmentState: row.fulfillmentState,
    paymentState: row.paymentState,
    reconciliationState: row.reconciliationState,
    branchId: row.branchId === null ? null : Number(row.branchId),
    branchNameSnapshot: row.branchNameSnapshot,
    cashierUserId:
      row.cashierUserId === null ? null : Number(row.cashierUserId),
    cashierDisplaySnapshot: row.cashierDisplaySnapshot,
    customerId: row.customerId === null ? null : Number(row.customerId),
    customerDisplay: row.customerDisplay,
    userId: row.userId === null ? null : Number(row.userId),
    itemCount: Number(row.itemCount),
    unitCount: Number(row.unitCount),
    subtotal: row.subtotal,
    totalPrice: row.totalPrice,
    soldAt: isoRequired(row.soldAt),
    paidAt: iso(row.paidAt),
    voidedAt: iso(row.voidedAt),
    refundedAt: iso(row.refundedAt),
    createdAt: iso(row.createdAt),
  };
}

export function toAdminOrderItemView(
  row: AdminOrderRawItem,
): AdminOrderItemView {
  return {
    id: Number(row.id),
    productId: row.productId === null ? null : Number(row.productId),
    variantId: row.variantId === null ? null : Number(row.variantId),
    productTitleSnapshot: row.productTitleSnapshot,
    variantSkuSnapshot: row.variantSkuSnapshot,
    attributesSnapshot: row.attributesSnapshot,
    quantity: Number(row.quantity),
    unitPrice: row.unitPrice,
    totalPrice: row.totalPrice,
  };
}

export function toAdminOrderPaymentView(
  row: AdminOrderRawPayment,
): AdminOrderPaymentView {
  return {
    id: Number(row.id),
    status: row.status,
    amount: row.amount,
    gatewayAmount: row.gatewayAmount,
    refNumber: row.refNumber,
    paidAt: iso(row.paidAt),
    requiresReconciliation: row.requiresReconciliation === true,
    reconciliationReason: row.reconciliationReason,
    reconciledAt: iso(row.reconciledAt),
    createdAt: iso(row.createdAt),
  };
}

export function toAdminOrderAddressView(
  snapshot: OrderAddressSnapshot | null | undefined,
): AdminOrderAddressView | null {
  if (!snapshot) return null;
  return {
    addressId: snapshot.addressId,
    province: snapshot.province,
    city: snapshot.city,
    address: snapshot.address,
    postalCode: snapshot.postalCode,
    receiverMobile: snapshot.receiverMobile,
    capturedAt: snapshot.capturedAt ?? null,
  };
}

export function toAdminOrderActionView(row: OrderAction): AdminOrderActionView {
  return {
    id: row.id,
    action: row.action,
    fromStatus: row.fromStatus ?? null,
    toStatus: row.toStatus ?? null,
    actorUserId: row.actorUserId ?? null,
    actorDisplaySnapshot: row.actorDisplaySnapshot,
    reason: row.reason ?? null,
    // `createdAt` is NOT NULL on `order_actions`, so this cast never widens.
    createdAt: iso(row.createdAt) as string,
  };
}

/**
 * ===========================================================================
 * WHAT THE CALLER MAY ACTUALLY DO TO THIS ORDER
 * ===========================================================================
 *
 * Every condition below is READ OFF the code that enforces it — the state
 * machine in `order-status.machine.ts`, the refusals at the top of
 * `OrdersService.updateStatus`, and the three guards at the top of
 * `OrdersService.reverseOrder`. Nothing here is an independent opinion about
 * what ought to be allowed.
 *
 * That is the whole point: a console that computes affordances from its own
 * copy of the rules drifts, and the operator finds out by clicking a button and
 * receiving a 409. When these rules change, they change in the service and this
 * function has to be brought along — which is a visible, reviewable edit rather
 * than a silent divergence.
 *
 * THE PERMISSIONS ARE USED TO SHAPE, NEVER TO AUTHORISE. The mutation routes
 * are guarded by `PermissionsGuard`; filtering the affordances by the caller's
 * capabilities only stops the console offering an action it already knows will
 * be refused.
 */
export function adminOrderCapabilities(
  order: Order,
  permissions: readonly string[],
): {
  allowedStatusTransitions: OrderStatusEnum[];
  canVoid: boolean;
  canReturn: boolean;
} {
  const held = new Set(permissions);

  // `updateStatus` refuses every transition on a voided order
  // (ORDER_FROZEN_BY_VOID), and `reverseOrder` refuses to void or return one.
  const frozen = order.voidedAt !== null && order.voidedAt !== undefined;

  const allowedStatusTransitions =
    !held.has('orders.status.update') || frozen
      ? []
      : allowedNextOrderStatuses(order.status).filter((next) => {
          // `updateStatus` sends these to /void and /return so that stock is
          // restored and the reversal is audited.
          if (
            next === OrderStatusEnum.CANCELED ||
            next === OrderStatusEnum.REFUNDED
          ) {
            return false;
          }
          // A paid order may not claim to be picked, shipped or delivered while
          // its goods have never been allocated: doing so evicts it from the
          // phase-2 recovery queue permanently.
          if (
            order.status === OrderStatusEnum.PAID &&
            isPostPaymentOperationalStatus(next) &&
            !canAdvancePastPaid(order.fulfillmentState)
          ) {
            return false;
          }
          return true;
        });

  // `reverseOrder('void')`: not already voided, and not already refunded
  // (CANNOT_VOID_REFUNDED).
  const canVoid =
    held.has('orders.void') &&
    !frozen &&
    order.status !== OrderStatusEnum.REFUNDED;

  // `reverseOrder('return')`: the same two refusals, plus the status allow-list
  // (CANNOT_RETURN_IN_STATUS). `refunded` is absent from that list, so the
  // already-returned case is covered by it as well.
  const canReturn =
    held.has('orders.return') &&
    !frozen &&
    (
      [
        OrderStatusEnum.PAID,
        OrderStatusEnum.PROCESSING,
        OrderStatusEnum.SHIPPED,
        OrderStatusEnum.DELIVERED,
      ] as OrderStatusEnum[]
    ).includes(order.status);

  return {
    allowedStatusTransitions: [...allowedStatusTransitions],
    canVoid,
    canReturn,
  };
}

/**
 * Assembles the detail from the four sources that own its facts: the projection
 * row (derived payment state, counts, money as text), the order entity (the
 * frozen snapshots and the fulfilment queue), and the two line/receipt
 * projections. Nothing is read from a live catalogue or address row.
 */
export function toAdminOrderDetailView(input: {
  row: AdminOrderRawRow;
  order: Order;
  items: AdminOrderRawItem[];
  payments: AdminOrderRawPayment[];
  permissions: readonly string[];
}): AdminOrderDetailView {
  const { row, order, items, payments, permissions } = input;
  const capabilities = adminOrderCapabilities(order, permissions);

  return {
    ...toAdminOrderRowView(row),
    items: items.map(toAdminOrderItemView),
    address: toAdminOrderAddressView(order.addressSnapshot),
    customer: order.customer
      ? {
          id: order.customer.id,
          mobile: order.customer.mobile,
          name: order.customer.name ?? null,
        }
      : null,
    user: order.user
      ? { id: order.user.id, identifier: order.user.identifier }
      : null,
    payments: payments.map(toAdminOrderPaymentView),
    fulfilment: {
      state: order.fulfillmentState,
      attempts: order.fulfillmentAttempts,
      lastAttemptAt: iso(order.fulfillmentLastAttemptAt),
      nextAttemptAt: iso(order.fulfillmentNextAttemptAt),
      lastError: order.fulfillmentLastError ?? null,
    },
    reconciliation: {
      state: order.reconciliationState ?? null,
      resolvedAt: iso(order.reconciliationResolvedAt),
    },
    ...capabilities,
  };
}
