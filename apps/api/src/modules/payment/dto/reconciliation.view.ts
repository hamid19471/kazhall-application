import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { FulfillmentStateEnum } from 'src/modules/orders/enums/fulfillment-state.enum';
import { OrderChannel } from 'src/modules/orders/enums/order-channel.enum';
import { OrderStatusEnum } from 'src/modules/orders/enums/order-status.enum';
import { OrderReconciliationState } from 'src/modules/orders/enums/reconciliation-state.enum';
import {
  PaymentReconciliationReason,
  PaymentStatusEnum,
} from '../enums/payment-status-enum';
import { PaymentActionType } from '../entities/payment-action.entity';
import {
  ReconciliationActionName,
  ReconciliationCaseType,
} from '../reconciliation.types';

/**
 * ===========================================================================
 * THE OPERATOR'S VIEW OF A RECONCILIATION CASE — BOUNDED, ALLOW-LIST, NO
 * ENTITIES
 * ===========================================================================
 *
 * NOTHING HERE IS A TYPEORM ENTITY. Returning a `Payment` row would put
 * `track_id` — the value `POST /payment/verify` accepts as the whole request —
 * into an admin response, along with the re-verification scheduler's internals
 * (`reverify_attempts`, `next_reverify_at`) which are worker bookkeeping and
 * not facts about the money. Returning an `Order` would carry
 * `fulfillmentLastError`, a raw internal error string. Every field below is
 * named explicitly, so a column added by a future migration cannot appear here
 * by default.
 *
 * WHAT IS DELIBERATELY EXCLUDED, and why:
 *
 *   payment.track_id            the gateway SESSION identifier, and the entire
 *                               credential `POST /payment/verify` takes. It is
 *                               not what an operator quotes — `ref_number` is —
 *                               and it must not sit in a screenshot or a
 *                               support ticket.
 *   payment.reverify_attempts   re-verification scheduler bookkeeping
 *   payment.last_reverified_at  idem
 *   payment.next_reverify_at    idem — the due-time queue key
 *   orders.fulfillmentLastError raw internal failure text. The SAME diagnosis
 *                               is served, structured and clause by clause, as
 *                               `authorizationClauses`.
 *   orders.fulfillment*         the retry queue's own columns
 *   customer / user / address   whole other entities. Only the identifying
 *                               fields an operator needs to find the person are
 *                               projected, and only on the DETAIL endpoint.
 *
 * EVERY MONETARY FIELD IS A STRING. These are `bigint` INTEGER RIAL columns;
 * reading one through a JS `Number` silently rounds past 2^53, which integer
 * Rial reaches for ordinary sums. They are cast to `::text` in SQL, compared in
 * PostgreSQL, and never converted back — so what an operator reads is exactly
 * what the database holds.
 */

/** Money on one case, bucketed so that nothing is counted twice. */
export class ReconciliationMoneyView {
  @ApiProperty({
    example: '1000000',
    description: '`orders.total_price`. INTEGER RIAL as a STRING.',
  })
  orderTotal: string;

  @ApiProperty({
    example: '1000000',
    description:
      'Money the gateway confirmed and that is STILL HELD: the sum over ' +
      'receipts whose status is `success` or `confirmed_unapplied`, taking ' +
      '`gateway_amount` when the gateway reported one and `amount` otherwise. ' +
      'INTEGER RIAL as a STRING.',
  })
  confirmedHeld: string;

  @ApiProperty({
    example: '0',
    description:
      'The `confirmed_unapplied` subset of `confirmedHeld` — money that ' +
      'arrived but settled nothing. Provisional by definition: it is stated ' +
      'separately rather than folded into a single "paid" figure.',
  })
  confirmedUnapplied: string;

  @ApiProperty({
    example: '0',
    description:
      'Money reported back to the customer: the sum over receipts whose status ' +
      'is `refunded`. A receipt is in exactly ONE of these buckets, so ' +
      '`confirmedHeld` and `refundedTotal` never double-count.',
  })
  refundedTotal: string;

