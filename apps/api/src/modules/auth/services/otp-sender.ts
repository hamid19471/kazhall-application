import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * ===========================================================================
 * OtpSender — the SMS delivery port
 * ===========================================================================
 *
 * WHY THIS EXISTS AS AN INJECTABLE SEAM RATHER THAN A CALL SITE.
 *
 * Delivery used to be two commented-out lines inside `AuthService.sendOtp`
 * (`// return this.smsService.sendSms(mobile, otp)`), which means the one place
 * where the PLAINTEXT CODE is handled had no owner, no contract and no
 * defined logging behaviour — and a commented-out call is not a design, it is a
 * TODO in the position of a security boundary.
 *
 * Making it a port with an abstract class as its DI token fixes three things at
 * once:
 *
 *   1. THE PLAINTEXT CODE HAS EXACTLY ONE EXIT PATH. `OtpService` hands the
 *      code to `send()` and to nothing else, so "does the OTP ever reach a
 *      log, a metric or an error report?" is answerable by reading one class
 *      instead of auditing a whole service.
 *   2. THE REAL SMS GATEWAY DROPS IN WITHOUT TOUCHING OTP LOGIC. Provide a
 *      different implementation in `auth.module.ts`; the cooldown, the rate
 *      limits, the attempt bound and the consumption semantics are untouched.
 *   3. THE INTEGRATION SUITE CAN TEST THE REAL FLOW HONESTLY. A test cannot
 *      know a correct code otherwise, and the alternatives are all worse: a
 *      production back door that returns the code (never), weakening the hash
 *      (never), or brute-forcing 10^6 HMACs per assertion (slow and it proves
 *      less). Overriding a provider is the framework's own mechanism and
 *      changes NO production behaviour — the default implementation below is
 *      what runs everywhere else.
 *
 * This is NOT a test-only affordance: it is the production delivery boundary,
 * and it is exercised in production by whichever implementation is bound.
 */
export abstract class OtpSender {
  /**
   * Delivers `code` to `mobile`. `mobile` is always the normalized
   * `09XXXXXXXXX` form.
   *
   * A rejection propagates to the caller as a 5xx: the challenge has already
   * been issued at that point, so the caller must be told the SMS did not go
   * out rather than being shown "code sent".
   *
   * Implementations SHOULD reject with an {@link OtpDeliveryError} so that
   * `OtpService` can tell a definitive "not sent" (the challenge and its resend
   * cooldown are released) from an ambiguous outcome (both are kept). Any other
   * rejection is treated as ambiguous.
   *
   * CONTRACT FOR EVERY IMPLEMENTATION: never log, trace, or attach `code` to
   * an error, a metric or a span. An OTP in an application log is a one-line
   * account takeover for anyone with log access, and logs are routinely
   * shipped to third-party aggregators.
   */
  abstract send(mobile: string, code: string): Promise<void>;
}

/**
 * How sure the sender is that the SMS did NOT go out.
 *
 *   NOT_SENT  — proven: the request never reached the provider, or the provider
 *               explicitly refused it. Nothing can arrive on the phone.
 *   UNCERTAIN — the provider may have accepted it (timeout after the request was
 *               written, 5xx, unreadable answer). The SMS may still arrive.
 */
export type OtpDeliveryOutcome = 'NOT_SENT' | 'UNCERTAIN';

/**
 * The typed failure every `OtpSender` should reject with.
 *
 * `reason` and `providerStatus` are LOG-SAFE by construction: a short constant
 * and a provider's numeric status. Never put the code, the mobile number, an
 * endpoint URL or a provider response body in here.
 */
export class OtpDeliveryError extends Error {
  constructor(
    readonly outcome: OtpDeliveryOutcome,
    readonly reason: string,
    readonly providerStatus: number | null = null,
  ) {
    super(`OTP delivery ${outcome}: ${reason}`);
    this.name = 'OtpDeliveryError';
  }
}

/**
 * The `log` driver: delivers nothing. Outside production it records that a
 * code was ISSUED and drops the code itself (local development and review use
 * the review-login door or an overridden sender). In production it refuses —
 * see `send`.
 *
 * It is deliberately not a silent no-op — without the trace there is no way to
 * tell a delivery failure from a rate-limit refusal when a customer calls in —
 * and it is deliberately not a `logger.log` in production either: the mobile
 * number is personal data and a production log line per OTP is a slow leak of
 * who is signing in and when.
 */
@Injectable()
export class LoggingOtpSender extends OtpSender {
  private readonly logger = new Logger(LoggingOtpSender.name);

  constructor(private readonly configService: ConfigService) {
    super();
  }

  send(mobile: string, code: string): Promise<void> {
    // The ONLY reference to `code` in this class. It is discarded here; see
    // the contract on OtpSender.send.
    void code;

    // IN PRODUCTION THIS DRIVER NEVER REPORTS SUCCESS. It delivers nothing, so
    // answering "code sent" would strand every customer on a code that cannot
    // arrive. It stays selectable (`OTP_SMS_DRIVER=log`) only as an emergency
    // ROLLBACK that switches SMS login OFF without taking the API down: every
    // `send-otp` answers 503, the challenge is released by `OtpService` (no
    // live code, no 60s cooldown), the attempt still counts toward the hourly
    // per-number and per-IP limits, and admin/POS password login is unaffected.
    if (this.configService.get<string>('NODE_ENV') === 'production') {
      this.logger.warn(
        `event=otp_sms_delivery outcome=NOT_SENT reason=DRIVER_DISABLED mobile=${maskMobile(mobile)}`,
      );
      return Promise.reject(
        new OtpDeliveryError('NOT_SENT', 'DRIVER_DISABLED'),
      );
    }

    this.logger.debug(`OTP issued for ${maskMobile(mobile)}`);
    return Promise.resolve();
  }
}

/** `0912***67` — enough to correlate a support call, not enough to dial. */
export function maskMobile(mobile: string): string {
  return mobile.length <= 4
    ? '****'
    : `${mobile.slice(0, 4)}***${mobile.slice(-2)}`;
}
