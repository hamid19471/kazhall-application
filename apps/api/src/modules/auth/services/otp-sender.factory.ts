import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { KavenegarOtpSender } from './kavenegar-otp-sender';
import { resolveOtpSmsConfig } from './kavenegar.config';
import { LoggingOtpSender, OtpSender } from './otp-sender';

/**
 * Picks the `OtpSender` binding from `OTP_SMS_DRIVER`.
 *
 *   unset / `log` → LoggingOtpSender (unchanged default: nothing is sent)
 *   `kavenegar`   → KavenegarOtpSender
 *
 * A request for Kavenegar with an invalid configuration THROWS (naming the
 * variables, never their values) rather than silently falling back to a sender
 * that delivers nothing. `validateEnv` has normally refused to boot already.
 */
export function createOtpSender(configService: ConfigService): OtpSender {
  const env = {
    NODE_ENV: configService.get<string>('NODE_ENV'),
    OTP_SMS_DRIVER: configService.get<string>('OTP_SMS_DRIVER'),
    KAVENEGAR_LOOKUP_URL: configService.get<string>('KAVENEGAR_LOOKUP_URL'),
    KAVENEGAR_OTP_TEMPLATE: configService.get<string>('KAVENEGAR_OTP_TEMPLATE'),
  };

  const resolved = resolveOtpSmsConfig(env);
  if (resolved.ok && resolved.config.driver === 'log') {
    if (env.NODE_ENV === 'production') {
      // Not a silent no-op: in production LoggingOtpSender answers every
      // send with NOT_SENT (503), so customer SMS login is OFF. Said loudly at
      // boot so a rollback to this driver is never mistaken for a working one.
      new Logger('OtpSender').error(
        'event=sms_provider_config driver=log — customer OTP login is DISABLED: every send-otp answers 503 OTP_DELIVERY_FAILED. Set OTP_SMS_DRIVER=kavenegar to enable SMS delivery.',
      );
    }
    return new LoggingOtpSender(configService);
  }

  return new KavenegarOtpSender(env);
}
