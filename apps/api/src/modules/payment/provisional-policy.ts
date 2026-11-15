import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * ============================================================================
 * PROVISIONAL, OWNER-UNAPPROVED PAYMENT POLICY — ISOLATED ON PURPOSE
 * ============================================================================
 *
 * Everything in this file encodes a BUSINESS decision that the owner has NOT
 * approved. It lives in its own named provider so that:
 *
 *   - nothing else in the payment module has to guess at policy,
 *   - the whole thing can be deleted or replaced in one place once the owner
 *     answers, and
 *   - it CANNOT be switched on in production by accident.
 *
 * THE ONE POLICY QUESTION THIS COVERS
 * -----------------------------------
 * LATE CONFIRMATION. `Start()` writes an abandoned attempt off as `failed`
 * after `PAYMENT_PENDING_REUSE_MS`. The gateway may confirm that attempt
 * afterwards anyway. The money is real either way and is ALWAYS recorded (see
 * PaymentStatusEnum.CONFIRMED_UNAPPLIED) — that part is a fact, not a policy.
 *
 * What is a policy is whether a late receipt may SETTLE an order we had already
 * written off:
 *
 *   OFF (the default, and the only behaviour allowed in production):
 *       the receipt is recorded `confirmed_unapplied` with
 *       `requires_reconciliation = true`, reason `late_confirmation_unapplied`.
 *       The order is NOT moved to PAID. No refund, no credit, no automatic
 *       financial action of any kind. A human decides.
 *
 *   ON (development / staging / explicitly acknowledged only):
 *       if the order is STILL payable (status `pending`) the receipt settles it
 *       exactly as a timely confirmation would, and is marked
 *       `late_confirmation_applied` for the audit trail. If the order is no
 *       longer payable the OFF behaviour applies regardless.
 *
 * NOT COVERED HERE: `ORDER_ALLOCATION_TTL_MS` (the 30-minute order-allocation
 * timeout) is equally unapproved but lives in the INVENTORY workstream's
 * configuration, which this workstream does not own. Reported to the lead so
 * both provisional knobs can be tracked together.
 *
 * PRODUCTION SAFETY: with `NODE_ENV=production`, enabling the policy requires
 * BOTH `PAYMENT_LATE_CONFIRMATION_APPLIES=true` AND the explicit
 * acknowledgement `PROVISIONAL_PAYMENT_POLICY_ACK=i-accept-unapproved-policy`.
 * Without the acknowledgement the flag is REFUSED and an error is logged on
 * every evaluation, rather than being quietly honoured.
 * ============================================================================
 */
export const PROVISIONAL_POLICY_ACK_VALUE = 'i-accept-unapproved-policy';

@Injectable()
export class ProvisionalPaymentPolicy {
  private readonly logger = new Logger(ProvisionalPaymentPolicy.name);
  /** One log line per process per state change, not one per payment. */
  private lastAnnounced: string | null = null;

  constructor(private readonly configService: ConfigService) {}

  private flag(key: string): boolean {
    const raw = this.configService.get<string>(key);
    return raw === 'true' || raw === '1';
  }

  /**
   * May a gateway confirmation of an attempt we had already written off as
   * `failed` settle a still-payable order?
   *
   * Returns false unless the flag is set AND (we are outside production OR the
   * explicit acknowledgement is present).
   */
  get lateConfirmationSettlesOrder(): boolean {
    const requested = this.flag('PAYMENT_LATE_CONFIRMATION_APPLIES');
    if (!requested) {
      this.announce(
        'off',
        () =>
          'PROVISIONAL late-payment policy is OFF: a late gateway confirmation ' +
          'is recorded as confirmed_unapplied and flagged for reconciliation. ' +
          'No order is settled and no money is moved automatically.',
      );
      return false;
    }

    const isProduction = process.env.NODE_ENV === 'production';
    const acknowledged =
      this.configService.get<string>('PROVISIONAL_PAYMENT_POLICY_ACK') ===
      PROVISIONAL_POLICY_ACK_VALUE;

    if (isProduction && !acknowledged) {
      // Loud, every time. A refused policy that logs once would be invisible in
      // the log volume of a real deployment.
      this.logger.error(
        'REFUSING to enable the PROVISIONAL late-payment policy: ' +
          'PAYMENT_LATE_CONFIRMATION_APPLIES is set but NODE_ENV=production and ' +
          `PROVISIONAL_PAYMENT_POLICY_ACK is not "${PROVISIONAL_POLICY_ACK_VALUE}". ` +
          'This behaviour is NOT approved by the owner. Late confirmations will be ' +
          'recorded as confirmed_unapplied and left for manual reconciliation.',
      );
      return false;
    }

    this.announce(
      isProduction ? 'on-production-acknowledged' : 'on',
      () =>
        'PROVISIONAL, OWNER-UNAPPROVED late-payment policy is ACTIVE: a gateway ' +
        'confirmation arriving after the attempt was written off WILL settle a ' +
        'still-payable order. ' +
        (isProduction
          ? 'Running in PRODUCTION under an explicit acknowledgement.'
          : `NODE_ENV=${process.env.NODE_ENV ?? 'undefined'}.`),
    );
    return true;
  }

  private announce(state: string, message: () => string): void {
    if (this.lastAnnounced === state) return;
    this.lastAnnounced = state;
    if (state === 'off') this.logger.log(message());
    else this.logger.warn(message());
  }
}