  @ApiProperty({
    type: Boolean,
    example: false,
    description:
      'True when at least one confirmed receipt reports a figure that does ' +
      'not match what we asked for, or reports none at all. The discrepancy ' +
      'is never netted away — it is flagged here and itemised per receipt.',
  })
  hasAmountDiscrepancy: boolean;
}

/** One payment attempt, as an operator needs to see it. */
export class ReconciliationReceiptView {
  @ApiProperty({ example: 12, description: 'Numeric `payment.id`.' })
  id: number;

  @ApiProperty({ enum: PaymentStatusEnum, example: PaymentStatusEnum.SUCCESS })
  status: PaymentStatusEnum;

  @ApiProperty({
    example: '1000000',
    description: 'What WE asked for. INTEGER RIAL as a STRING.',
  })
  amount: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '1000000',
    description:
      'What the GATEWAY reported. NULL when it reported nothing usable — the ' +
      'verbatim text is then in `gatewayAmountRaw`. INTEGER RIAL as a STRING.',
  })
  gatewayAmount: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description:
      'The gateway’s figure VERBATIM when it could not be stored as an ' +
      'integer Rial amount. The only evidence of what the gateway actually ' +
      'said; never overwritten.',
  })
  gatewayAmountRaw: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'ZBL-88213',
    description:
      'The gateway’s own reference for the receipt — what an operator quotes. ' +
      'The gateway SESSION id (`track_id`) is deliberately NOT exposed.',
  })
  refNumber: string | null;

  @ApiProperty({ type: Boolean, example: false })
  requiresReconciliation: boolean;

  @ApiProperty({
    enum: PaymentReconciliationReason,
    nullable: true,
    example: null,
  })
  reconciliationReason: PaymentReconciliationReason | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When an operator closed THIS receipt.',
  })
  reconciledAt: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the gateway confirmed it, from the DATABASE clock.',
  })
  paidAt: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: string;
}

/**
 * The authorization predicate, clause by clause, for one receipt.
 *
 * This is `FulfilmentService.readAuthorizationClauses` promoted verbatim — the
 * SAME SQL that decides whether stock may be consumed, so the reason an
 * operator reads here and the reason fulfilment actually refused cannot
 * disagree.
 */
export class ReconciliationAuthorizationClauseView {
  @ApiProperty({ example: 12, description: 'Numeric `payment.id`.' })
  paymentId: number;

  @ApiProperty({ example: true, description: "Clause 1: status = 'success'." })
  isSuccess: boolean;

  @ApiProperty({
    example: true,
    description:
      'Clauses 2+3: the gateway reported a usable, non-negative sum.',
  })
  hasGatewayAmount: boolean;

  @ApiProperty({
    example: true,
    description: 'Clause 4: that sum equals the sum we requested.',
  })
  gatewayMatchesAmount: boolean;

  @ApiProperty({
    example: true,
    description: 'Clause 5: the requested sum equals `orders.total_price`.',
  })
  amountMatchesOrder: boolean;

  @ApiProperty({
    example: true,
    description:
      'Clause 6: no amount-verification reason is left unresolved on the row.',
  })
  reasonResolved: boolean;

  @ApiProperty({
    example: true,
    description:
      'All six clauses hold, i.e. THIS receipt authorizes consuming stock.',
  })
  qualifies: boolean;
}

/** One append-only audit row. */
export class ReconciliationActionView {
  @ApiProperty({ example: 4 })
  id: number;

  @ApiProperty({ enum: PaymentActionType })
  action: PaymentActionType;

  @ApiProperty({ type: Number, nullable: true, example: 12 })
  paymentId: number | null;

  @ApiProperty({
    example: 'admin@example',
    description:
      'The operator as they were NAMED at the time. Survives renaming, ' +
      'deactivating or deleting the account.',
  })
  actorDisplaySnapshot: string;

  @ApiProperty({ type: Number, nullable: true, example: 3 })
  actorUserId: number | null;

