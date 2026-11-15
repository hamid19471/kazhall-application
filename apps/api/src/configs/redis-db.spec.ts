import { validateEnv } from './env.validation';

/**
 * `REDIS_DB` is an opt-in logical database for isolated stacks (the disposable
 * pricing browser workflow). Unset keeps Redis's default; anything outside
 * 0..15 refuses to boot rather than silently sharing database 0.
 */
const REQUIRED = {
  JWT_SECRET_KEY: 'x'.repeat(32),
  OTP_HMAC_SECRET: 'y'.repeat(32),
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_USERNAME: 'kazhal',
  DB_PASSWORD: '',
  DB_DATABASE: 'kazhal',
};

describe('REDIS_DB', () => {
  it('is optional and stays unset by default', () => {
    expect(validateEnv({ ...REQUIRED }).REDIS_DB).toBeUndefined();
    expect(validateEnv({ ...REQUIRED, REDIS_DB: '' }).REDIS_DB).toBeUndefined();
  });

  it('accepts 0..15', () => {
    expect(validateEnv({ ...REQUIRED, REDIS_DB: '15' }).REDIS_DB).toBe(15);
    expect(validateEnv({ ...REQUIRED, REDIS_DB: '0' }).REDIS_DB).toBe(0);
  });

  it('refuses anything else', () => {
    for (const bad of ['16', '-1', '1.5', 'x']) {
      expect(() => validateEnv({ ...REQUIRED, REDIS_DB: bad })).toThrow(
        /REDIS_DB/,
      );
    }
  });
});
