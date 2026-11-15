/**
 * WHY AN ORDER IS IN THE RECONCILIATION QUEUE.
 *
 * A case can carry SEVERAL of these at once — a duplicate confirmed receipt on
 * an order that is also stuck awaiting stock is one case with two reasons, not
 * two cases — so the API reports them as an array and the filter matches "has
 * this type".
 *
 * Each member is a PREDICATE OVER COMMITTED ROWS, never a stored flag. That is
 * deliberate: a queue driven by a flag is only as complete as the code paths
 * that remember to set it, and the whole point of this queue is that nothing
 * outstanding silently disappears from it.
 */
export enum ReconciliationCaseType {
  /**
   * The gateway confirmed money that was NOT applied to the order, and no
   * operator has closed it:
   *   `payment.requires_reconciliation AND payment.reconciled_at IS NULL`.
   */
  UNAPPLIED_RECEIPT = 'unapplied_receipt',
  /**
   * The order is PAID and phase 2 has not consumed its stock yet:
   *   `orders.status = 'paid' AND orders."fulfillmentState" = 'pending'`.
   * Transient in the healthy case (phase 2 runs seconds after payment) and
   * permanent when fulfilment is refused, which is why the queue also carries
   * `fulfilmentAuthorized` — the same predicate `FulfilmentService.claim()`
   * evaluates — so an operator can tell the two apart at a glance.
   */
  FULFILMENT_INCOMPLETE = 'fulfilment_incomplete',
  /**
   * The order is PAID and phase 2 could not get the stock:
   *   `orders.status = 'paid' AND orders."fulfillmentState" = 'awaiting_stock'`.
   */
  AWAITING_STOCK = 'awaiting_stock',
  /**
   * An operator decision is recorded and not closed out:
   *   `orders."reconciliationState" IS NOT NULL AND
   *    orders."reconciliationResolvedAt" IS NULL`.
   * This is what keeps a `refund_required` obligation in the queue even after
   * the goods question has gone away.
   */
  OPERATOR_OPEN = 'operator_open',
}

/**
 * The mutations an operator may perform on a case NEXT, given its current
 * state. Returned by the case detail endpoint so the admin UI renders exactly
 * the buttons the server will honour, instead of guessing and discovering the
 * answer through a 409.
 *
 * The server still validates every source state independently — this list is a
 * convenience, never the authorization.
 */
export enum ReconciliationActionName {
  RETRY_FULFILMENT = 'retry_fulfilment',
  MARK_REFUND_REQUIRED = 'mark_refund_required',
  CONFIRM_EXTERNAL_REFUND = 'confirm_external_refund',
  MARK_BACKORDER = 'mark_backorder',
  RESOLVE_NO_ACTION = 'resolve_no_action',
}

/**
 * What kind of "nothing needed to happen" an operator is asserting when they
 * close a case without moving money.
 *
 * Mandatory and explicit, because "resolved" on its own is not a record of a
 * decision — it is a record that somebody clicked something. Each member is a
 * different, auditable claim about reality.
 */
export enum ReconciliationResolutionType {
  /** The discrepancy was a reporting artefact; the books already balance. */
  NO_DISCREPANCY = 'no_discrepancy',
  /** The money was reconciled outside this system (bank/provider ledger). */
  SETTLED_EXTERNALLY = 'settled_externally',
  /** The customer was contacted and agreed no action is needed. */
  CUSTOMER_AGREED = 'customer_agreed',
  /** The receipt was a gateway duplicate that never moved money. */
  GATEWAY_DUPLICATE = 'gateway_duplicate',
}

/**
 * THE CASE STAGES — the three tabs the reconciliation page defaults to.
 *
 * `ReconciliationCaseType` above describes WHAT IS WRONG with a case and a
 * case can carry several at once. This describes WHERE IN THE WORKFLOW it is,
 * and a case is in exactly one — the three PARTITION the queue, so a manager
 * who empties all three has handled everything and nothing can hide between
 * two tabs.
 *
 *   needs_action  no decision has been taken yet. The default view.
 *   tracking      a decision is taken and waiting on something outside this
 *                 system: a refund to be performed in the payment provider's
 *                 own panel, or stock to arrive.
 *   closed        finished, one way or the other.
 */
export const RECONCILIATION_STAGES = [
  'needs_action',
  'tracking',
  'closed',
] as const;

export type ReconciliationStage = (typeof RECONCILIATION_STAGES)[number];
