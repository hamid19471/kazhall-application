/**
 * Pagination normalization.
 *
 * The API is genuinely inconsistent here. Verified shapes (see the endpoint
 * table in `resources/`):
 *
 * | endpoint            | rows at        | page-count key |
 * |---------------------|----------------|----------------|
 * | `GET /products`     | `body.data`    | `totalPages`   |  ← pagination at TOP LEVEL
 * | `GET /customer`     | `body.data`    | `totalPages`   |  ← TOP LEVEL
 * | `GET /reports/sales`| `body.data`    | `totalPages`   |  ← TOP LEVEL
 * | `GET /users`        | `body.data.data` | `totalPages` |  ← NESTED under `data`
 * | `GET /me/orders`    | `body.data.data` | `totalPages` |  ← NESTED
 * | `GET /address`      | `body.data.data` | **`tatalPage`** |  ← NESTED + typo
 * | `GET /me/addresses` | `body.data.data` | **`totalPage`** |  ← NESTED + different typo
 *
 * `totalPages`, `totalPage` and `tatalPage` are all real, shipped spellings.
 * Rather than teach every call site the difference, {@link normalizePage}
 * absorbs all three plus both nestings and returns one honest `Page<T>`.
 *
 * Query limits also differ: `PaginationDto` is `page=1, limit=10 (max 100)`;
 * `SalesReportQueryDto` is `page=1, limit=20 (max 200)`.
 */

import { isPlainObject } from "./envelope";

/** Normalized pagination metadata. Always complete, always consistent. */
export interface PageInfo {
  page: number;
  limit: number;
  /** Total matching rows across all pages. */
  total: number;
  /** Normalized from `totalPages` | `totalPage` | `tatalPage`, or derived. */
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/** A normalized page of rows. */
export interface Page<T> {
  items: T[];
  pageInfo: PageInfo;
}

/** Query params accepted by `PaginationDto`-based endpoints. */
export interface PageQuery {
  /** 1-based. Server default 1, minimum 1. */
  page?: number;
  /** Server default 10 (20 for `/reports/sales`); max 100 (200 for reports). */
  limit?: number;
}

export const DEFAULT_PAGE_LIMIT = 10;
export const MAX_PAGE_LIMIT = 100;
export const REPORTS_DEFAULT_PAGE_LIMIT = 20;
export const REPORTS_MAX_PAGE_LIMIT = 200;

/** Every spelling of the page-count field we have seen on the wire. */
const TOTAL_PAGES_KEYS = ["totalPages", "totalPage", "tatalPage", "pageCount"] as const;
const TOTAL_KEYS = ["total", "totalItems", "totalCount", "count"] as const;
const PAGE_KEYS = ["page", "currentPage", "pageNumber"] as const;
const LIMIT_KEYS = ["limit", "pageSize", "perPage", "take"] as const;
/** Containers that some endpoints nest their pagination inside. */
const NESTED_META_KEYS = ["meta", "pagination", "pageInfo", "paging"] as const;

function readNumber(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function hasAnyPaginationKey(source: Record<string, unknown>): boolean {
  return (
    readNumber(source, TOTAL_KEYS) !== undefined ||
    readNumber(source, TOTAL_PAGES_KEYS) !== undefined ||
    readNumber(source, PAGE_KEYS) !== undefined
  );
}

/**
 * Find the object that actually carries the pagination numbers.
 * Checks the payload itself, then `data`, then the usual meta containers.
 */
function findPaginationSource(payload: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(payload)) return undefined;
  if (hasAnyPaginationKey(payload)) return payload;

  const nestedData = payload["data"];
  if (isPlainObject(nestedData) && hasAnyPaginationKey(nestedData)) return nestedData;

  for (const key of NESTED_META_KEYS) {
    const candidate = payload[key];
    if (isPlainObject(candidate) && hasAnyPaginationKey(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Find the row array. Tries an explicit key, then `data`, then `data.data`,
 * then the other common names, then the first array-valued own property.
 */
function findItems(payload: unknown, itemsKey?: string): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isPlainObject(payload)) return [];

  if (itemsKey) {
    const explicit = payload[itemsKey];
    if (Array.isArray(explicit)) return explicit;
  }

  const direct = payload["data"];
  if (Array.isArray(direct)) return direct;
  if (isPlainObject(direct)) {
    const nested = direct["data"];
    if (Array.isArray(nested)) return nested;
    for (const key of ["items", "results", "rows"]) {
      const candidate = direct[key];
      if (Array.isArray(candidate)) return candidate;
    }
  }

  for (const key of ["items", "results", "rows"]) {
    const candidate = payload[key];
    if (Array.isArray(candidate)) return candidate;
  }

  for (const value of Object.values(payload)) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

/**
 * Normalize any of the API's paginated payloads into a `Page<T>`.
 *
 * `payload` is the UNWRAPPED envelope body (what `client.get` returns), so it
 * works for both the top-level and the nested-under-`data` layouts.
 *
 * The `T` cast is the honest boundary: the wire is untyped, and every resource
 * helper names the row type exactly once at the call site.
 */
export function normalizePage<T>(payload: unknown, itemsKey?: string): Page<T> {
  const items = findItems(payload, itemsKey) as T[];
  const source = findPaginationSource(payload) ?? {};

  const page = readNumber(source, PAGE_KEYS) ?? 1;
  const limit = readNumber(source, LIMIT_KEYS) ?? (items.length > 0 ? items.length : DEFAULT_PAGE_LIMIT);
  const total = readNumber(source, TOTAL_KEYS) ?? items.length;

  const reportedTotalPages = readNumber(source, TOTAL_PAGES_KEYS);
  const derivedTotalPages = limit > 0 ? Math.max(1, Math.ceil(total / limit)) : 1;
  const totalPages =
    reportedTotalPages !== undefined && reportedTotalPages > 0 ? reportedTotalPages : derivedTotalPages;

  return {
    items,
    pageInfo: {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
    },
  };
}

/** Clamp a page query to the server's accepted window. */
export function clampPageQuery(
  query: PageQuery | undefined,
  maxLimit: number = MAX_PAGE_LIMIT,
  defaultLimit: number = DEFAULT_PAGE_LIMIT,
): Required<PageQuery> {
  const page = Math.max(1, Math.trunc(query?.page ?? 1));
  const rawLimit = Math.trunc(query?.limit ?? defaultLimit);
  const limit = Math.min(maxLimit, Math.max(1, rawLimit));
  return { page, limit };
}
