import { validateEnv } from './env.validation';

const REQUIRED = {
  JWT_SECRET_KEY: '0123456789abcdef0123456789abcdef',
  OTP_HMAC_SECRET: 'abcdef0123456789abcdef0123456789',
  DB_HOST: 'postgres',
  DB_PORT: '5432',
  DB_USERNAME: 'kazhal',
  DB_PASSWORD: 'not-a-real-password',
  DB_DATABASE: 'kazhal',
};

describe('optional production bootstrap credentials', () => {
  it('treats empty Compose values as unset', () => {
    const env = validateEnv({
      ...REQUIRED,
      BOOTSTRAP_ADMIN_USERNAME: '',
      BOOTSTRAP_ADMIN_PASSWORD: '',
    });

    expect(env.BOOTSTRAP_ADMIN_USERNAME).toBeUndefined();
    expect(env.BOOTSTRAP_ADMIN_PASSWORD).toBeUndefined();
  });

  it('still rejects an invalid non-empty bootstrap password', () => {
    expect(() =>
      validateEnv({
        ...REQUIRED,
        BOOTSTRAP_ADMIN_USERNAME: 'owner',
        BOOTSTRAP_ADMIN_PASSWORD: 'short',
      }),
    ).toThrow(/BOOTSTRAP_ADMIN_PASSWORD/);
  });
});

describe('OTP SMS delivery configuration', () => {
  const FAKE_KEY = 'FAKE-KEY-not-a-real-kavenegar-key-0000';
  const LOOKUP = `https://api.kavenegar.com/v1/${FAKE_KEY}/verify/lookup.json`;

  it('boots with the log driver when nothing is set (existing deployments)', () => {
    expect(() => validateEnv({ ...REQUIRED })).not.toThrow();
  });

  it('treats the empty Compose defaults as the log driver', () => {
    expect(() =>
      validateEnv({
        ...REQUIRED,
        OTP_SMS_DRIVER: 'log',
        KAVENEGAR_LOOKUP_URL: '',
        KAVENEGAR_OTP_TEMPLATE: '',
      }),
    ).not.toThrow();
  });

  it('boots with a complete Kavenegar configuration', () => {
    expect(() =>
      validateEnv({
        ...REQUIRED,
        NODE_ENV: 'production',
        OTP_SMS_DRIVER: 'kavenegar',
        KAVENEGAR_LOOKUP_URL: LOOKUP,
        KAVENEGAR_OTP_TEMPLATE: 'kazhalLoginVerify',
      }),
    ).not.toThrow();
  });

  it('refuses to boot when Kavenegar is selected without credentials', () => {
    expect(() =>
      validateEnv({ ...REQUIRED, OTP_SMS_DRIVER: 'kavenegar' }),
    ).toThrow(/KAVENEGAR_LOOKUP_URL is MISSING/);
  });

  it('does not require a template (defaults to the existing loginVerify)', () => {
    const env = validateEnv({
      ...REQUIRED,
      NODE_ENV: 'production',
      OTP_SMS_DRIVER: 'kavenegar',
      KAVENEGAR_LOOKUP_URL: LOOKUP,
      KAVENEGAR_OTP_TEMPLATE: '',
    });
    expect(env.OTP_SMS_DRIVER).toBe('kavenegar');
  });

  it('refuses an unknown driver', () => {
    expect(() =>
      validateEnv({ ...REQUIRED, OTP_SMS_DRIVER: 'sms-ir' }),
    ).toThrow(/OTP_SMS_DRIVER/);
  });

  it('never prints the API key when refusing a bad endpoint', () => {
    let message = '';
    try {
      validateEnv({
        ...REQUIRED,
        NODE_ENV: 'production',
        OTP_SMS_DRIVER: 'kavenegar',
        KAVENEGAR_LOOKUP_URL: LOOKUP.replace('https', 'http'),
        KAVENEGAR_OTP_TEMPLATE: 'kazhalLoginVerify',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('KAVENEGAR_LOOKUP_URL is INSECURE');
    expect(message).not.toContain(FAKE_KEY);
  });
});
