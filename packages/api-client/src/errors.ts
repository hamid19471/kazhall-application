/**
 * Error envelope parsing and the single `ApiError` type every call site sees.
 *
 * Server error envelope (global exception filter):
 *
 * ```jsonc
 * {
 *   "statusCode": 409,
 *   "message": "…" | ["…", "…"],   // ValidationPipe returns an ARRAY
 *   "error": "CART_ITEM_CONFLICT",  // machine-readable code, promoted to top level
 *   "details": { "code": "…", "retryAfterSeconds": 30, … },
 *   "timestamp": "2026-01-01T00:00:00.000Z",  // note: lowercase `s`, unlike the success envelope
 *   "path": "/api/cart/items"
 * }
 * ```
 *
 * The canonical read for the machine-readable code is
 * `body.error ?? body.details?.code` — never parse the human message.
 */

import { isPlainObject } from "./envelope";

/** Extra machine-readable context the API attaches to some failures. */
export interface ApiErrorDetails extends Record<string, unknown> {
  /** Fallback location for the machine-readable code. */
  code?: string;
  /** Present on 429 responses. */
  retryAfterSeconds?: number;
  /** Present on some 400/422 responses. */
  fields?: Record<string, string[]>;
}

/** The parsed error body, exactly as the server sends it. */
export interface ApiErrorBody {
  /** The exception filter always sets this to `false`. */
  success?: false;
  statusCode: number;
  /** String for most failures, string[] for ValidationPipe failures. */
  message: string | string[];
  /** Machine-readable code, promoted to top level by the exception filter. */
  error?: string;
  details?: ApiErrorDetails;
  timestamp?: string;
  path?: string;
}

/**
 * Coarse classification. Prefer branching on `kind` over on raw status codes:
 * it keeps 403/404 handling honest (see {@link isMissingOrForbidden}).
 */
export type ApiErrorKind =
  | "network" // fetch itself failed — offline, DNS, CORS preflight
  | "timeout" // client-side timeout
  | "aborted" // caller's AbortSignal fired
  | "parse" // response body was not the JSON we expected
  | "validation" // 400 / 422
  | "unauthorized" // 401 (after refresh has already been tried)
  | "forbidden" // 403
  | "not_found" // 404
  | "conflict" // 409 domain conflict
  | "rate_limited" // 429
  | "server" // 5xx
  | "http"; // any other non-2xx

/** True for a value that structurally matches the server error envelope. */
export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (!isPlainObject(value)) return false;
  const status = value["statusCode"];
  const message = value["message"];
  const hasStatus = typeof status === "number";
  const hasMessage =
    typeof message === "string" ||
    (Array.isArray(message) && message.every((m) => typeof m === "string"));
  return hasStatus && hasMessage;
}

/** Normalize `message` to an array. Never throws, never returns `[]`. */
export function toMessages(message: string | string[] | undefined, fallback: string): string[] {
  if (Array.isArray(message)) {
    const clean = message.filter((m): m is string => typeof m === "string" && m.length > 0);
    return clean.length > 0 ? clean : [fallback];
  }
  if (typeof message === "string" && message.length > 0) return [message];
  return [fallback];
}

/**
 * Safe extraction of the machine-readable code.
 * Canonical read: `body.error ?? body.details?.code`.
 */
export function extractErrorCode(body: unknown): string | undefined {
  if (!isPlainObject(body)) return undefined;
  const top = body["error"];
  if (typeof top === "string" && top.length > 0) return top;
  const details = body["details"];
  if (isPlainObject(details)) {
    const nested = details["code"];
    if (typeof nested === "string" && nested.length > 0) return nested;
  }
  return undefined;
}

/** Safe extraction of the 429 backoff hint, in seconds. */
export function extractRetryAfterSeconds(body: unknown, headers?: Headers): number | undefined {
  if (isPlainObject(body)) {
    const details = body["details"];
    if (isPlainObject(details)) {
      const value = details["retryAfterSeconds"];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
      if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed >= 0) return parsed;
      }
    }
  }
  const header = headers?.get("retry-after");
  if (header) {
    const asSeconds = Number(header);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds;
    const asDate = Date.parse(header);
    if (!Number.isNaN(asDate)) {
      return Math.max(0, Math.round((asDate - Date.now()) / 1000));
    }
  }
  return undefined;
}

function kindForStatus(status: number): ApiErrorKind {
  if (status === 400 || status === 422) return "validation";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "http";
}

