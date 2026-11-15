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
   * CONTRACT FOR EVERY IMPLEMENTATION: never log, trace, or attach `code` to
   * an error, a metric or a span. An OTP in an application log is a one-line
   * account takeover for anyone with log access, and logs are routinely
   * shipped to third-party aggregators.
   */
  abstract send(mobile: string, code: string): Promise<void>;
}

/**
 * The default binding: no SMS gateway is integrated yet, so this records that a
 * code was ISSUED and drops the code itself.
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

    if (this.configService.get<string>('NODE_ENV') !== 'production') {
      this.logger.debug(`OTP issued for ${maskMobile(mobile)}`);
    }
    return Promise.resolve();
  }
}

/** `0912***67` — enough to correlate a support call, not enough to dial. */
export function maskMobile(mobile: string): string {
  return mobile.length <= 4
    ? '****'
    : `${mobile.slice(0, 4)}***${mobile.slice(-2)}`;
}
