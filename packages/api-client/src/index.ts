/**
 * `@kazhal/api-client` — the shared, framework-agnostic API layer for
 * `apps/web` and `apps/store`.
 *
 * Nothing here imports React or Next.js; it is plain TypeScript over `fetch`.
 * The optional React bindings live in `@kazhal/api-client/react` and are marked
 * `"use client"`.
 *
 * ## Placement
 *
 * This package is wired into both apps through **tsconfig `paths`**, not through
 * `dependencies` — deliberately, so no `package.json` or `pnpm-lock.yaml` change
 * is needed. Turbopack resolves `paths` and compiles the source in place.
 *
 * ```jsonc
 * // apps/web/tsconfig.json
 * "paths": {
 *   "@kazhal/api-client":   ["../../packages/api-client/src/index.ts"],
 *   "@kazhal/api-client/*": ["../../packages/api-client/src/*"]
 * }
 * ```
 *
 * ## Quick start
 *
 * ```ts
 * import { createKazhalApi, isMissingOrForbidden } from "@kazhal/api-client";
 *
 * export const api = createKazhalApi();
 *
 * const page = await api.catalog.listProducts({ page: 1, limit: 24 });
 * page.items;          // ProductListItem[]
 * page.pageInfo;       // { page, limit, total, totalPages, hasNextPage, … }
 *
 * const session = await api.auth.me();   // null when signed out — never decode the JWT
 * ```
 *
 * ## Five things that will bite you if you skip the docs
 *
 * 1. Success envelopes come in TWO shapes. Objects are SPREAD into
 *    `{...payload, success, timeStamp}`; arrays and primitives nest under
 *    `data`. Every helper here already picks the right mode.
 * 2. `message` on an error may be a **string OR a string array** — the
 *    ValidationPipe returns arrays. Use `error.messages` (always an array).
 * 3. The machine-readable code is `body.error ?? body.details?.code`. Never
 *    parse the human message. Use `error.code`.
 * 4. 403 and 404 must render **identically** for a lookup by id — see
 *    `isMissingOrForbidden`. Distinguishing them re-opens the enumeration
 *    oracle the server closes.
 * 5. Realtime frames are advisory. HTTP is authoritative. Always refetch on
 *    `onResync`.
 */

export * from "./config";
export * from "./envelope";
export * from "./errors";
export * from "./idempotency";
export * from "./pagination";
export * from "./auth-coordinator";
export * from "./http";
export * from "./types";
export * from "./resources";
export * from "./realtime";

import { ApiClient, type ApiClientOptions, createApiClient } from "./http";
export { API_AUDIENCES, authRoutes, type ApiAudience } from "./audience";
import { createRealtimeClient, type RealtimeClient, type RealtimeTransport } from "./realtime/client";
import {
  createAddressResource,
  createAdminResource,
  createAuthResource,
  createBranchResource,
  createCartResource,
  createCatalogResource,
  createHealthResource,
  createInventoryResource,
  createOrdersResource,
  createPaymentResource,
  createReconciliationResource,
} from "./resources";

/** The full, resource-grouped API surface. */
export interface KazhalApi {
  /** The underlying transport, for endpoints not yet wrapped. */
  client: ApiClient;
  auth: ReturnType<typeof createAuthResource>;
  catalog: ReturnType<typeof createCatalogResource>;
  cart: ReturnType<typeof createCartResource>;
  orders: ReturnType<typeof createOrdersResource>;
  payment: ReturnType<typeof createPaymentResource>;
  /** The manual reconciliation queue (owner decision D-2). `super_admin` only. */
  reconciliation: ReturnType<typeof createReconciliationResource>;
  address: ReturnType<typeof createAddressResource>;
  branch: ReturnType<typeof createBranchResource>;
  inventory: ReturnType<typeof createInventoryResource>;
  admin: ReturnType<typeof createAdminResource>;
  health: ReturnType<typeof createHealthResource>;
}

export interface KazhalApiOptions extends ApiClientOptions {
  /** Reuse an existing client instead of creating one. */
  client?: ApiClient;
}

export function createKazhalApi(options: KazhalApiOptions): KazhalApi {
  const { client: provided, ...clientOptions } = options;
  const client = provided ?? createApiClient(clientOptions);
  return {
    client,
    auth: createAuthResource(client),
    catalog: createCatalogResource(client),
    cart: createCartResource(client),
    orders: createOrdersResource(client),
    payment: createPaymentResource(client),
    reconciliation: createReconciliationResource(client),
    address: createAddressResource(client),
    branch: createBranchResource(client),
    inventory: createInventoryResource(client),
    admin: createAdminResource(client),
    health: createHealthResource(client),
  };
}

/**
 * Convenience: an API surface plus a realtime client wired to the same
 * transport, so a failed refresh tears the socket/poller down automatically.
 */
export function createKazhalRealtime(
  api: KazhalApi,
  transport?: RealtimeTransport,
): RealtimeClient {
  return createRealtimeClient({
    client: api.client,
    ...(transport ? { transport } : {}),
  });
}
