import { toRialBigInt } from 'src/common/money/rial';
import { PaymentReconciliationReason } from './enums/payment-status-enum';

/**
 * ============================================================================
 * AMOUNT VERIFICATION — "is this receipt for the sum we asked for?"
 * ============================================================================
 *
 * WHAT WAS WRONG BEFORE
 * ---------------------
 * `PaymentService.runPhase1` computed
 *
 *     const amountMismatch =
 *       gatewayAmount !== null && gatewayAmount !== Number(payment.amount);
 *
 * and then LEFT IT OUT of the settle decision:
 *
 *     const settles = orderPayable && (!wasWrittenOff || lateConfirmationApplies);
 *
 * So a receipt whose gateway amount differed from ours still set
 * `payment.status = success`, flipped the order to PAID with
 * `fulfillmentState = pending`, and phase 2 then consumed stock and shipped
 * goods. The discrepancy was recorded via `requires_reconciliation`, but by the
 * time an operator looked, the goods were gone. Recording a problem is not the
 * same as refusing to act on it.
 *
 * The same expression was wrong a second time: `gatewayAmount === null` — the
 * gateway reporting NO amount — yielded `amountMismatch = false`, i.e. an
 * UNKNOWN amount was silently treated as PROVEN EQUALITY.
 * `GatewayVerifyResult.amount` is `number | null | undefined`, so that is a
 * reachable state of the interface, not a theoretical one.
 *
 * THE RULE THIS FILE ENCODES
 * --------------------------
 * A receipt's amount is VERIFIED only when the gateway's figure is
 *
 *   PRESENT  — the gateway actually told us a number,
 *   VALID    — finite, non-negative and whole (money is INTEGER RIAL end to
 *              end; docs/ARCHITECTURE.md section 0), and
 *   EQUAL    — exactly the figure we recorded on the payment row.
 *
 * Anything else is a fact to record, never a receipt to act on. The three
 * failure modes are kept APART rather than lumped into "mismatch", because they
 * need different operator responses: chase the customer's bank for a
 * difference, chase the gateway integration for an unusable figure, chase the
 * gateway's settlement report for a silent one.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ---------------------------------------
 * It never adjusts a stored amount, never rescales anything (there is no
 * Rial/Toman conversion anywhere in this module and adding one here would be
 * how one gets reintroduced), and never decides a financial remedy. It answers
 * one question and returns the facts to persist.
 * ============================================================================
 */

/** Bounds `gateway_amount_raw` so an absurd gateway payload cannot bloat rows. */
export const GATEWAY_AMOUNT_RAW_MAX_LENGTH = 64;

export interface AmountVerification {
  /**
   * True ONLY when the gateway's amount is present, valid and equal to ours.
   * This is the value that participates in the settle decision; there is no
   * other way to reach `PaymentStatusEnum.SUCCESS`.
   */
  verified: boolean;
  /** `null` exactly when `verified` is true. */
  reason: PaymentReconciliationReason | null;
  /**
   * INTEGER RIAL to store in `payment.gateway_amount` (`bigint`). `null` when
   * the gateway reported nothing, or reported something that is not a storable
   * integer Rial amount.
   */
  gatewayAmount: number | null;
  /**
   * The verbatim figure, kept as TEXT when it could not go in the `bigint`
   * column. This is the only surviving evidence of what an unusable gateway
   * response actually said, so it is preserved rather than discarded.
   */
  gatewayAmountRaw: string | null;
}

function raw(value: unknown): string {
  return String(value).slice(0, GATEWAY_AMOUNT_RAW_MAX_LENGTH);
}

/**
 * Compares the gateway's reported amount with the amount WE asked for.
 *
 * `expected` is accepted as `string | number` because it is read straight out
 * of the `bigint` `payment.amount` column, which node-postgres hands back as a
 * string.
 *
 * A pure function on purpose: the settle decision is the single most
 * consequential branch in this module, and it is worth being able to test it
 * exhaustively without a database or a gateway.
 */
export function verifyGatewayAmount(
  expected: string | number,
  reported: number | null | undefined,
): AmountVerification {
  // 1. ABSENT. The gateway did not tell us. Nothing is verified, and silence is
  //    emphatically not equality — that conflation was half of the defect.
  if (reported === undefined || reported === null) {
    return {
      verified: false,
      reason: PaymentReconciliationReason.AMOUNT_MISSING,
      gatewayAmount: null,
      gatewayAmountRaw: null,
    };
  }

  // 2. PRESENT BUT UNUSABLE. NaN, Infinity, a negative sum, a fractional one
  //    (money is INTEGER RIAL; a fraction means we are talking about a
  //    different unit than the gateway is), or one too large to state exactly.
  //    `Number()` is applied rather than trusted from the type: this value
  //    crosses an HTTP boundary in the real Zibal driver and TypeScript cannot
  //    enforce anything about it there.
  //
  //    `Number.isSafeInteger` REPLACES `isFinite && isInteger`, which passed
  //    every integer above 2^53. Such a value is not a fact about the gateway's
  //    figure at all — it is whatever the JSON parser rounded that figure TO,
  //    so comparing it against ours in step 4 would compare two guesses. It is
  //    also written straight to `payment.gateway_amount`, a `bigint` column, so
  //    the old check let a rounded number become the permanent record of what
  //    the gateway said. Now it is UNUSABLE, and `gatewayAmountRaw` keeps the
  //    verbatim text — which is the only accurate evidence available.
  const value = Number(reported);
  if (!Number.isSafeInteger(value) || value < 0) {
    return {
      verified: false,
      reason: PaymentReconciliationReason.AMOUNT_INVALID,
      gatewayAmount: null,
      gatewayAmountRaw: raw(reported),
    };
  }

  // 3. OUR OWN FIGURE UNUSABLE. `payment.amount` is `bigint NOT NULL`, so this
  //    is defence in depth rather than a reachable state. It is handled as
  //    UNVERIFIABLE and never as equality: if we cannot state what we asked
  //    for, we certainly cannot claim the gateway paid it.
  //
  //    PARSED AS A BigInt, NOT WITH `Number()`. `expected` arrives as the TEXT
  //    of a `bigint` column, and `Number("9007199254740993")` is
  //    9007199254740992 — a perfectly ordinary safe integer, so no amount of
  //    `isSafeInteger`-ing the RESULT can detect the digit that was lost. The
  //    old code would then have compared the gateway's figure against a number
  //    we never asked for, and a one-Rial underpayment would have verified.
  let expectedRial: bigint;
  try {
    expectedRial = toRialBigInt(expected);
  } catch {
    return {
      verified: false,
      reason: PaymentReconciliationReason.AMOUNT_INVALID,
      gatewayAmount: value,
      gatewayAmountRaw: raw(`expected=${String(expected)}`),
    };
  }

  // 4. BOTH FIGURES KNOWN AND DIFFERENT: an over- or underpayment. Both are
  //    kept side by side; NEITHER is adjusted to make the other fit. Compared
  //    in BigInt so the comparison is exact at any magnitude, even though
  //    `value` is already known to be a safe integer by this point.
  if (BigInt(value) !== expectedRial) {
    return {
      verified: false,
      reason: PaymentReconciliationReason.AMOUNT_MISMATCH,
      gatewayAmount: value,
      gatewayAmountRaw: null,
    };
  }

  return {
    verified: true,
    reason: null,
    gatewayAmount: value,
    gatewayAmountRaw: null,
  };
}
