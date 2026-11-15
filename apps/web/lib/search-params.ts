/**
 * Reading the URL.
 *
 * In Next 16 `searchParams` is a `Promise` and its values are
 * `string | string[] | undefined` — a repeated key really does arrive as an
 * array. Everything below takes the FIRST value and validates it, because a
 * filter is a scalar and `?page=2&page=99` must not become `NaN` or, worse,
 * `"2,99"` on its way into a query string the API will reject.
 */

export type RawSearchParams = Record<string, string | string[] | undefined>;

export function first(params: RawSearchParams, key: string): string | undefined {
  const value = params[key];
  if (Array.isArray(value)) return value[0];
  return value;
}

/** A positive integer, or `undefined`. Never `NaN`, never negative, never a float. */
export function intParam(params: RawSearchParams, key: string): number | undefined {
  const raw = first(params, key);
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

/** 1-based page number, clamped to >= 1. */
export function pageParam(params: RawSearchParams): number {
  const parsed = intParam(params, "page");
  return parsed !== undefined && parsed >= 1 ? parsed : 1;
}

/** Trimmed, length-capped free text. Empty becomes `undefined`, not `""`. */
export function textParam(params: RawSearchParams, key: string, maxLength = 200): string | undefined {
  const raw = first(params, key);
  if (raw === undefined) return undefined;
  const trimmed = raw.trim().slice(0, maxLength);
  return trimmed === "" ? undefined : trimmed;
}

/** Accepts the same spellings the API's own boolean transformer does. */
export function boolParam(params: RawSearchParams, key: string): boolean | undefined {
  const raw = first(params, key)?.trim().toLowerCase();
  if (raw === undefined || raw === "") return undefined;
  if (["true", "1", "yes", "on"].includes(raw)) return true;
  if (["false", "0", "no", "off"].includes(raw)) return false;
  return undefined;
}

/** Only a value from the allow-list survives; anything else is dropped. */
export function enumParam<T extends string>(
  params: RawSearchParams,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const raw = first(params, key);
  if (raw === undefined) return undefined;
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined;
}

/** `YYYY-MM-DD`, the only date shape the reports API accepts. */
export function localDateParam(params: RawSearchParams, key: string): string | undefined {
  const raw = first(params, key);
  if (raw === undefined) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
}
