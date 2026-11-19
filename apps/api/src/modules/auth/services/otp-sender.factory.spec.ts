import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { KavenegarOtpSender } from './kavenegar-otp-sender';
import { LoggingOtpSender } from './otp-sender';
import { createOtpSender } from './otp-sender.factory';

const FAKE_KEY = 'FAKE-KEY-not-a-real-kavenegar-key-0000';

const config = (values: Record<string, string | undefined>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

describe('createOtpSender', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keeps the existing LoggingOtpSender when OTP_SMS_DRIVER is unset', () => {
    expect(createOtpSender(config({ NODE_ENV: 'development' }))).toBeInstanceOf(
      LoggingOtpSender,
    );
  });

  it('reports at ERROR level at boot that production runs the log driver with OTP login disabled', () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const sender = createOtpSender(
      config({ NODE_ENV: 'production', OTP_SMS_DRIVER: 'log' }),
    );
    expect(sender).toBeInstanceOf(LoggingOtpSender);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('customer OTP login is DISABLED'),
    );
  });

  it('binds Kavenegar with only the lookup URL (template defaults to loginVerify)', () => {
    expect(
      createOtpSender(
        config({
          NODE_ENV: 'production',
          OTP_SMS_DRIVER: 'kavenegar',
          KAVENEGAR_LOOKUP_URL: `https://api.kavenegar.com/v1/${FAKE_KEY}/verify/lookup.json`,
        }),
      ),
    ).toBeInstanceOf(KavenegarOtpSender);
  });

  it('binds Kavenegar when selected and configured', () => {
    const sender = createOtpSender(
      config({
        NODE_ENV: 'production',
        OTP_SMS_DRIVER: 'kavenegar',
        KAVENEGAR_LOOKUP_URL: `https://api.kavenegar.com/v1/${FAKE_KEY}/verify/lookup.json`,
        KAVENEGAR_OTP_TEMPLATE: 'kazhalLoginVerify',
      }),
    );
    expect(sender).toBeInstanceOf(KavenegarOtpSender);
  });

  it('fails closed instead of falling back when Kavenegar is selected but incomplete', () => {
    expect(() =>
      createOtpSender(
        config({ NODE_ENV: 'production', OTP_SMS_DRIVER: 'kavenegar' }),
      ),
    ).toThrow(/KAVENEGAR_LOOKUP_URL is MISSING/);
  });
});
