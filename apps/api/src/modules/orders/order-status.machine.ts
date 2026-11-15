import { OrderStatusEnum } from './enums/order-status.enum';

/**
 * Order status state machine.
 *
 * Before this existed, `PATCH /orders/status/:id` accepted ANY enum value from
 * ANY state, so a DELIVERED order could be moved back to PENDING and a
 * CANCELED order could be marked PAID. Every transition now has to be listed
 * here or it is rejected.
 *
 *   pending    -> paid | canceled | failed
 *   paid       -> processing | shipped | canceled | refunded
 *   processing -> shipped | canceled | refunded
 *   shipped    -> delivered | refunded
 *   delivered  -> refunded
 *   canceled   -> (terminal)
 *   failed     -> (terminal)
 *   refunded   -> (terminal)
 *
 * Additionally: a voided order (`orders.voidedAt IS NOT NULL`) is frozen and
 * accepts no further status transition at all -- the reversal is the last
 * commercial event in its life.
 */
export const ORDER_STATUS_TRANSITIONS: Readonly<
  Record<OrderStatusEnum, readonly OrderStatusEnum[]>
> = Object.freeze({
  [OrderStatusEnum.PENDING]: [
    OrderStatusEnum.PAID,
    OrderStatusEnum.CANCELED,
    OrderStatusEnum.FAILED,
  ],
  [OrderStatusEnum.PAID]: [
    OrderStatusEnum.PROCESSING,
    OrderStatusEnum.SHIPPED,
    OrderStatusEnum.CANCELED,
    OrderStatusEnum.REFUNDED,
  ],
  [OrderStatusEnum.PROCESSING]: [
    OrderStatusEnum.SHIPPED,
    OrderStatusEnum.CANCELED,
    OrderStatusEnum.REFUNDED,
  ],
  [OrderStatusEnum.SHIPPED]: [
    OrderStatusEnum.DELIVERED,
    OrderStatusEnum.REFUNDED,
  ],
  [OrderStatusEnum.DELIVERED]: [OrderStatusEnum.REFUNDED],
  [OrderStatusEnum.CANCELED]: [],
  [OrderStatusEnum.FAILED]: [],
  [OrderStatusEnum.REFUNDED]: [],
});

/** Statuses from which nothing further may happen. */
export const TERMINAL_ORDER_STATUSES: readonly OrderStatusEnum[] = [
  OrderStatusEnum.CANCELED,
  OrderStatusEnum.FAILED,
  OrderStatusEnum.REFUNDED,
];

export function isTerminalOrderStatus(status: OrderStatusEnum): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

/** A no-op transition (x -> x) is allowed and is treated as idempotent. */
export function canTransitionOrderStatus(
  from: OrderStatusEnum,
  to: OrderStatusEnum,
): boolean {
  if (from === to) return true;
  return ORDER_STATUS_TRANSITIONS[from].includes(to);
}

export function allowedNextOrderStatuses(
  from: OrderStatusEnum,
): readonly OrderStatusEnum[] {
  return ORDER_STATUS_TRANSITIONS[from];
}

/**
 * ===========================================================================
 * THE POST-PAYMENT OPERATIONAL STATUSES  —  "the goods are on their way"
 * ===========================================================================
 *
 * Every status below asserts, to staff and to the customer alike, that the
 * order has left the warehouse floor: it is being picked, it has been handed to
 * a courier, or it has arrived. None of them is true of an order whose stock has
 * never been consumed.
 *
 * They are also, and this is the operational half of the problem, OUTSIDE the
 * recovery set. `FulfilmentService.claim()` and `FulfilmentRecoveryService`'s
 * lease both filter `status = 'paid'`, so the instant an order moves to any of
 * these it is gone from phase 2 forever — there is no other writer of
 * `fulfillmentState` and no sweep that looks at `processing`. A paid order
 * pushed to `processing` while `fulfillmentState` is still `pending` /
 * `awaiting_stock` is money taken for goods that will never be allocated, and
 * nothing in the system will ever notice.
 *
 * `canceled` / `refunded` are deliberately NOT here: they are reversals, not
 * progress, they are refused by `updateStatus` anyway (void/return own them),
 * and blocking them would strand exactly the orders an operator needs to be
 * able to unwind.
 */
export const POST_PAYMENT_OPERATIONAL_STATUSES: readonly OrderStatusEnum[] = [
  OrderStatusEnum.PROCESSING,
  OrderStatusEnum.SHIPPED,
  OrderStatusEnum.DELIVERED,
];

export function isPostPaymentOperationalStatus(
  status: OrderStatusEnum,
): boolean {
  return POST_PAYMENT_OPERATIONAL_STATUSES.includes(status);
}
