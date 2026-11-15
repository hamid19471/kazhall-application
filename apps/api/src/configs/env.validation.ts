import {
  plainToInstance,
  Transform,
  type TransformFnParams,
} from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MinLength,
  Min,
  validateSync,
} from 'class-validator';

/**
 * Boot-time environment validation.
 *
 * Wired into `ConfigModule.forRoot({ validate })`. Uses class-validator /
 * class-transformer (both already dependencies) rather than Joi.
 *
 * The point is FAIL FAST WITH A NAMED VARIABLE. Previously a missing
 * JWT_ACCESS_EXPIRATION did not fail at boot at all — it surfaced as a 500 on
 * every single login, because `@nestjs/jwt` throws
 *   `"expiresIn" should be a number of seconds or string representing a timespan`
 * when it is handed `undefined`. A misconfigured process must refuse to start,
 * not start and then break one endpoint.
 */

export enum NodeEnv {
  development = 'development',
  test = 'test',
  production = 'production',
}

/**
 * Documented defaults for every optional variable. They are applied here (and
 * written back into `process.env` by @nestjs/config) so that exactly one place
 * in the codebase decides what "unset" means.
 */
export const ENV_DEFAULTS = {
  NODE_ENV: NodeEnv.development,
  PORT: 8000,
  /**
   * Access-token lifetime. Kept deliberately short; the refresh-token rotation
   * flow is what provides continuity. MUST stay consistent with the
   * `access_token` cookie maxAge in `modules/auth/services/auth-cookie.service.ts`
   * — both read this value.
   */
  JWT_ACCESS_EXPIRATION: '15m',
  /** Refresh-token lifetime; also the `refresh_token` cookie maxAge. */
  JWT_REFRESH_EXPIRATION: '2d',
  /** Business timezone for report calendar-day boundaries (§0). */
  REPORT_TIMEZONE: 'Asia/Tehran',
  /** Provisional per docs/ARCHITECTURE.md D-2: 30 minutes. */
  ORDER_ALLOCATION_TTL_MS: 1_800_000,
  /**
   * How long a checkout quote — the customer's accepted purchase — stays
   * acceptable. 15 minutes: long enough to review an order, short enough that
   * prices cannot drift far behind it. Clamped at construction to at most the
   * 4-hour basket reservation TTL, because a quote must never outlive the hold
   * it prices (CheckoutQuoteService).
   */
  CHECKOUT_QUOTE_TTL_MS: 900_000,
  /** Comma-separated list. Empty => same-origin only (no cross-origin CORS). */
  CORS_ORIGINS: '',
} as const;

function emptyStringToUndefined({ value }: TransformFnParams): unknown {
  return typeof value === 'string' && value === '' ? undefined : value;
}

export class EnvironmentVariables {
  @IsOptional()
  @IsEnum(NodeEnv, {
    message: `NODE_ENV must be one of: ${Object.values(NodeEnv).join(', ')}`,
  })
  NODE_ENV: NodeEnv = ENV_DEFAULTS.NODE_ENV;

