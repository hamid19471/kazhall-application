/**
 * ===========================================================================
 * MANUAL RECONCILIATION — THE OPERATOR-FACING VOCABULARY (owner decision D-2)
 * ===========================================================================
 *
 * Everything in this file is read by a `super_admin` in a back-office screen,
 * never by a customer. The customer-facing wording lives in
 * `payment.messages.ts` and is deliberately separate: an operator needs to be
 * told what to DO, a customer needs to be told what is TRUE about their money.
 *
 * THE POLICY THESE MESSAGES ENCODE, stated once so every endpoint can be read
 * against it:
 *
 *   - nothing is ever refunded, cancelled or back-ordered automatically;
 *   - no gateway receipt is ever rewritten or deleted;
 *   - no stock is consumed that is not available, and stock never goes negative;
 *   - a decision is never taken twice (mandatory `Idempotency-Key` + validated
 *     source states + row locks);
 *   - every decision leaves an append-only `payment_actions` row naming the
 *     operator, the reason, and the states it moved.
 */
export const ReconciliationMessages = {
  // --- reads ---------------------------------------------------------------
  QUEUE_READ: 'Reconciliation queue',
  CASE_READ: 'Reconciliation case',
  CASE_NOT_FOUND:
    'No reconciliation case exists for that order id (the order does not ' +
    'exist, or it has nothing outstanding).',

  // --- successful mutations -------------------------------------------------
  FULFILMENT_RETRIED: 'Fulfilment retry attempted',
  REFUND_REQUIRED_RECORDED: 'Recorded that this order requires a manual refund',
  REFUND_CONFIRMED: 'Externally completed refund recorded',
  BACKORDER_RECORDED: 'Order marked as backordered',
  CASE_RESOLVED: 'Reconciliation case resolved with no financial action',

  // --- idempotency ----------------------------------------------------------
  //
  // The operator does NOT type this value: the admin UI generates one key per
  // decision and resends that exact value if the request has to be retried.
  // Every sentence says so, for the same reason the POS ones do.
  IDEMPOTENCY_KEY_REQUIRED:
    'An Idempotency-Key header is required for every reconciliation decision. ' +
    'The admin client must generate one key per decision (a UUIDv4) and resend ' +
    'that exact value on every retry of the same decision, so a double-click ' +
    'or a timed-out retry cannot record the decision — or move the money — ' +
    'twice. Operators never type this value.',
  IDEMPOTENCY_KEY_INVALID:
    'Idempotency-Key is malformed. It must be 8 to 200 characters using only ' +
    'letters, digits and the characters . _ : - (no spaces, no commas). A ' +
    'client-generated UUIDv4 per decision is the recommended format.',

  // --- refusals -------------------------------------------------------------
  REASON_REQUIRED:
    'A reason is required. It is written to the append-only audit trail and is ' +
    'the only record of WHY this decision was taken.',
  ALREADY_RESOLVED:
    'This reconciliation case has already been resolved and cannot be changed. ' +
    'A resolved case is closed; open a new decision on the order instead.',
  REFUND_ALREADY_CONFIRMED:
    'A refund has already been confirmed for this receipt. Confirming it again ' +
    'would report the money as returned twice.',
  REFUND_PENDING_CONFIRMATION:
    'This order is marked as requiring a manual refund, so it cannot be closed ' +
    'without financial action. Either confirm the refund you completed with ' +
    'the provider, or record a different decision first.',
  PAYMENT_NOT_ON_ORDER: 'That payment attempt does not belong to this order.',
  PAYMENT_NOT_REFUNDABLE:
    'Only a payment the gateway CONFIRMED can be recorded as refunded. This ' +
    'attempt is not in a confirmed state (`success` or `confirmed_unapplied`), ' +
    'so there is no receipt to refund.',
  REFUND_AMOUNT_INVALID:
    'The refunded amount must be a positive integer Rial amount and cannot ' +
    'exceed the largest figure recorded for this receipt (what we asked for, ' +
    'or what the gateway reported). Neither recorded figure is overwritten.',
  ORDER_NOT_RETRYABLE:
    'Fulfilment can only be retried for an order that is paid and whose goods ' +
    'have not been allocated yet (`fulfillmentState` `pending` or ' +
    '`awaiting_stock`).',
  ORDER_NOT_BACKORDERABLE:
    'Only a paid order whose goods have not been allocated can be marked as ' +
    'backordered.',
  ACTOR_NOT_FOUND: 'The acting operator no longer exists',
} as const;

/**
 * Stable machine-readable codes, placed on the TOP-LEVEL `error` key of the
 * error envelope. Part of the shipped contract: never rename one, never reuse
 * one for a different condition.
 */
export enum ReconciliationErrorCode {
  /** 404 — no order, or nothing outstanding on it. */
  RECONCILIATION_CASE_NOT_FOUND = 'RECONCILIATION_CASE_NOT_FOUND',
  /** 409 — the case is in a terminal state. */
  RECONCILIATION_ALREADY_RESOLVED = 'RECONCILIATION_ALREADY_RESOLVED',
  /** 409 — a refund was already confirmed for this receipt. */
  REFUND_ALREADY_CONFIRMED = 'REFUND_ALREADY_CONFIRMED',
  /** 409 — cannot close a case that still owes a refund. */
  REFUND_PENDING_CONFIRMATION = 'REFUND_PENDING_CONFIRMATION',
  /** 404 — the named payment is not on this order. */
  PAYMENT_NOT_ON_ORDER = 'PAYMENT_NOT_ON_ORDER',
  /** 409 — the named payment was never confirmed by the gateway. */
  PAYMENT_NOT_REFUNDABLE = 'PAYMENT_NOT_REFUNDABLE',
  /** 400 — the stated refund amount is not usable. */
  REFUND_AMOUNT_INVALID = 'REFUND_AMOUNT_INVALID',
  /** 409 — the order is not in a state fulfilment can be retried from. */
  ORDER_NOT_RETRYABLE = 'ORDER_NOT_RETRYABLE',
  /** 409 — the order is not in a state that can be backordered. */
  ORDER_NOT_BACKORDERABLE = 'ORDER_NOT_BACKORDERABLE',
}
