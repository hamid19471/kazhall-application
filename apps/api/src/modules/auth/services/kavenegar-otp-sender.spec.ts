import { Logger } from '@nestjs/common';
import { KavenegarOtpSender, MAX_RESPONSE_BYTES } from './kavenegar-otp-sender';
import { KAVENEGAR_REQUEST_TIMEOUT_MS } from './kavenegar.config';
import { OtpDeliveryError } from './otp-sender';

/**
 * Every Kavenegar call here is MOCKED (`global.fetch`). No test in this file
 * can reach the network or send an SMS.
 */

const FAKE_KEY = 'FAKE-KEY-not-a-real-kavenegar-key-0000';
const LOOKUP_URL = `https://api.kavenegar.com/v1/${FAKE_KEY}/verify/lookup.json`;
const MOBILE = '09121234567';
const CODE = '483920';

const ENV = {
  NODE_ENV: 'production',
  OTP_SMS_DRIVER: 'kavenegar',
  KAVENEGAR_LOOKUP_URL: LOOKUP_URL,
};

const jsonResponse = (httpStatus: number, body: unknown): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: httpStatus,
    headers: { 'content-type': 'application/json' },
  });

const ACCEPTED = {
  return: { status: 200, message: 'تایید شد' },
  entries: [{ messageid: 8792343, status: 5, receptor: MOBILE }],
};

const refusal = (status: number, httpStatus = status) =>
  jsonResponse(httpStatus, { return: { status, message: 'x' }, entries: null });

/** A fetch rejection shaped like undici's: TypeError with `cause.code`. */
const socketError = (code: string) =>
  Object.assign(new TypeError(`fetch failed ${LOOKUP_URL}?token=${CODE}`), {
    cause: Object.assign(new Error(`${code} api.kavenegar.com`), { code }),
  });