  @ApiProperty({ example: 'Confirmed with the bank.' })
  reason: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  fromPaymentStatus: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  toPaymentStatus: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  fromOrderStatus: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  toOrderStatus: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'open' })
  fromReconciliationState: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'refund_required' })
  toReconciliationState: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'ZBL-REFUND-99213' })
  externalReference: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '1000000',
    description: 'INTEGER RIAL as a STRING.',
  })
  amount: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: string;
}

/** Allocation and consumption for the case, so an operator can see the goods. */
export class ReconciliationStockView {
  @ApiProperty({
    example: 0,
    description:
      'Rows in `stock_movements` for this order with reason ' +
      '`online_fulfillment` — i.e. whether the goods were EVER consumed. Zero ' +
      'means nothing physical has moved, so nothing physical can be restored.',
  })
  fulfilmentMovements: number;

  @ApiProperty({
    example: -3,
    description:
      'Net `SUM(delta)` over every `stock_movements` row for this order. ' +
      'Negative means stock left the building. A refund restores stock ONLY ' +
      'when this is negative — the same movement-derived rule ' +
      '`InventoryService.restoreForOrder` uses.',
  })
  netMovementDelta: number;

  @ApiProperty({
    example: 3,
    description:
      'Units still held by ACTIVE order allocations. These are a hold, not ' +
      'physical stock: releasing them gives nothing back to the ledger.',
  })
  activeAllocationUnits: number;

  @ApiProperty({
    example: 3,
    description: 'Total units ordered, summed over `order_items`.',
  })
  orderedUnits: number;
}

/** One row of the queue. */
export class ReconciliationCaseSummaryView {
  @ApiProperty({
    example: 41,
    description:
      'Numeric `orders.id`. This IS the case id — pass it to ' +
      '`GET /payment/admin/reconciliation/:orderId` and to every action.',
  })
  orderId: number;

  @ApiProperty({ type: String, nullable: true, example: 'WEB-20260910-000041' })
  orderNumber: string | null;

  @ApiProperty({ enum: OrderChannel, example: OrderChannel.ONLINE })
  channel: OrderChannel;

  @ApiProperty({ enum: OrderStatusEnum, example: OrderStatusEnum.PAID })
  orderStatus: OrderStatusEnum;

  @ApiProperty({
    enum: FulfillmentStateEnum,
    example: FulfillmentStateEnum.PENDING,
  })
  fulfillmentState: FulfillmentStateEnum;

  @ApiProperty({ type: Number, nullable: true, example: null })
  branchId: number | null;

  @ApiProperty({
    enum: ReconciliationCaseType,
    isArray: true,
    example: [ReconciliationCaseType.FULFILMENT_INCOMPLETE],
    description: 'Every reason this order is in the queue. Never empty.',
  })
  caseTypes: ReconciliationCaseType[];

  @ApiProperty({
    enum: OrderReconciliationState,
    nullable: true,
    example: null,
    description:
      'The operator lifecycle state. NULL means the case has never been ' +
      'touched, which is NOT the same as `open`.',
  })
  reconciliationState: OrderReconciliationState | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When an operator closed the case. NULL while it is open.',
  })
  reconciliationResolvedAt: string | null;

  @ApiProperty({
    type: Boolean,
    example: false,
    description:
      'Whether ANY receipt on this order authorizes consuming its stock — the ' +
      'exact predicate `FulfilmentService.claim()` evaluates. `false` on a ' +
      'paid, unfulfilled order is the D-2 population.',
  })
  fulfilmentAuthorized: boolean;

  @ApiProperty({ type: ReconciliationMoneyView })
  money: ReconciliationMoneyView;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the money arrived (`orders.paidAt`).',
  })
  paidAt: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: string;
}

/** One page of the queue. */
export class ReconciliationQueueView {
  @ApiProperty({ type: [ReconciliationCaseSummaryView] })
  data: ReconciliationCaseSummaryView[];

  @ApiProperty({ example: 7, description: 'Total cases matching the filters.' })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 10 })
  limit: number;

  @ApiProperty({ example: 1 })
  totalPages: number;
}

