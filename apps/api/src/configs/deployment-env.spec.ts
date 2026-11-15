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
