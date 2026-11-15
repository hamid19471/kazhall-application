import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigService } from '@nestjs/config';

import { PaymentConfig } from '../modules/payment/payment.config';
import { ENV_DEFAULTS, parseCorsOrigins, validateEnv } from './env.validation';

/**
 * The local-development port contract: API 8000, Web (storefront and admin)
 * 8001, POS 8002. Port 3000 belongs to another local service on the owner's
 * machine, and 3000/3100/3200 were the previous defaults, so none of them may
 * come back as a development default.
 */
const API_ROOT = join(__dirname, '..', '..');
const RETIRED_PORTS = /localhost:(3000|3100|3200)\b/;

const REQUIRED = {
  JWT_SECRET_KEY: 'x'.repeat(32),
  OTP_HMAC_SECRET: 'y'.repeat(32),
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_USERNAME: 'kazhal',
  DB_PASSWORD: '',
  DB_DATABASE: 'kazhal',
};

function envExample(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(join(API_ROOT, '.env.example'), 'utf8').split(
    '\n',
  )) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function paymentConfig(values: Record<string, string> = {}): PaymentConfig {
  return new PaymentConfig({
    get: (key: string) => values[key],
  } as unknown as ConfigService);
}

describe('local development port contract', () => {
  it('defaults the API to port 8000', () => {
    expect(ENV_DEFAULTS.PORT).toBe(8000);
  });

  it('lets an explicit PORT override the default', () => {
    expect(validateEnv({ ...REQUIRED }).PORT).toBe(8000);
    expect(validateEnv({ ...REQUIRED, PORT: '9123' }).PORT).toBe(9123);
  });

  it('keeps CORS closed when CORS_ORIGINS is unset (no localhost baked into production)', () => {
    expect(ENV_DEFAULTS.CORS_ORIGINS).toBe('');
  });

  it('sends the payment gateway back to the Web return page on 8001 by default', () => {
    expect(paymentConfig().callbackUrl).toBe(
      'http://localhost:8001/checkout/payment/return',
    );
  });

  it('lets PAYMENT_CALLBACK_URL override the development callback', () => {
    expect(
      paymentConfig({
        PAYMENT_CALLBACK_URL: 'https://kazhal.example/checkout/payment/return',
      }).callbackUrl,
    ).toBe('https://kazhal.example/checkout/payment/return');
  });

  describe('.env.example', () => {
    const example = envExample();

    it('documents PORT=8000', () => {
      expect(example.PORT).toBe('8000');
    });

    it('allows the Web and POS development origins', () => {
      expect(parseCorsOrigins(example.CORS_ORIGINS)).toEqual(
        expect.arrayContaining([
          'http://localhost:8001',
          'http://localhost:8002',
        ]),
      );
    });

    it('points the payment return at the Web page, never the POST-only verify route', () => {
      expect(example.PAYMENT_CALLBACK_URL).toBe(
        'http://localhost:8001/checkout/payment/return',
      );
    });

    it('mentions none of the retired ports', () => {
      expect(readFileSync(join(API_ROOT, '.env.example'), 'utf8')).not.toMatch(
        RETIRED_PORTS,
      );
    });
  });

  it('prints the 8000/8001/8002 URLs from the dev seeder', () => {
    const source = readFileSync(
      join(API_ROOT, 'src/database/seeder/dev/dev-seed-cli.ts'),
      'utf8',
    );
    expect(source).toContain('http://localhost:8000/health');
    expect(source).toContain('http://localhost:8001/auth/sign-in');
    expect(source).toContain('http://localhost:8001/admin');
    expect(source).toContain('http://localhost:8002/login');
    expect(source).not.toMatch(RETIRED_PORTS);
  });
});
