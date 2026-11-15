/**
 * Response envelope shapes produced by the Kazhal API.
 *
 * The server's `ResponseFormatInterceptor` does NOT produce a single uniform
 * shape. Its rule is:
 *
 *   - a **plain object** payload is SPREAD into the envelope:
 *       `{ success: true, timeStamp, ...payload }`
 *   - **anything else** (array, primitive, `null`, `Date`, `Buffer`, stream) is
 *     nested:
 *       `{ success: true, timeStamp, data: payload }`
 *   - a value that already looks like an envelope is passed through untouched.
 *
 * That difference is real and per-endpoint, so it is typed honestly here rather
 * than papered over with a single `ApiResponse<T>` lie.
 */

/** Fields the interceptor always adds to a successful response. */
export interface EnvelopeMeta {
  success: true;
  /** ISO-8601. Note the server spelling: `timeStamp` (capital S). */
  timeStamp: string;
}

/** Envelope for endpoints whose payload is a plain object (spread form). */
export type SpreadEnvelope<TPayload extends object> = EnvelopeMeta & TPayload;

/** Envelope for endpoints whose payload is an array/primitive (nested form). */
export type DataEnvelope<TPayload> = EnvelopeMeta & { data: TPayload };

/** Either envelope shape. */
export type SuccessEnvelope<TPayload> = TPayload extends object
  ? SpreadEnvelope<TPayload> | DataEnvelope<TPayload>
  : DataEnvelope<TPayload>;

/**
 * How to unwrap a success envelope into the payload the caller wants.
 *
 * - `"spread"` — strip `success`/`timeStamp`, return the remaining own keys.
 *   Use for endpoints returning a single object (`/auth/<audience>/me`,
 *   `/orders/:id`, …).
 * - `"data"`   — return `body.data`. Use for endpoints returning arrays or
 *   primitives (`/branch`, health checks, …).
 * - `"auto"`   — detect: if the body's only keys besides the meta keys are
 *   exactly `data`, unwrap `data`; otherwise spread-strip. Correct for every
 *   endpoint except an object payload that itself has a single `data` key and
 *   nothing else — pass an explicit mode there.
 * - `"raw"`    — return the parsed body untouched, envelope included.
 */
export type EnvelopeMode = "spread" | "data" | "auto" | "raw";

const META_KEYS = ["success", "timeStamp"] as const;

/** True for object literals / class instances (not arrays, not `null`). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when the value carries the server's success-envelope marker fields. */
export function isSuccessEnvelope(value: unknown): value is EnvelopeMeta & Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  return value["success"] === true && typeof value["timeStamp"] === "string";
}

/** Read the server timestamp off an envelope, if present. */
export function envelopeTimestamp(value: unknown): string | undefined {
  if (!isSuccessEnvelope(value)) return undefined;
  const ts = value["timeStamp"];
  return typeof ts === "string" ? ts : undefined;
}

function stripMeta(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(body)) {
    if ((META_KEYS as readonly string[]).includes(key)) continue;
    out[key] = body[key];
  }
  return out;
}

/**
 * Unwrap a parsed response body according to `mode`.
 *
 * The cast to `T` is unavoidable — the wire is untyped — so the call site is
 * responsible for naming the shape it expects. Every resource helper in
 * `resources/` does exactly that in one place.
 */
export function unwrapEnvelope<T>(body: unknown, mode: EnvelopeMode): T {
  if (mode === "raw") return body as T;

  // A non-envelope body (e.g. an endpoint that bypasses the interceptor, or a
  // 204 turned into `null`) is returned as-is; there is nothing to unwrap.
  if (!isSuccessEnvelope(body)) return body as T;

  if (mode === "data") return body["data"] as T;
  if (mode === "spread") return stripMeta(body) as T;

  // auto
  const rest = stripMeta(body);
  const keys = Object.keys(rest);
  if (keys.length === 1 && keys[0] === "data") return rest["data"] as T;
  return rest as T;
}
