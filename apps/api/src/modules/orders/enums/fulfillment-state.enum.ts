/**
 * Whether the goods actually left the building, tracked independently of
 * `status` (which tracks the money/commercial state).
 *
 * POS sales are handed over across the counter inside the sale transaction, so
 * they are created `FULFILLED`. Online orders are `NOT_REQUIRED` until payment
 * succeeds, then `PENDING` -> `FULFILLED`, or `AWAITING_STOCK` when a confirmed
 * payment cannot be satisfied from stock (docs/ARCHITECTURE.md §2).
 */
export enum FulfillmentStateEnum {
  NOT_REQUIRED = 'not_required',
  PENDING = 'pending',
  FULFILLED = 'fulfilled',
  AWAITING_STOCK = 'awaiting_stock',
  FAILED = 'failed',
}

/**
 * The fulfilment states in which an order may leave `paid` for a POST-PAYMENT
 * OPERATIONAL status (`processing` / `shipped` / `delivered`).
 *
 *   FULFILLED     the goods were consumed. The claim is true.
 *   NOT_REQUIRED  there is nothing to fulfil through phase 2 at all — a POS
 *                 sale handed over at the counter, or a legacy row that never
 *                 entered the online pipeline. Such an order is not in
 *                 `FulfilmentService.claim()`'s state filter either, so
 *                 advancing it strands nothing.
 *
 * Everything else (`pending`, `awaiting_stock`, and the unused `failed`) means
 * the goods have NOT been allocated. Advancing such an order evicts it from the
 * recovery queue permanently — see `OrderMessages.ORDER_FULFILMENT_INCOMPLETE`.
 *
 * This is an ALLOW-LIST on purpose: a fulfilment state added by a future
 * migration is refused until somebody deliberately names it here, rather than
 * silently inheriting permission to ship unallocated goods.
 */
export const ADVANCEABLE_FULFILLMENT_STATES: readonly FulfillmentStateEnum[] = [
  FulfillmentStateEnum.FULFILLED,
  FulfillmentStateEnum.NOT_REQUIRED,
];

export function canAdvancePastPaid(state: FulfillmentStateEnum): boolean {
  return ADVANCEABLE_FULFILLMENT_STATES.includes(state);
}