export interface ApiErrorInit {
  kind: ApiErrorKind;
  status: number;
  messages: string[];
  code?: string | undefined;
  body?: ApiErrorBody | undefined;
  details?: ApiErrorDetails | undefined;
  retryAfterSeconds?: number | undefined;
  path?: string | undefined;
  method?: string | undefined;
  timestamp?: string | undefined;
  cause?: unknown;
}

/**
 * The one error type thrown by the client. Every field is safe to read.
 */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  /** HTTP status, or `0` for transport-level failures. */
  readonly status: number;
  /** All server messages, always an array (ValidationPipe returns arrays). */
  readonly messages: string[];
  /** `body.error ?? body.details?.code`, or `undefined`. */
  readonly code: string | undefined;
  readonly details: ApiErrorDetails | undefined;
  readonly retryAfterSeconds: number | undefined;
  /** Request path the server reported (error envelope `path`). */
  readonly path: string | undefined;
  readonly method: string | undefined;
  readonly timestamp: string | undefined;
  /** Raw parsed error envelope, when the server sent one. */
  readonly body: ApiErrorBody | undefined;

  constructor(init: ApiErrorInit) {
    const primary = init.messages[0] ?? "Request failed";
    super(primary, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ApiError";
    this.kind = init.kind;
    this.status = init.status;
    this.messages = init.messages;
    this.code = init.code;
    this.details = init.details;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.path = init.path;
    this.method = init.method;
    this.timestamp = init.timestamp;
    this.body = init.body;
  }

  /** Build an `ApiError` from a non-2xx response body. */
  static fromResponse(
    status: number,
    body: unknown,
    ctx: { path?: string; method?: string; headers?: Headers },
  ): ApiError {
    const parsed = isApiErrorBody(body) ? body : undefined;
    const details = parsed && isPlainObject(parsed.details) ? (parsed.details as ApiErrorDetails) : undefined;
    return new ApiError({
      kind: kindForStatus(status),
      status,
      messages: toMessages(parsed?.message, `HTTP ${status}`),
      code: extractErrorCode(body),
      body: parsed,
      details,
      retryAfterSeconds: extractRetryAfterSeconds(body, ctx.headers),
      path: parsed?.path ?? ctx.path,
      method: ctx.method,
      timestamp: parsed?.timestamp,
    });
  }

  static network(message: string, cause: unknown, ctx: { path?: string; method?: string }): ApiError {
    return new ApiError({
      kind: "network",
      status: 0,
      messages: [message],
      path: ctx.path,
      method: ctx.method,
      cause,
    });
  }

  static aborted(ctx: { path?: string; method?: string }): ApiError {
    return new ApiError({ kind: "aborted", status: 0, messages: ["Request aborted"], ...ctx });
  }

  static timeout(ms: number, ctx: { path?: string; method?: string }): ApiError {
    return new ApiError({
      kind: "timeout",
      status: 0,
      messages: [`Request timed out after ${ms}ms`],
      ...ctx,
    });
  }
}

/** Type guard usable across module boundaries (survives bundler duplication). */
export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError || (isPlainObject(value) && value["name"] === "ApiError");
}

export const isUnauthorized = (e: unknown): boolean => isApiError(e) && e.status === 401;
export const isForbidden = (e: unknown): boolean => isApiError(e) && e.status === 403;
export const isNotFound = (e: unknown): boolean => isApiError(e) && e.status === 404;
export const isConflict = (e: unknown): boolean => isApiError(e) && e.status === 409;
export const isRateLimited = (e: unknown): boolean => isApiError(e) && e.status === 429;
export const isValidationError = (e: unknown): boolean => isApiError(e) && e.kind === "validation";
export const isAborted = (e: unknown): boolean => isApiError(e) && e.kind === "aborted";

/**
 * Non-enumerating resource lookup.
 *
 * The API answers "you may not see this" and "this does not exist" with 403 and
 * 404 respectively. A UI that renders those differently re-introduces the
 * enumeration oracle the server is trying to close. Use this guard for any
 * *lookup by id* and render one identical "not found" state for both.
 */
export function isMissingOrForbidden(e: unknown): boolean {
  return isNotFound(e) || isForbidden(e);
}

/** Domain conflict code for a 409, if the server supplied one. */
export function conflictCode(e: unknown): string | undefined {
  return isApiError(e) && e.status === 409 ? e.code : undefined;
}