  // ------------------------------------------------------------------- http
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === '' ? undefined : Number(value),
  )
  @IsInt({ message: 'PORT must be an integer' })
  @Min(1, { message: 'PORT must be between 1 and 65535' })
  @Max(65535, { message: 'PORT must be between 1 and 65535' })
  PORT: number = ENV_DEFAULTS.PORT;

  /**
   * Comma-separated allowed origins for both HTTP CORS and the websocket
   * gateway, e.g. `https://admin.kazhal.ir,https://kazhal.ir`.
   */
  @IsOptional()
  @IsString({ message: 'CORS_ORIGINS must be a comma-separated string' })
  CORS_ORIGINS: string = ENV_DEFAULTS.CORS_ORIGINS;

  // --------------------------------------------------------------- security
  @IsString({ message: 'JWT_SECRET_KEY is required' })
  @IsNotEmpty({ message: 'JWT_SECRET_KEY is required and must not be empty' })
  @MinLength(16, {
    message: 'JWT_SECRET_KEY must be at least 16 characters long',
  })
  JWT_SECRET_KEY: string;

  @IsString({ message: 'OTP_HMAC_SECRET is required' })
  @IsNotEmpty({ message: 'OTP_HMAC_SECRET is required and must not be empty' })
  @MinLength(16, {
    message: 'OTP_HMAC_SECRET must be at least 16 characters long',
  })
  OTP_HMAC_SECRET: string;

  @IsOptional()
  @IsString({
    message:
      'JWT_ACCESS_EXPIRATION must be an `ms` timespan such as 15m, 900s or 1h',
  })
  @IsNotEmpty({ message: 'JWT_ACCESS_EXPIRATION must not be empty' })
  JWT_ACCESS_EXPIRATION: string = ENV_DEFAULTS.JWT_ACCESS_EXPIRATION;

  @IsOptional()
  @IsString({
    message:
      'JWT_REFRESH_EXPIRATION must be an `ms` timespan such as 2d, 48h or 172800s',
  })
  @IsNotEmpty({ message: 'JWT_REFRESH_EXPIRATION must not be empty' })
  JWT_REFRESH_EXPIRATION: string = ENV_DEFAULTS.JWT_REFRESH_EXPIRATION;

  // --------------------------------------------------------------- database
  @IsString({ message: 'DB_HOST is required' })
  @IsNotEmpty({ message: 'DB_HOST is required and must not be empty' })
  DB_HOST: string;

  @Transform(({ value }) =>
    value === undefined || value === '' ? undefined : Number(value),
  )
  @IsInt({ message: 'DB_PORT is required and must be an integer' })
  @Min(1, { message: 'DB_PORT must be between 1 and 65535' })
  @Max(65535, { message: 'DB_PORT must be between 1 and 65535' })
  DB_PORT: number;

  @IsString({ message: 'DB_USERNAME is required' })
  @IsNotEmpty({ message: 'DB_USERNAME is required and must not be empty' })
  DB_USERNAME: string;

  /**
   * Required to be PRESENT, but may be the empty string for a local instance
   * using trust authentication. Set `DB_PASSWORD=` explicitly in that case, so
   * "no password" is a deliberate choice rather than a forgotten variable.
   */
  @IsString({
    message: 'DB_PASSWORD is required (set DB_PASSWORD= for an empty password)',
  })
  DB_PASSWORD: string;

  @IsString({ message: 'DB_DATABASE is required' })
  @IsNotEmpty({ message: 'DB_DATABASE is required and must not be empty' })
  DB_DATABASE: string;

  // --------------------------------------------------------------- business
  @IsOptional()
  @IsString({ message: 'REPORT_TIMEZONE must be an IANA timezone name' })
  @IsNotEmpty({ message: 'REPORT_TIMEZONE must not be empty' })
  REPORT_TIMEZONE: string = ENV_DEFAULTS.REPORT_TIMEZONE;

  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === '' ? undefined : Number(value),
  )
  @IsInt({ message: 'ORDER_ALLOCATION_TTL_MS must be an integer number of ms' })
  @Min(1000, { message: 'ORDER_ALLOCATION_TTL_MS must be at least 1000 ms' })
  ORDER_ALLOCATION_TTL_MS: number = ENV_DEFAULTS.ORDER_ALLOCATION_TTL_MS;

  /**
   * Validated here so a typo aborts the process with the variable's name,
   * rather than silently falling back to the default and quietly giving every
   * customer a different review window than the operator configured.
   */
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === '' ? undefined : Number(value),
  )
  @IsInt({ message: 'CHECKOUT_QUOTE_TTL_MS must be an integer number of ms' })
  @Min(30_000, { message: 'CHECKOUT_QUOTE_TTL_MS must be at least 30000 ms' })
  CHECKOUT_QUOTE_TTL_MS: number = ENV_DEFAULTS.CHECKOUT_QUOTE_TTL_MS;

  // -------------------------------------------------------------- bootstrap
  /**
   * Optional. When both are set, the seeder creates (once) a super_admin with
   * these credentials. Leaving them unset simply skips admin bootstrapping.
   */
  @IsOptional()
  @Transform(emptyStringToUndefined)
  @IsString()
  @IsNotEmpty({ message: 'BOOTSTRAP_ADMIN_USERNAME must not be empty' })
  BOOTSTRAP_ADMIN_USERNAME?: string;

  @IsOptional()
  @Transform(emptyStringToUndefined)
  @IsString()
  @MinLength(8, {
    message: 'BOOTSTRAP_ADMIN_PASSWORD must be at least 8 characters long',
  })
  BOOTSTRAP_ADMIN_PASSWORD?: string;

  // ------------------------------------------------------------------ redis
  @IsOptional()
  @IsString()
  REDIS_HOST?: string;

  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === '' ? undefined : Number(value),
  )
  @IsInt({ message: 'REDIS_PORT must be an integer' })
  REDIS_PORT?: number;

  /** Optional Redis logical database, 0-15. Unset means 0. */
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === '' ? undefined : Number(value),
  )
  @IsInt({ message: 'REDIS_DB must be an integer' })
  @Min(0, { message: 'REDIS_DB must be between 0 and 15' })
  @Max(15, { message: 'REDIS_DB must be between 0 and 15' })
  REDIS_DB?: number;
}

/**
 * `ConfigModule.forRoot({ validate })` hook.
 *
 * Returns the *whole* config with validated/defaulted values merged over it, so
 * variables this class does not model (S3/Minio credentials, etc.) are not
 * silently dropped from ConfigService.
 */
export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  // Apply the documented defaults BEFORE validation so that (a) the error
  // report only ever names genuinely missing required variables and (b) the
  // defaults end up in the returned config and therefore in process.env.
  const withDefaults: Record<string, unknown> = { ...config };
  for (const [key, fallback] of Object.entries(ENV_DEFAULTS)) {
    const current = withDefaults[key];
    if (current === undefined || current === null || current === '') {
      withDefaults[key] = fallback;
    }
  }

  const validated = plainToInstance(EnvironmentVariables, withDefaults, {
    // string env vars must become numbers where the class says number
    enableImplicitConversion: false,
    exposeDefaultValues: true,
  });

  const errors = validateSync(validated, {
    skipMissingProperties: false,
    whitelist: false,
    forbidUnknownValues: false,
  });

  if (errors.length > 0) {
    const details = errors
      .map((error) => {
        const messages = Object.values(error.constraints ?? {});
        return `  - ${error.property}: ${
          messages.length ? messages.join('; ') : 'invalid value'
        }`;
      })
      .join('\n');

    throw new Error(
      `Invalid environment configuration — refusing to start.\n${details}\n` +
        `See .env.example for the full list of variables and their defaults.`,
    );
  }

  return {
    ...withDefaults,
    ...(validated as unknown as Record<string, unknown>),
  };
}

/** Parses CORS_ORIGINS into the array form `enableCors`/socket.io expect. */
export function parseCorsOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
