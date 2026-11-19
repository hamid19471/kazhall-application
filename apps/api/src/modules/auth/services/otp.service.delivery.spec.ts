import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AuthMessages } from 'src/common/constants/auth.messages';
import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import type { RedisService } from 'src/database/redis.service';
import type { OtpChallenge } from '../entities/otp-challenge.entity';
import {
  OTP_CODE_LENGTH,
  OTP_MAX_SENDS_PER_IP,
  OTP_MAX_SENDS_PER_MOBILE,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_SECONDS,
} from '../otp.policy';
import { OtpDeliveryError, OtpSender } from './otp-sender';
import {
  OTP_ERROR_DELIVERY_FAILED,
  OTP_ERROR_DELIVERY_UNCERTAIN,
  OtpService,
} from './otp.service';

/**
 * Unit coverage of how `OtpService.issue` drives the delivery port. The
 * database-level behaviour of the cooldown, the send windows, expiry and
 * attempt bounds is proven end to end in
 * `test/integration/otp-hardening.int-spec.ts`; this file pins the contract
 * between those controls and whichever `OtpSender` is bound (Kavenegar in
 * production), with the database and Redis mocked.
 */
describe('OtpService → OtpSender', () => {
  const MOBILE = '09121234567';
  const IP = '203.0.113.7';

  let query: jest.Mock;
  let incrWithExpiry: jest.Mock;
  let send: jest.Mock;
  let service: OtpService;

  beforeEach(() => {
    query = jest.fn();
    incrWithExpiry = jest
      .fn()
      .mockResolvedValue({ count: 1, ttlSeconds: 3600 });
    send = jest.fn().mockResolvedValue(undefined);

    const sender = { send } as unknown as OtpSender;
    const config = {
      get: jest.fn(),
      getOrThrow: jest.fn().mockReturnValue('unit-test-hmac-secret-0123456789'),
    } as unknown as ConfigService;

    service = new OtpService(
      { query } as unknown as Repository<OtpChallenge>,
      config,
      { incrWithExpiry } as unknown as RedisService,
      sender,
    );
  });

  const issuedRow = () => [{ id: 1, expiresAt: new Date(), sendCount: 1 }];

  it('hands the normalized mobile and a fresh numeric code to the sender exactly once', async () => {
    query.mockResolvedValueOnce(issuedRow());

    await service.issue('+98 912 123 4567', IP);

    expect(send).toHaveBeenCalledTimes(1);
    const [mobile, code] = send.mock.calls[0] as [string, string];
    expect(mobile).toBe(MOBILE);
    expect(code).toMatch(new RegExp(`^\\d{${OTP_CODE_LENGTH}}$`));
  });

  it('issues with the unchanged TTL, cooldown and per-mobile limit', async () => {
    query.mockResolvedValueOnce(issuedRow());

    await service.issue(MOBILE, IP);

    const params = query.mock.calls[0][1] as unknown[];
    expect(params).toContain(OTP_TTL_SECONDS);
    expect(params).toContain(OTP_RESEND_COOLDOWN_SECONDS);
    expect(params).toContain(OTP_MAX_SENDS_PER_MOBILE);
    // Only the HMAC goes to the database, never the plaintext code.
    const code = send.mock.calls[0][1] as string;
    expect(params).not.toContain(code);
  });

  describe('delivery failures', () => {
    const issueAndFail = async (failure: unknown) => {
      query.mockResolvedValueOnce(issuedRow());
      send.mockRejectedValueOnce(failure);
      const error = (await service
        .issue(MOBILE, IP)
        .catch((e: unknown) => e)) as HttpException;
      const issuedHash = (query.mock.calls[0][1] as unknown[])[1];
      return { error, issuedHash };
    };

    it('NOT_SENT + exactly one row released: code expired, cooldown lifted, 503 retryAfterSeconds=0', async () => {
      query
        .mockResolvedValueOnce(issuedRow())
        .mockResolvedValueOnce([{ id: 1 }]); // CTE: the released row
      send.mockRejectedValueOnce(
        new OtpDeliveryError('NOT_SENT', 'PROVIDER_REJECTED', 411),
      );

      const error = (await service
        .issue(MOBILE, IP)
        .catch((e: unknown) => e)) as HttpException;
      const issuedHash = (query.mock.calls[0][1] as unknown[])[1];

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(error.getResponse()).toEqual({
        message: AuthMessages.OTP_DELIVERY_FAILED,
        error: OTP_ERROR_DELIVERY_FAILED,
        retryAfterSeconds: 0,
      });

      expect(query).toHaveBeenCalledTimes(2);
      const [sql, params] = query.mock.calls[1] as [string, unknown[]];
      // Read through a CTE so the result is a row list, never TypeORM's
      // `[rows, rowCount]` UPDATE shape.
      expect(sql).toMatch(/WITH released AS \(\s*UPDATE "otp_challenges"/);
      expect(sql).toMatch(/RETURNING "id"/);
      expect(sql).toMatch(/"expiresAt"\s*=\s*now\(\)/);
      expect(sql).toMatch(/"resendAvailableAt"\s*=\s*now\(\)/);
      // Guarded to the challenge this call issued, never a newer or used one.
      expect(sql).toMatch(/"codeHash" = \$2/);
      expect(sql).toMatch(/"consumedAt" IS NULL/);
      expect(params).toEqual([MOBILE, issuedHash]);
      // The send budget is NOT refunded: no counter is touched.
      expect(sql).not.toMatch(/sendCount|windowStartedAt|attempts/);
      expect(incrWithExpiry).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['zero rows (replaced or consumed meanwhile)', []],
      // What a BARE `UPDATE` returns through TypeORM's postgres driver. Must
      // never be read as "released", whatever its rowCount says.
      ["TypeORM's bare-UPDATE shape [rows, rowCount]", [[], 1]],
      ['an unexpected non-array', { rowCount: 1 }],
      ['more than one row', [{ id: 1 }, { id: 2 }]],
    ])(
      'NOT_SENT + %s: never advertises an immediate resend; reports the real cooldown',
      async (_label, releaseResult) => {
        query
          .mockResolvedValueOnce(issuedRow())
          .mockResolvedValueOnce(releaseResult)
          .mockResolvedValueOnce([{ cooldownSeconds: 57 }]);
        send.mockRejectedValueOnce(new OtpDeliveryError('NOT_SENT', 'X'));

        const error = (await service
          .issue(MOBILE, IP)
          .catch((e: unknown) => e)) as HttpException;

        // Delivery fact unchanged (it was NOT sent), resend fact honest.
        expect(error.getResponse()).toEqual({
          message: AuthMessages.OTP_DELIVERY_FAILED,
          error: OTP_ERROR_DELIVERY_FAILED,
          retryAfterSeconds: 57,
        });
        expect(query.mock.calls[2][0]).toMatch(/SELECT GREATEST/);
      },
    );

    it('NOT_SENT, not released, and the row reports no cooldown left: still never 0', async () => {
      query
        .mockResolvedValueOnce(issuedRow())
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ cooldownSeconds: 0 }]);
      send.mockRejectedValueOnce(new OtpDeliveryError('NOT_SENT', 'X'));

      const error = (await service
        .issue(MOBILE, IP)
        .catch((e: unknown) => e)) as HttpException;
      expect(error.getResponse()).toMatchObject({ retryAfterSeconds: 1 });
    });

    it.each([
      ['UNCERTAIN', new OtpDeliveryError('UNCERTAIN', 'TIMEOUT')],
      ['an untyped error', new Error('boom')],
      ['a NestJS HTTP exception', new ServiceUnavailableException()],
    ])(
      '%s: keeps the code and the cooldown, answers 503 with the cooldown',
      async (_label, failure) => {
        const { error } = await issueAndFail(failure);

        expect(error).toBeInstanceOf(ServiceUnavailableException);
        expect(error.getResponse()).toEqual({
          message: AuthMessages.OTP_DELIVERY_UNCERTAIN,
          error: OTP_ERROR_DELIVERY_UNCERTAIN,
          retryAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS,
        });
        // Only the issuing upsert ran — nothing was released.
        expect(query).toHaveBeenCalledTimes(1);
      },
    );

    it.each([
      ['the cooldown read succeeds', [{ cooldownSeconds: 44 }], 44],
      [
        'the cooldown read also fails',
        new Error('still down'),
        OTP_RESEND_COOLDOWN_SECONDS,
      ],
    ])(
      'NOT_SENT but the release statement throws and %s: OTP_DELIVERY_FAILED with a real wait',
      async (_label, readResult, expectedWait) => {
        query
          .mockResolvedValueOnce(issuedRow())
          .mockRejectedValueOnce(new Error('connection lost'));
        if (readResult instanceof Error)
          query.mockRejectedValueOnce(readResult);
        else query.mockResolvedValueOnce(readResult);
        send.mockRejectedValueOnce(new OtpDeliveryError('NOT_SENT', 'X'));
        const warn = jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined);

        const error = (await service
          .issue(MOBILE, IP)
          .catch((e: unknown) => e)) as HttpException;

        expect(error.getResponse()).toEqual({
          message: AuthMessages.OTP_DELIVERY_FAILED,
          error: OTP_ERROR_DELIVERY_FAILED,
          retryAfterSeconds: expectedWait,
        });
        expect(JSON.stringify(warn.mock.calls)).toContain(
          'outcome=failed mobile=0912***67',
        );
        expect(JSON.stringify(warn.mock.calls)).not.toContain(MOBILE);
        warn.mockRestore();
      },
    );

    it('never puts the plaintext code in the response or the logs', async () => {
      const logged: unknown[][] = [];
      for (const method of ['log', 'warn', 'error', 'debug'] as const) {
        jest
          .spyOn(Logger.prototype, method)
          .mockImplementation((...args: unknown[]) => {
            logged.push(args);
          });
      }
      query
        .mockResolvedValueOnce(issuedRow())
        .mockRejectedValueOnce(new Error('release failed'));
      send.mockRejectedValueOnce(new OtpDeliveryError('NOT_SENT', 'X'));

      const error = (await service
        .issue(MOBILE, IP)
        .catch((e: unknown) => e)) as HttpException;
      const code = send.mock.calls[0][1] as string;

      expect(JSON.stringify(error.getResponse())).not.toContain(code);
      expect(JSON.stringify(logged)).not.toContain(code);
      jest.restoreAllMocks();
    });
  });

  it('does not call the sender when the resend cooldown refuses', async () => {
    query
      .mockResolvedValueOnce([]) // guarded upsert declined
      .mockResolvedValueOnce([{ cooldownSeconds: 42, windowSeconds: 3000 }]);

    const error = (await service
      .issue(MOBILE, IP)
      .catch((e: unknown) => e)) as HttpException;

    expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(error.getResponse()).toMatchObject({
      error: 'OTP_COOLDOWN',
      retryAfterSeconds: 42,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('does not call the sender when the per-mobile window is spent', async () => {
    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ cooldownSeconds: 0, windowSeconds: 1200 }]);

    const error = (await service
      .issue(MOBILE, IP)
      .catch((e: unknown) => e)) as HttpException;

    expect(error.getResponse()).toMatchObject({
      error: 'OTP_SEND_RATE_LIMITED',
      retryAfterSeconds: 1200,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('does not touch the database or the sender when the per-IP cap is exceeded', async () => {
    incrWithExpiry.mockResolvedValueOnce({
      count: OTP_MAX_SENDS_PER_IP + 1,
      ttlSeconds: 900,
    });

    const error = (await service
      .issue(MOBILE, IP)
      .catch((e: unknown) => e)) as HttpException;

    expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(query).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects an invalid phone number before any control or delivery', async () => {
    await expect(service.issue('12345', IP)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(incrWithExpiry).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
