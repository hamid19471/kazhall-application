export const PaymentMessages = {
  ORDER_NOT_FOUND: 'Order not found',
  ORDER_NOT_PAYABLE: 'Order is not payable',
  ONLY_ORDER_OWNER_CAN_PAY: 'Only the owner of the order can pay for it',

  PAYMENT_FAILED: 'Payment failed',
  PAYMENT_NOT_FOUND: 'Payment not found',
  PAYMENT_ALREADY_PROCESSED: 'Payment already processed',

  PAYMENT_STARTED: 'Payment started successfully',
  PAYMENT_VERIFIED: 'Payment verified successfully',

  TOO_MANY_PENDING_PAYMENTS:
    'This order already has too many unfinished payment attempts; finish or abandon one first',
  GATEWAY_UNAVAILABLE: 'The payment gateway could not be reached',

  /**
   * A concurrent `Start()` for the same order is already waiting on the
   * gateway. We wait a bounded time for that session's trackId rather than
   * opening a SECOND gateway session for the same order -- two live sessions is
   * two ways for the customer to be charged twice. If the in-flight attempt
   * never lands, the caller is told plainly instead of being handed a duplicate.
   */
  PAYMENT_START_IN_FLIGHT:
    'A payment session for this order is already being opened; please try again in a moment',

  /**
   * The gateway confirmed this money, but it is NOT the payment that settled
   * the order (another attempt already did, or the order was no longer
   * payable). The receipt is recorded in full -- never as "pending" -- and
   * flagged for manual reconciliation. NO automatic refund is issued: that is
   * an owner decision (D-2/D-3), not something this service may take.
   */
  PAYMENT_RECORDED_NOT_APPLIED:
    'Your payment was received and recorded, but it was not applied to this order because the order was already settled or is no longer payable. Our team will contact you about it.',

  /**
   * THE AMOUNT DID NOT CHECK OUT, so the order was NOT confirmed.
   *
   * The customer must not be told the payment failed -- it did not, the money
   * moved and is on our books with a `paid_at` from the database clock. Nor may
   * they be told the order is confirmed, because it is still PENDING: an
   * amount-discrepant receipt now settles nothing (it used to settle the order
   * and let phase 2 ship the goods, with the discrepancy discovered only
   * afterwards). So the message says all three true things: money received,
   * order not yet confirmed, a human is looking at it.
   *
   * `PAYMENT_RECORDED_NOT_APPLIED` above cannot be reused for this: it asserts
   * the order "was already settled or is no longer payable", which for an
   * amount discrepancy is simply false.
   */
  PAYMENT_RECORDED_AMOUNT_MISMATCH:
    'Your payment was received and recorded, but the amount the payment gateway reported does not match this order, so we have not confirmed the order yet. Our team is reviewing it and will contact you. Nothing has been refunded or charged again.',

  /**
   * Same situation, different cause: the gateway reported NO amount, or one
   * that cannot be an amount. We will not claim an unverified receipt paid for
   * the order -- an unknown amount is not proof of the right amount.
   */
  PAYMENT_RECORDED_AMOUNT_UNVERIFIED:
    'Your payment was received and recorded, but the payment gateway did not give us a usable amount for it, so we have not confirmed the order yet. Our team is reviewing it and will contact you. Nothing has been refunded or charged again.',

  /**
   * A confirmed payment is NEVER rolled back. When the stock behind a paid
   * order cannot be moved, the order lands in a recorded, queryable state and
   * an operator (or the recovery worker, once stock returns) resolves it.
   */
  FULFILMENT_AWAITING_STOCK:
    'Your payment succeeded. One or more items are temporarily out of stock and your order is being processed manually.',
  FULFILMENT_PENDING: 'Your payment succeeded. Your order is being prepared.',

  /**
   * FINDING 1 -- THE ORDER IS PAID BUT WE WILL NOT SHIP IT YET.
   *
   * Every `success` receipt this order has carries an OPEN AMOUNT QUESTION, so
   * no payment authorizes consuming stock for it and `FulfilmentService` has
   * refused to. This population is the legacy rows written by the pre-fix
   * settle decision, which ignored the gateway amount.
   *
   * The customer must NOT be told their payment failed: it did not, the money
   * moved and is on our books with a `paid_at` from the database clock, and
   * nothing has been refunded or charged again. Nor may they be told the order
   * is on its way -- `FULFILMENT_PENDING` ("your order is being prepared") and
   * `PAYMENT_VERIFIED` would both be false about an order the system has just
   * declined to prepare, and that false reassurance is what this finding is
   * about. `PAYMENT_RECORDED_AMOUNT_MISMATCH` cannot be reused either: it says
   * the order was not confirmed, whereas this order IS recorded as paid.
   *
   * So it says the three true things: the payment is recorded, the order is on
   * hold rather than cancelled or failed, and a human is dealing with it.
   */
  FULFILMENT_RECONCILIATION_REQUIRED:
    'Your payment is recorded and nothing has been refunded or charged again. We have put this order on hold before dispatch because the amount our payment gateway reported for it needs to be checked against the order. Our team is reviewing it and will contact you.',

  RECOVERY_TRIGGERED: 'Fulfilment recovery pass completed',
} as const;
