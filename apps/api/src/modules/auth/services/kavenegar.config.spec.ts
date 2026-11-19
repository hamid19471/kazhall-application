import { resolveOtpSmsConfig } from './kavenegar.config';

const FAKE_KEY = 'FAKE-KEY-not-a-real-kavenegar-key-0000';
const VALID_URL = `https://api.kavenegar.com/v1/${FAKE_KEY}/verify/lookup.json`;

const kavenegar = (overrides: Record<string, unknown> = {}) => ({
  NODE_ENV: 'production',
  OTP_SMS_DRIVER: 'kavenegar',
  KAVENEGAR_LOOKUP_URL: VALID_URL,
  KAVENEGAR_OTP_TEMPLATE: 'kazhalLoginVerify',
  ...overrides,
});

describe('resolveOtpSmsConfig', () => {
  it.each([undefined, '', '  '])(
    'defaults to the log driver when OTP_SMS_DRIVER is %p',
    (driver) => {
      expect(resolveOtpSmsConfig({ OTP_SMS_DRIVER: driver })).toEqual({
        ok: true,
        config: { driver: 'log' },
      });
    },
  );

  it('rejects an unknown driver', () => {
    const result = resolveOtpSmsConfig({ OTP_SMS_DRIVER: 'twilio' });
    expect(result.ok).toBe(false);
  });

  it('accepts a valid Kavenegar configuration', () => {
    const result = resolveOtpSmsConfig(kavenegar());
    expect(result.ok).toBe(true);
    if (result.ok && result.config.driver === 'kavenegar') {
      expect(result.config.lookupUrl.pathname).toBe(
        `/v1/${FAKE_KEY}/verify/lookup.json`,
      );
      expect(result.config.template).toBe('kazhalLoginVerify');
    }
  });

  it.each([
    ['missing', undefined, 'MISSING'],
    ['empty', '', 'MISSING'],
    ['not a URL', 'not a url', 'MALFORMED'],
    [
      'plain http to a real host',
      VALID_URL.replace('https', 'http'),
      'INSECURE',
    ],
    [
      'the send endpoint',
      VALID_URL.replace('verify/lookup', 'sms/send'),
      'WRONG_PATH',
    ],
    ['carrying a query string', `${VALID_URL}?template=x`, 'MALFORMED'],
    [
      'carrying credentials',
      VALID_URL.replace('https://', 'https://u:p@'),
      'MALFORMED',
    ],
  ])('rejects a lookup URL that is %s', (_label, url, issue) => {
    const result = resolveOtpSmsConfig(
      kavenegar({ KAVENEGAR_LOOKUP_URL: url }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join('\n')).toContain(
        `KAVENEGAR_LOOKUP_URL is ${issue}`,
      );
    }
  });

  it.each([
    ['a look-alike host', 'https://api.kavenegar.com.evil.test'],
    ['a sibling subdomain', 'https://sms.kavenegar.com'],
    ['the bare domain', 'https://kavenegar.com'],
    ['a trailing-dot host', 'https://api.kavenegar.com.'],
    ['a non-default port', 'https://api.kavenegar.com:8443'],
    ['an IP address', 'https://185.112.33.61'],
    ['an https loopback stub in production', 'https://127.0.0.1:9443'],
  ])('pins the host: rejects %s', (_label, origin) => {
    const result = resolveOtpSmsConfig(
      kavenegar({
        KAVENEGAR_LOOKUP_URL: `${origin}/v1/${FAKE_KEY}/verify/lookup.json`,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join('\n')).toContain(
        'KAVENEGAR_LOOKUP_URL is UNEXPECTED_HOST',
      );
      expect(result.issues.join('\n')).not.toContain(FAKE_KEY);
    }
  });

  it('accepts the host case-insensitively (URL parsing lowercases it)', () => {
    expect(
      resolveOtpSmsConfig(
        kavenegar({
          KAVENEGAR_LOOKUP_URL: `https://API.Kavenegar.COM/v1/${FAKE_KEY}/verify/lookup.json`,
        }),
      ).ok,
    ).toBe(true);
  });

  it('allows an https localhost stub outside production', () => {
    expect(
      resolveOtpSmsConfig(
        kavenegar({
          NODE_ENV: 'development',
          KAVENEGAR_LOOKUP_URL: `https://localhost:9443/v1/${FAKE_KEY}/verify/lookup.json`,
        }),
      ).ok,
    ).toBe(true);
  });

  it('allows a plain-http localhost stub outside production only', () => {
    const stub = `http://127.0.0.1:9999/v1/${FAKE_KEY}/verify/lookup.json`;
    expect(
      resolveOtpSmsConfig(
        kavenegar({ NODE_ENV: 'development', KAVENEGAR_LOOKUP_URL: stub }),
      ).ok,
    ).toBe(true);
    expect(
      resolveOtpSmsConfig(kavenegar({ KAVENEGAR_LOOKUP_URL: stub })).ok,
    ).toBe(false);
  });

  it.each([undefined, '', '  '])(
    'defaults KAVENEGAR_OTP_TEMPLATE=%p to the existing loginVerify template',
    (template) => {
      const result = resolveOtpSmsConfig(
        kavenegar({ KAVENEGAR_OTP_TEMPLATE: template }),
      );
      expect(result).toMatchObject({
        ok: true,
        config: { driver: 'kavenegar', template: 'loginVerify' },
      });
    },
  );

  it.each(['login verify', 'a/b', 'x?y=1'])(
    'rejects KAVENEGAR_OTP_TEMPLATE=%p',
    (template) => {
      const result = resolveOtpSmsConfig(
        kavenegar({ KAVENEGAR_OTP_TEMPLATE: template }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toContain('KAVENEGAR_OTP_TEMPLATE is MALFORMED');
      }
    },
  );

  it('never echoes the API key in an issue', () => {
    const result = resolveOtpSmsConfig(
      kavenegar({
        KAVENEGAR_LOOKUP_URL: `http://api.kavenegar.com/v1/${FAKE_KEY}/verify/lookup.json`,
        KAVENEGAR_OTP_TEMPLATE: 'bad template',
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join('\n')).not.toContain(FAKE_KEY);
    }
  });
});
