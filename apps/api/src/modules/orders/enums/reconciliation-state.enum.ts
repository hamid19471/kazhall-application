/**
 * ===========================================================================
 * THE LIFECYCLE OF ONE MANUAL RECONCILIATION CASE (owner decision D-2)
 * ===========================================================================
 *
 * A CASE IS AN ORDER that needs a human, for either of two reasons:
 *
 *   - money arrived that could not be applied (`payment.requires_reconciliation`
 *     with `reconciled_at IS NULL`), or
 *   - the order is PAID and its goods were never allocated
 *     (`status = 'paid'` with `fulfillmentState IN ('pending','awaiting_stock')`).
 *
 * `NULL` — the column's default and the state of every pre-0018 row — means the
 * case has never been touched. It is NOT the same as `OPEN`: `OPEN` records
 * that the system or an operator has acknowledged the case, which is what the
 * customer-facing "requires review" wording is derived from.
 *
 * NOTHING IN THIS ENUM IS AUTOMATIC EXCEPT `OPEN`. `FulfilmentService` stamps
 * `OPEN` when it refuses to consume stock, because that refusal IS the
 * acknowledgement. Every other member is written only by an operator action,
 * each of which requires `super_admin`, an `Idempotency-Key`, a mandatory
 * reason, and leaves an append-only `payment_actions` row.
 */
export enum OrderReconciliationState {
  /** Acknowledged, no decision taken. Non-terminal; stays in the queue. */
  OPEN = 'open',
  /**
   * An operator decided money must go back. **NOTHING HAS BEEN REFUNDED.**
   * This records the OBLIGATION and the expected amount; the refund itself
   * happens with the provider, outside this system, and is reported back
   * through `REFUND_CONFIRMED`. Non-terminal on purpose: an unpaid obligation
   * must not leave the queue.
   */
  REFUND_REQUIRED = 'refund_required',
  /**
   * An operator confirmed a refund THEY completed with the provider, quoting
   * its reference. Terminal.
   */
  REFUND_CONFIRMED = 'refund_confirmed',
  /**
   * An explicit decision to keep the paid order open and wait for stock. No
   * stock is consumed and none is promised. Non-terminal: the customer is still
   * owed goods, so the case stays visible.
   */
  BACKORDERED = 'backordered',
  /** Closed with no money moving in either direction. Terminal. */
  RESOLVED = 'resolved',
}

/**
 * The states that stamp `orders."reconciliationResolvedAt"`.
 *
 * Mirrors the CHECK constraint `ck_orders_reconciliation_resolved` (migration
 * 0018) exactly, so the SQL and the TypeScript cannot drift: a row cannot claim
 * to be resolved without naming WHICH resolution it was.
 */
export const TERMINAL_RECONCILIATION_STATES: readonly OrderReconciliationState[] =
  [
    OrderReconciliationState.REFUND_CONFIRMED,
    OrderReconciliationState.RESOLVED,
  ];

export function isTerminalReconciliationState(
  state: OrderReconciliationState | null | undefined,
): boolean {
  return (
    state !== null &&
    state !== undefined &&
    TERMINAL_RECONCILIATION_STATES.includes(state)
  );
}

/**
 * What the CUSTOMER is told about a case, in customer-safe vocabulary.
 *
 * This is a deliberately tiny, honest vocabulary. It never says "fulfilled"
 * about goods that have not moved and never says "refunded" about money that
 * has not gone back, and it carries no operator note, no gateway reference, no
 * internal error text and no amount. It exists so the customer of an order the
 * system has put on hold is told something TRUE instead of nothing.
 */
export enum CustomerOrderReviewState {
  /**
   * "Payment received — this order requires review." The money is recorded and
   * nothing has been refunded or charged again; a human is looking at it.
   */
  UNDER_REVIEW = 'under_review',
  /**
   * "A refund has been arranged and is being processed." Says a refund is IN
   * PROGRESS, never that it has completed — the completion is only ever
   * reported after an operator confirms it with the provider, at which point
   * the order's own `status` becomes `refunded` and this field goes back to
   * null.
   */
  REFUND_IN_PROGRESS = 'refund_in_progress',
}
