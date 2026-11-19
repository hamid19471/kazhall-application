import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { LoggingOtpSender, OtpDeliveryError } from './otp-sender';

/**
 * The `log` driver. In production it must NEVER report success — it delivers
 * nothing — so it stays usable only as an explicit "SMS login off" rollback.
 */
describe('LoggingOtpSender', () => {
  const MOBILE = '09121234567';
  const CODE = '583920';
  let logged: unknown[][];

  const sender = (nodeEnv: string) =>
    new LoggingOtpSender({
      get: (key: string) => (key === 'NODE_ENV' ? nodeEnv : undefined),
    } as unknown as ConfigService);

  beforeEach(() => {
    logged = [];
    for (const method of ['log', 'warn', 'error', 'debug'] as const) {
      jest
        .spyOn(Logger.prototype, method)
        .mockImplementation((...args: unknown[]) => {
          logged.push(args);
        });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it('in production, rejects every send as NOT_SENT / DRIVER_DISABLED', async () => {
    const error = await sender('production')
      .send(MOBILE, CODE)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OtpDeliveryError);
    expect(error).toMatchObject({
      outcome: 'NOT_SENT',
      reason: 'DRIVER_DISABLED',
    });
    expect(JSON.stringify(logged)).toContain('reason=DRIVER_DISABLED');
    expect(JSON.stringify(logged)).not.toContain(CODE);
    expect(JSON.stringify(logged)).not.toContain(MOBILE);
  });

  it.each(['development', 'test'])(
    'in %s, resolves and logs only a masked "issued" line',
    async (nodeEnv) => {
      await expect(sender(nodeEnv).send(MOBILE, CODE)).resolves.toBeUndefined();
      expect(JSON.stringify(logged)).toContain('0912***67');
      expect(JSON.stringify(logged)).not.toContain(CODE);
      expect(JSON.stringify(logged)).not.toContain(MOBILE);
    },
  );
});
