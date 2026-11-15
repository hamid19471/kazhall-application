export enum PaymentStatusEnum {
  /** Attempt opened; the gateway has not told us anything yet. */
  PENDING = 'pending',
  /** The gateway confirmed this money AND it settled its order. */
  SUCCESS = 'success',
  /** The gateway told us this attempt was not paid, or it was abandoned. */
  FAILED = 'failed',
  REFUNDED = 'refunded',
  /**
   * THE GATEWAY CONFIRMED THIS MONEY, BUT IT IS NOT THE PAYMENT THAT SETTLED
   * THE ORDER.
   *
   * Real money moved. It just did not (and must not) settle the order, because
   * another attempt already did, or because the order was no longer payable
   * (canceled, already shipped, refunded...). Three concerns used to be fused
   * into one flag here and the losing attempt was left `pending`, which claimed
   * the customer had not paid and let `Start()` later expire the row to
   * `failed` — destroying the only local record of a real receipt.
   *
   * This state exists to keep those three concerns apart:
   *   1. gateway confirmation  -> ALWAYS persisted (`success` or this)
   *   2. reconciliation        -> `requires_reconciliation` + a reason; NO
   *                               automatic financial action is ever taken
   *   3. exactly-once fulfilment -> enforced at the order/fulfilment layer by
   *                               FulfilmentService's claim, never by hiding
   *                               money as `pending`
   *
   * It is deliberately NOT `success`, so the partial unique index
   * `uq_payment_one_success_per_order` still allows exactly one settling
   * payment per order. It is terminal for the automatic system: only a human
   * reconciliation decision moves it (e.g. to `refunded`).
   */
  CONFIRMED_UNAPPLIED = 'confirmed_unapplied',
}

/**
 * Why a confirmed receipt needs a human. Mirrors the CHECK constraint
 * `ck_payment_reconciliation_reason` — created by migration 0010 and REBUILT by
 * migration 0016, which added the two amount-verification reasons below.
 *
 * ==========================================================================
 * PRECEDENCE — WHICH FACT WINS WHEN SEVERAL APPLY
 * ==========================================================================
 * A receipt is stamped with exactly ONE reason, chosen in this order:
 *
 *   1. AMOUNT_MISMATCH             \
 *   2. AMOUNT_INVALID               >  the AMOUNT-VERIFICATION facts
 *   3. AMOUNT_MISSING              /
 *   4. DUPLICATE_CONFIRMED
 *   5. ORDER_NOT_PAYABLE
 *   6. LATE_CONFIRMATION_UNAPPLIED
 *   7. LATE_CONFIRMATION_APPLIED   (informational, only ever on a receipt that
 *                                   DID settle its order)
 *
 * WHY THE AMOUNT FACTS COME FIRST. Until the amount question is answered an
 * operator cannot decide what the receipt is even worth, so it is the first
 * thing they have to act on — a duplicate of a known sum and a duplicate of an
 * unknown sum are different problems. This is the same rule the module always
 * documented ("the most specific financial discrepancy wins"), extended to the
 * two new facts.
 *
 * WHY THE THREE AMOUNT REASONS ARE ORDERED AT ALL. They are mutually exclusive
 * by construction (see `verifyGatewayAmount` in amount-verification.ts): a
 * reported amount is either absent, or unusable, or usable-and-unequal, never
 * two of those. The ordering exists so the documented precedence is total, and
 * it runs from most to least specific: two known figures that differ, then a
 * figure we cannot use, then no figure at all.
 */
export enum PaymentReconciliationReason {
  /** Another attempt for this order already reached `success`. */
  DUPLICATE_CONFIRMED = 'duplicate_confirmed',
  /** The order was not in a payable state when the receipt was confirmed. */
  ORDER_NOT_PAYABLE = 'order_not_payable',
  /**
   * The attempt had already been written off as `failed` when the gateway
   * confirmed it, and the provisional late-payment policy is OFF, so the
   * receipt was recorded but NOT applied to the order. See provisional-policy.ts.
   */
  LATE_CONFIRMATION_UNAPPLIED = 'late_confirmation_unapplied',
  /**
   * Informational (`requires_reconciliation = false`): a written-off attempt
   * was confirmed late and the PROVISIONAL policy applied it to a still-payable
   * order. The books balance; the flag exists so the decision is auditable.
   */
  LATE_CONFIRMATION_APPLIED = 'late_confirmation_applied',
  /**
   * The gateway reported a USABLE amount that is not the amount we asked for:
   * an over- or underpayment. `payment.amount` (ours) and
   * `payment.gateway_amount` (theirs) are both kept, so the direction and the
   * size of the discrepancy are derivable; neither is ever overwritten.
   *
   * This reason NO LONGER appears on a `success` row. Before migration 0016 the
   * service computed the mismatch and then left it out of the settle decision,
   * so a discrepant receipt settled the order, flipped it to PAID and let phase
   * 2 ship the goods; the flag was only found afterwards. A discrepant receipt
   * is now `confirmed_unapplied` and settles nothing.
   */
  AMOUNT_MISMATCH = 'amount_mismatch',
  /**
   * THE GATEWAY DID NOT TELL US AN AMOUNT (`GatewayVerifyResult.amount` was
   * `undefined` or `null` — a reachable state of that interface, not a
   * theoretical one).
   *
   * Kept separate from AMOUNT_MISMATCH on purpose. The previous expression was
   * `gatewayAmount !== null && gatewayAmount !== ours`, which made a MISSING
   * amount evaluate to "no mismatch" — i.e. silence from the gateway was
   * treated as proven equality. It is the opposite: nothing has been verified,
   * so nothing may be settled.
   */
  AMOUNT_MISSING = 'amount_missing',
  /**
   * The gateway reported something it calls an amount that cannot be an amount:
   * not a finite number, negative, or not a whole number (money is INTEGER
   * RIAL end to end — docs/ARCHITECTURE.md section 0).
   *
   * The verbatim figure is preserved in `payment.gateway_amount_raw` (varchar),
   * because it cannot be stored in the `bigint` `gateway_amount` column and
   * dropping it would destroy the only evidence of what the gateway said.
   */
  AMOUNT_INVALID = 'amount_invalid',
}

/**
 * The reasons that mean "we could not verify this receipt's amount, so it
 * settled nothing". Grouped because callers (the re-verification report, the
 * customer-facing message, the operator query) treat them as one class.
 */
export const AMOUNT_RECONCILIATION_REASONS: readonly PaymentReconciliationReason[] =
  [
    PaymentReconciliationReason.AMOUNT_MISMATCH,
    PaymentReconciliationReason.AMOUNT_MISSING,
    PaymentReconciliationReason.AMOUNT_INVALID,
  ];

export function isAmountReconciliationReason(
  reason: PaymentReconciliationReason | null | undefined,
): boolean {
  return (
    reason !== null &&
    reason !== undefined &&
    AMOUNT_RECONCILIATION_REASONS.includes(reason)
  );
}