/** The identifying details an operator needs to find and contact the person. */
export class ReconciliationCustomerView {
  @ApiProperty({ type: Number, nullable: true, example: 8 })
  userId: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 5 })
  customerId: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '09120000000',
    description:
      'The number to call about the money. This is the only contact detail ' +
      'projected; no address, no password state, no token.',
  })
  mobile: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Ali' })
  displayName: string | null;
}

/** The full case. */
export class ReconciliationCaseDetailView extends ReconciliationCaseSummaryView {
  @ApiProperty({ type: ReconciliationCustomerView })
  customer: ReconciliationCustomerView;

  @ApiProperty({ type: [ReconciliationReceiptView] })
  receipts: ReconciliationReceiptView[];

  @ApiProperty({
    type: [ReconciliationAuthorizationClauseView],
    description:
      'Why each receipt does or does not authorize consuming stock. Empty when ' +
      'the order has no payment attempt at all.',
  })
  authorizationClauses: ReconciliationAuthorizationClauseView[];

  @ApiProperty({ type: ReconciliationStockView })
  stock: ReconciliationStockView;

  @ApiProperty({
    type: [ReconciliationActionView],
    description: 'The append-only audit trail for this case, oldest first.',
  })
  actions: ReconciliationActionView[];

  @ApiProperty({
    enum: ReconciliationActionName,
    isArray: true,
    description:
      'The mutations the server will honour from the case’s CURRENT state. A ' +
      'convenience for rendering buttons — the server validates every source ' +
      'state independently and this list is never the authorization.',
  })
  allowedActions: ReconciliationActionName[];
}

/** What every mutation endpoint answers with. */
export class ReconciliationActionResultView {
  @ApiProperty({ example: 41 })
  orderId: number;

  @ApiProperty({ enum: PaymentActionType })
  action: PaymentActionType;

  @ApiProperty({
    example: 4,
    description: 'Numeric `payment_actions.id` of the audit row just written.',
  })
  actionId: number;

  @ApiProperty({ enum: OrderStatusEnum })
  orderStatus: OrderStatusEnum;

  @ApiProperty({ enum: FulfillmentStateEnum })
  fulfillmentState: FulfillmentStateEnum;

  @ApiProperty({ enum: OrderReconciliationState, nullable: true })
  reconciliationState: OrderReconciliationState | null;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'RETRY ONLY. Whether THIS call consumed the stock (as opposed to finding ' +
      'the work already done, or being refused).',
  })
  fulfilled?: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'RETRY ONLY. Non-null when fulfilment was REFUSED because no receipt ' +
      'authorizes consuming stock. Never render such an order as progressing.',
  })
  blocked?: string | null;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'REFUND CONFIRMATION ONLY. Whether physical stock was given back. FALSE ' +
      'when the order never consumed any — there is nothing to restore and ' +
      'nothing is invented.',
  })
  stockRestored?: boolean;

  @ApiProperty({
    example: 'Externally completed refund recorded',
    description: 'Operator-facing summary. Never shown to a customer.',
  })
  message: string;
}

/**
 * The counts behind the queue's summary cards.
 *
 * ONE endpoint and one query for all nine, because they render above the list
 * on first paint and nine separate requests — or worse, one per bucket per
 * branch — is the fan-out this console is not allowed to have. The figures are
 * computed over the SAME case projection the list uses, so a card and the rows
 * beneath it cannot disagree.
 *
 * `needsAction` + `tracking` + `closed` is the whole queue: the three stages
 * partition it. The remaining figures are OVERLAPPING views of the unresolved
 * part (a case can be both "customer paid, order incomplete" and "stock
 * problem"), so they must never be added together.
 */
export interface ReconciliationQueueSummaryView {
  /** IANA zone the `resolvedToday` figure is bounded by. */
  timezone: string;
  /** Stage counts. These three partition the queue. */
  needsAction: number;
  tracking: number;
  closed: number;
  /** Overlapping views of the unresolved cases. Do not sum. */
  paidOrderIncomplete: number;
  stockProblem: number;
  refundRequired: number;
  unappliedReceipt: number;
  amountDiscrepancy: number;
  /** Closed within the current local calendar day. */
  resolvedToday: number;
}
