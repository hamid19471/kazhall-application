import { INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiResponse, DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export const SWAGGER_PATH = 'v1/api';

/**
 * Name of the cookie security scheme. Controllers annotate protected routes
 * with `@ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)`.
 */
export const ACCESS_TOKEN_SECURITY_SCHEME = 'access_token';

// ===========================================================================
// The two wire envelopes
// ===========================================================================
//
// Neither of them is the service return type, so a response documented with a
// bare DTO would be wrong for every route in the API. `ResponseFormatInterceptor`
// wraps every success and `GlobalExceptionFilter` wraps every failure.

/**
 * Shape produced by `GlobalExceptionFilter` for EVERY failing request.
 *
 * The two keys clients get wrong most often:
 *  - `error` is promoted to the TOP level (it is not inside `details`), and
 *  - `details` carries every OTHER key the thrower attached to the exception
 *    payload, e.g. `{ code: 'INSUFFICIENT_STOCK', variantId, physicalStock,
 *    basketReserved, orderAllocated }`. It is absent when the thrower supplied
 *    no extra keys, so read it defensively.
 */
export const ERROR_ENVELOPE_SCHEMA = {
  type: 'object',
  required: ['success', 'statusCode', 'message', 'timestamp', 'path'],
  properties: {
    success: { type: 'boolean', example: false },
    statusCode: {
      type: 'integer',
      description: 'The HTTP status, repeated in the body.',
      example: 400,
    },
    message: {
      description:
        'A human-readable sentence, or the ARRAY of strings a failing ' +
        'ValidationPipe produces. Always handle both.',
      oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
      example: 'Order not found',
    },
    error: {
      type: 'string',
      description:
        "Short machine-ish label — 'Bad Request', or a domain code such as " +
        "'IDEMPOTENCY_KEY_REUSED'. Top level, NOT inside `details`.",
      example: 'Bad Request',
    },
    details: {
      type: 'object',
      additionalProperties: true,
      description:
        'Every other key the thrower put on the exception payload. Absent ' +
        'when there were none.',
      example: { code: 'INSUFFICIENT_STOCK', variantId: 7, physicalStock: 2 },
    },
    timestamp: { type: 'string', format: 'date-time' },
    path: { type: 'string', example: '/orders/12' },
  },
};

/**
 * Builds the success envelope `ResponseFormatInterceptor` puts on the wire.
 *
 * A handler that returns a PLAIN OBJECT has its keys spread next to `success`
 * and `timeStamp` (so `{ message, data }` becomes
 * `{ success, timeStamp, message, data }`). Anything else — an array, a
 * primitive, `null` — is placed under `data` untouched.
 *
 * Note the capital S in `timeStamp`: it does not match the error envelope's
 * `timestamp`, and that asymmetry is part of the shipped contract.
 */
export const successEnvelopeSchema = (options?: {
  /** Extra top-level keys the handler spreads next to the envelope. */
  properties?: Record<string, unknown>;
  /** Convenience for the common `{ message, data }` return. */
  message?: string;
  data?: Record<string, unknown>;
}) => ({
  type: 'object',
  required: ['success', 'timeStamp'],
  properties: {
    success: { type: 'boolean', example: true },
    timeStamp: { type: 'string', format: 'date-time' },
    ...(options?.message !== undefined
      ? { message: { type: 'string', example: options.message } }
      : {}),
    ...(options?.data !== undefined ? { data: options.data } : {}),
    ...(options?.properties ?? {}),
  },
});

// ===========================================================================
// Reusable response annotations
// ===========================================================================

/** Any failing status, documented with the real error envelope. */
export const ApiErrorEnvelope = (status: number, description: string) =>
  ApiResponse({ status, description, schema: ERROR_ENVELOPE_SCHEMA });

/**
 * 401 from the global `JwtAuthGuard`. Applies to every route that is not
 * `@Public()`.
 */
export const ApiAuthRequired = () =>
  ApiErrorEnvelope(
    401,
    'No session cookie for this route’s audience was sent, or it is ' +
      'invalid/expired. An expired token answers `Access token has expired`; ' +
      'call `POST /auth/{audience}/refresh` for the SAME audience (which needs ' +
      'only that audience’s refresh cookie) and retry.',
  );

/** 403 from the global `RolesGuard`. */
export const ApiRoleForbidden = (roles: string) =>
  ApiErrorEnvelope(
    403,
    `Authenticated, but the caller holds none of the required roles (${roles}).`,
  );

/**
 * 403 from the global `PermissionsGuard`.
 *
 * Distinct from `ApiRoleForbidden` because the body differs: this one carries
 * `error: "PERMISSION_DENIED"` plus `requiredPermissions` and
 * `missingPermissions` under `details`, which is what lets the console tell an
 * operator WHICH delegation they are missing instead of showing a bare 403.
 */
export const ApiPermissionForbidden = (permissions: string) =>
  ApiErrorEnvelope(
    403,
    `Authenticated and on a surface this route serves, but the caller does ` +
      `not hold every required permission (${permissions}). ` +
      '`error` is `PERMISSION_DENIED`; `details.missingPermissions` names the ' +
      'ones that are absent.',
  );

/** 400 from the global `ValidationPipe` and/or the handler's own checks. */
export const ApiInvalidInput = (description: string) =>
  ApiErrorEnvelope(400, description);

export const ApiNotFound = (description: string) =>
  ApiErrorEnvelope(404, description);

export const ApiConflict = (description: string) =>
  ApiErrorEnvelope(409, description);

/**
 * Boilerplate shared by every route that takes a numeric id through
 * `ParseIntPipe`: a non-numeric segment is a 400 raised before the handler runs.
 */
export const PARSE_INT_PIPE_400 =
  'Path id is not an integer (rejected by `ParseIntPipe` before the handler runs)';

/** Whitelisting ValidationPipe: unknown body keys are rejected, not ignored. */
export const VALIDATION_PIPE_400 =
  'Body failed validation. `message` is then an ARRAY of strings. Unknown ' +
  'properties are rejected outright (`whitelist` + `forbidNonWhitelisted`)';

const API_DESCRIPTION = `
Kazhal commerce API.

## Authentication

Every protected route reads an **httpOnly access-token cookie**. There is no
\`Authorization: Bearer\` header anywhere in this API.

Sessions are **per audience**: \`storefront\`, \`admin\` and \`pos\` each have their
own cookie pair (\`kz_storefront_access\`/\`kz_storefront_refresh\`,
\`kz_admin_access\`/\`kz_admin_refresh\`, \`kz_pos_access\`/\`kz_pos_refresh\`) and a
signed \`aud\` claim, and a token minted for one audience is refused by the other
two. The doors are:

- \`POST /auth/admin/login\` and \`POST /auth/pos/login\` — staff username + password
- \`POST /auth/storefront/send-otp\` then \`POST /auth/storefront/verify-otp\` — the
  customer's production door
- \`POST /auth/storefront/review-login\` — review builds only; 403 otherwise
- \`POST /auth/{audience}/refresh\`, \`/logout\`, \`/logout-all\`, \`/change-password\`
  and \`GET /auth/{audience}/me\` — one set per audience

Requests must be sent with credentials (\`fetch(..., { credentials: 'include' })\`);
the "Try it out" button below is already configured that way.

Routes without a lock icon are genuinely public and are reachable with no cookie
at all.

## Success envelope

\`ResponseFormatInterceptor\` wraps every 2xx body:

\`\`\`json
{ "success": true, "timeStamp": "2026-09-10T09:12:44.001Z", "message": "…", "data": … }
\`\`\`

A handler returning a plain object has its keys spread beside \`success\` /
\`timeStamp\`; an array or a primitive is placed under \`data\` intact. The key is
spelled \`timeStamp\` (capital S) on success and \`timestamp\` on error.

## Error envelope

\`GlobalExceptionFilter\` wraps every non-2xx body:

\`\`\`json
{
  "success": false,
  "statusCode": 409,
  "message": "Not enough stock",
  "error": "INSUFFICIENT_STOCK",
  "details": { "code": "INSUFFICIENT_STOCK", "variantId": 7, "physicalStock": 2 },
  "timestamp": "2026-09-10T09:12:44.001Z",
  "path": "/orders"
}
\`\`\`

\`error\` is a TOP-LEVEL key. \`details\` holds every other key the thrower attached
to the exception payload and is absent when there were none. \`message\` is an
ARRAY of strings when a \`ValidationPipe\` rejected the body.
`.trim();

/**
 * Mounts Swagger UI — but never in production.
 *
 * This API authenticates with an httpOnly `access_token` COOKIE, not an
 * `Authorization: Bearer` header. `.addCookieAuth()` declares that scheme and
 * it is the only one the document defines: the `@ApiBearerAuth()` annotations
 * that used to reference an undeclared bearer scheme (so "Authorize" in the UI
 * did nothing) have all been migrated to
 * `@ApiCookieAuth(ACCESS_TOKEN_SECURITY_SCHEME)`, and the compatibility
 * `.addBearerAuth()` that kept them resolvable has been removed with them.
 *
 * Returns true when the docs were mounted, false when they were suppressed.
 */
export const swaggerConfig = (app: INestApplication): boolean => {
  const configService = app.get(ConfigService, { strict: false });
  const nodeEnv =
    configService?.get<string>('NODE_ENV') ??
    process.env.NODE_ENV ??
    'development';

  if (nodeEnv === 'production') {
    new Logger('Swagger').log(
      'NODE_ENV=production — API documentation is not exposed.',
    );
    return false;
  }

  const config = new DocumentBuilder()
    .setTitle('Kazhal API')
    .setDescription(API_DESCRIPTION)
    .setVersion('1.0')
    .addCookieAuth(
      ACCESS_TOKEN_SECURITY_SCHEME,
      {
        type: 'apiKey',
        in: 'cookie',
        name: ACCESS_TOKEN_SECURITY_SCHEME,
        description:
          'httpOnly JWT access-token cookie. Issued per AUDIENCE — the real ' +
          'cookie is kz_storefront_access, kz_admin_access or kz_pos_access, ' +
          'set by POST /auth/{audience}/login (or POST ' +
          '/auth/storefront/verify-otp). This scheme names them collectively.',
      },
      ACCESS_TOKEN_SECURITY_SCHEME,
    )
    // Tag order = the order a frontend developer meets the API in.
    .addTag('Health', 'Liveness/readiness probe. Public.')
    .addTag(
      'Authentication',
      'Cookie login, OTP, refresh and session revocation.',
    )
    .addTag('Products Management', 'Catalog: public browsing and admin writes.')
    .addTag('Product Categories', 'Category navigation and admin writes.')
    .addTag(
      'Products Attribute Management',
      'Variant vocabulary (colour, size).',
    )
    .addTag('Cart Management', 'The signed-in customer’s basket.')
    .addTag('Checkout', 'Quote a basket and turn it into an online order.')
    .addTag('Payment Management', 'Gateway start/verify plus admin recovery.')
    .addTag('POS', 'In-store till sales.')
    .addTag(
      'Orders Management',
      'Staff order administration: read, status, void, return.',
    )
    .addTag('Reports', 'Sales reporting.')
    .addTag(
      'Inventory management',
      'SKU lookup, availability and reservation sweeps.',
    )
    .addTag('My Account', 'Self-service, always scoped to the caller.')
    .addTag('Customers', 'Admin customer directory.')
    .addTag('Addresses Management', 'Admin, unscoped address administration.')
    .addTag('Branches', 'Store/branch directory.')
    .addTag('Users Management', 'Staff accounts.')
    .addTag('Roles', 'Role catalogue and role assignment.')
    .build();

  // `autoTagControllers` defaults to TRUE, which injects a tag named after the
  // controller class whenever the class carries no `@ApiTags`. `OrdersController`
  // deliberately tags PER HANDLER (Checkout / POS / Orders Management, three
  // different audiences in one class), and the injected `Orders` tag was then
  // MERGED with each handler's own tag, listing all nine operations twice.
  // Every controller here declares its tags explicitly, so nothing is left
  // untagged by turning the fallback off.
  const document = SwaggerModule.createDocument(app, config, {
    autoTagControllers: false,
  });
  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    swaggerOptions: { withCredentials: true },
  });
  return true;
};