describe('KavenegarOtpSender', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let logged: unknown[][];

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
    logged = [];
    for (const method of [
      'log',
      'warn',
      'error',
      'debug',
      'verbose',
    ] as const) {
      jest
        .spyOn(Logger.prototype, method)
        .mockImplementation((...args: unknown[]) => {
          logged.push(args);
        });
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  /** Nothing secret in any log line, whatever happened. */
  const expectNoLeak = () => {
    const text = JSON.stringify(logged);
    expect(text).not.toContain(CODE);
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain(MOBILE);
    expect(text).not.toContain('api.kavenegar.com');
  };

  const sendExpectingFailure = async (
    env: Record<string, unknown> = ENV,
    mobile = MOBILE,
    code = CODE,
  ): Promise<OtpDeliveryError> => {
    const error = await new KavenegarOtpSender(env)
      .send(mobile, code)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OtpDeliveryError);
    // The error itself must be as clean as the logs.
    const serialised = JSON.stringify({
      message: (error as Error).message,
      ...(error as object),
    });
    expect(serialised).not.toContain(CODE);
    expect(serialised).not.toContain(FAKE_KEY);
    return error as OtpDeliveryError;
  };

  describe('successful delivery', () => {
    it('calls the lookup endpoint once with receptor, token and the loginVerify template by default', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, ACCEPTED));

      await expect(
        new KavenegarOtpSender(ENV).send(MOBILE, CODE),
      ).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [target, init] = fetchMock.mock.calls[0];
      const url = target as URL;
      expect(url).toBeInstanceOf(URL);
      expect(`${url.origin}${url.pathname}`).toBe(LOOKUP_URL);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        receptor: MOBILE,
        token: CODE,
        template: 'loginVerify',
      });
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('manual');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(logged).toHaveLength(0);
    });

    it('sends a six-digit code with leading zeros intact as the single token', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, ACCEPTED));

      await new KavenegarOtpSender(ENV).send(MOBILE, '004821');

      const url = fetchMock.mock.calls[0][0] as URL;
      expect(url.searchParams.get('token')).toBe('004821');
      expect(url.searchParams.has('token2')).toBe(false);
      expect(url.searchParams.has('token3')).toBe(false);
    });

    it('uses KAVENEGAR_OTP_TEMPLATE when it is set', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, ACCEPTED));

      await new KavenegarOtpSender({
        ...ENV,
        KAVENEGAR_OTP_TEMPLATE: 'kazhalLoginVerify',
      }).send(MOBILE, CODE);

      const url = fetchMock.mock.calls[0][0] as URL;
      expect(url.searchParams.get('template')).toBe('kazhalLoginVerify');
    });
  });

  describe('definitive failures → NOT_SENT', () => {
    it.each([
      [
        'invalid receptor (411)',
        () => refusal(411, 400),
        'PROVIDER_REJECTED',
        411,
      ],
      [
        'template not found / not approved (424)',
        () => refusal(424, 400),
        'PROVIDER_REJECTED',
        424,
      ],
      ['invalid API key (403)', () => refusal(403), 'PROVIDER_REJECTED', 403],
      ['out of credit (418)', () => refusal(418), 'PROVIDER_REJECTED', 418],
      [
        'provider rate limit (451)',
        () => refusal(451),
        'PROVIDER_REJECTED',
        451,
      ],
      [
        'a refusal inside HTTP 200',
        () => refusal(424, 200),
        'PROVIDER_REJECTED',
        424,
      ],
      [
        'a 4xx with no readable body',
        () => jsonResponse(404, '<html/>'),
        'HTTP_STATUS',
        404,
      ],
      [
        'HTTP 429 with no readable body',
        () => jsonResponse(429, ''),
        'HTTP_STATUS',
        429,
      ],
      [
        'a redirect (never followed)',
        () => new Response(null, { status: 302 }),
        'HTTP_STATUS',
        302,
      ],
    ])('%s', async (_label, respond, reason, providerStatus) => {
      fetchMock.mockResolvedValue(respond());

      const error = await sendExpectingFailure();

      expect(error.outcome).toBe('NOT_SENT');
      expect(error.reason).toBe(reason);
      expect(error.providerStatus).toBe(providerStatus);
      expect(JSON.stringify(logged)).toContain(
        `outcome=NOT_SENT reason=${reason} providerStatus=${providerStatus} mobile=0912***67`,
      );
      expectNoLeak();
    });

    it.each([
      'ENOTFOUND',
      'EAI_AGAIN',
      'ECONNREFUSED',
      'EHOSTUNREACH',
      'UND_ERR_CONNECT_TIMEOUT',
      'CERT_HAS_EXPIRED',
    ])('a socket error that precedes the request (%s)', async (code) => {
      fetchMock.mockRejectedValue(socketError(code));

      const error = await sendExpectingFailure();

      expect(error.outcome).toBe('NOT_SENT');
      expect(error.reason).toBe(`NETWORK_${code}`);
      expectNoLeak();
    });

    it.each(['9121234567', '+989121234567', '0912123456', '', '0912 123 4567'])(
      'a non-normalized mobile %p, without calling the provider',
      async (mobile) => {
        const error = await sendExpectingFailure(ENV, mobile);
        expect(error.outcome).toBe('NOT_SENT');
        expect(error.reason).toBe('INVALID_RECEPTOR');
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it('a code that is not a short run of digits, without calling the provider', async () => {
      const error = await sendExpectingFailure(ENV, MOBILE, '12 34');
      expect(error.outcome).toBe('NOT_SENT');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('ambiguous failures → UNCERTAIN', () => {
    it.each([
      [
        'a 5xx with no readable body',
        () => jsonResponse(502, '<html>bad gateway</html>'),
        'HTTP_STATUS',
        502,
      ],
      [
        'a 2xx without return.status',
        () => jsonResponse(200, { entries: [] }),
        'MALFORMED_RESPONSE',
        200,
      ],
      [
        'an unparseable 2xx',
        () => jsonResponse(200, 'not json'),
        'MALFORMED_RESPONSE',
        200,
      ],
      [
        'an unrecognised provider status',
        () => refusal(999, 200),
        'UNKNOWN_PROVIDER_STATUS',
        999,
      ],
      [
        'status 200 in the body but a non-2xx HTTP status',
        () => jsonResponse(500, ACCEPTED),
        'INCONSISTENT_RESPONSE',
        500,
      ],
    ])('%s', async (_label, respond, reason, providerStatus) => {
      fetchMock.mockResolvedValue(respond());

      const error = await sendExpectingFailure();

      expect(error.outcome).toBe('UNCERTAIN');
      expect(error.reason).toBe(reason);
      expect(error.providerStatus).toBe(providerStatus);
      expectNoLeak();
    });

    it.each(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', ''])(
      'a socket error that may follow the request (%p)',
      async (code) => {
        fetchMock.mockRejectedValue(socketError(code));

        const error = await sendExpectingFailure();

        expect(error.outcome).toBe('UNCERTAIN');
        expect(error.reason).toBe('NETWORK');
        expectNoLeak();
      },
    );

    it('a body that fails to read after the headers arrived', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"ret'));
              controller.error(new Error('terminated'));
            },
          }),
          { status: 200 },
        ),
      );

      const error = await sendExpectingFailure();
      expect(error.outcome).toBe('UNCERTAIN');
      expect(error.reason).toBe('BODY_READ');
    });

    it(`our ${KAVENEGAR_REQUEST_TIMEOUT_MS}ms timeout`, async () => {
      jest.useFakeTimers();
      fetchMock.mockImplementation(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      );

      const pending = new KavenegarOtpSender(ENV)
        .send(MOBILE, CODE)
        .catch((e: unknown) => e);
      await jest.advanceTimersByTimeAsync(KAVENEGAR_REQUEST_TIMEOUT_MS);

      const error = (await pending) as OtpDeliveryError;
      expect(error).toBeInstanceOf(OtpDeliveryError);
      expect(error.outcome).toBe('UNCERTAIN');
      expect(error.reason).toBe('TIMEOUT');
      expectNoLeak();
    });

    it('never retries on its own (no idempotency key at the provider)', async () => {
      fetchMock.mockResolvedValue(jsonResponse(502, ''));

      await sendExpectingFailure();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('bounded response read', () => {
    /** A chunked body (no content-length) that counts how much was pulled. */
    const countingStream = (chunk: Uint8Array, chunks: number) => {
      const stats = { pulled: 0, cancelled: false };
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (stats.pulled >= chunks) return controller.close();
          stats.pulled += 1;
          controller.enqueue(chunk);
        },
        cancel() {
          stats.cancelled = true;
        },
      });
      return { stream, stats };
    };

    it('refuses a declared content-length over the limit without reading the body', async () => {
      const { stream, stats } = countingStream(new Uint8Array(1024), 1_000);
      fetchMock.mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
        }),
      );

      const error = await sendExpectingFailure();
      expect(error.outcome).toBe('UNCERTAIN');
      expect(error.reason).toBe('RESPONSE_TOO_LARGE');
      expect(stats.pulled).toBeLessThanOrEqual(1);
      expect(stats.cancelled).toBe(true);
    });

    it('stops streaming an undeclared (chunked) body as soon as it passes the limit', async () => {
      const chunk = new Uint8Array(16 * 1024).fill(0x20);
      // 100 MiB on offer; only a little over 64 KiB may ever be pulled.
      const { stream, stats } = countingStream(chunk, 6_400);
      fetchMock.mockResolvedValue(new Response(stream, { status: 200 }));

      const error = await sendExpectingFailure();
      expect(error.outcome).toBe('UNCERTAIN');
      expect(error.reason).toBe('RESPONSE_TOO_LARGE');
      expect(stats.pulled).toBeLessThanOrEqual(
        Math.ceil(MAX_RESPONSE_BYTES / chunk.byteLength) + 2,
      );
      expect(stats.cancelled).toBe(true);
    });

    it('accepts a valid answer of exactly the limit, decoded across split UTF-8 chunks', async () => {
      const json = JSON.stringify(ACCEPTED);
      const bytes = new Uint8Array(MAX_RESPONSE_BYTES).fill(0x20);
      bytes.set(new TextEncoder().encode(json));
      // Split inside the multi-byte Persian message.
      const cut = new TextEncoder().encode(json).indexOf(0xd8) + 1;
      fetchMock.mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes.slice(0, cut));
              controller.enqueue(bytes.slice(cut));
              controller.close();
            },
          }),
          { status: 200 },
        ),
      );

      await expect(
        new KavenegarOtpSender(ENV).send(MOBILE, CODE),
      ).resolves.toBeUndefined();
    });

    it(`a body that trickles forever is cut off by the same ${KAVENEGAR_REQUEST_TIMEOUT_MS}ms timeout`, async () => {
      jest.useFakeTimers();
      fetchMock.mockImplementation((_input, init) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"return":'));
            // Like undici: aborting the request errors its body stream.
            init?.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('aborted', 'AbortError')),
            );
          },
        });
        return Promise.resolve(new Response(stream, { status: 200 }));
      });

      const pending = new KavenegarOtpSender(ENV)
        .send(MOBILE, CODE)
        .catch((e: unknown) => e);
      await jest.advanceTimersByTimeAsync(KAVENEGAR_REQUEST_TIMEOUT_MS);

      const error = (await pending) as OtpDeliveryError;
      expect(error).toBeInstanceOf(OtpDeliveryError);
      expect(error.outcome).toBe('UNCERTAIN');
      expect(error.reason).toBe('TIMEOUT');
      expectNoLeak();
    });
  });

  describe('missing or invalid credentials', () => {
    it.each([
      [
        'no lookup URL',
        { KAVENEGAR_LOOKUP_URL: undefined },
        'KAVENEGAR_LOOKUP_URL is MISSING',
      ],
      [
        'a malformed template',
        { KAVENEGAR_OTP_TEMPLATE: 'login verify' },
        'KAVENEGAR_OTP_TEMPLATE is MALFORMED',
      ],
      [
        'an insecure URL',
        { KAVENEGAR_LOOKUP_URL: LOOKUP_URL.replace('https', 'http') },
        'KAVENEGAR_LOOKUP_URL is INSECURE',
      ],
      [
        'an unexpected host',
        {
          KAVENEGAR_LOOKUP_URL: LOOKUP_URL.replace(
            'api.kavenegar.com',
            'api.kavenegar.com.evil.test',
          ),
        },
        'KAVENEGAR_LOOKUP_URL is UNEXPECTED_HOST',
      ],
    ])(
      'refuses to construct with %s, naming the variable but not the value',
      (_label, override, message) => {
        let thrown: unknown;
        try {
          new KavenegarOtpSender({ ...ENV, ...override });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain(message);
        expect((thrown as Error).message).not.toContain(FAKE_KEY);
      },
    );
  });
});
