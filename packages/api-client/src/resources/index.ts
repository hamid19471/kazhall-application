/**
 * Typed endpoint helpers.
 *
 * Every helper names, in ONE place, three things the wire cannot tell us:
 *  - the route
 *  - the envelope mode (`"spread"` vs `"data"` — see `envelope.ts`)
 *  - the payload type
 *
 * so no call site ever has to remember that `/branch/:id` spreads its object
 * while `/branch` nests its array, or that `/address` misspells its page count.
 */

import { authRoutes } from "../audience";
import { isApiError } from "../errors";
import type { ApiClient, QueryParams, RequestOptions } from "../http";
import type { IdempotentAttempt } from "../idempotency";
import {
  type Page,
  type PageQuery,
  REPORTS_DEFAULT_PAGE_LIMIT,
  REPORTS_MAX_PAGE_LIMIT,
  clampPageQuery,
  normalizePage,
} from "../pagination";
import type {
  Address,
  AdjustVariantStockBody,
  AdminProduct,
  AvailabilitySnapshot,
  CreateProductBody,
  ImageView,
  ProductAttribute,
  StockAdjustResult,
  UpdateProductBody,
  Branch,
  CartLine,
  CartView,
  Category,
  CheckoutPreview,
  CheckoutResult,
  CreateAddressBody,
  CreateBranchBody,
  CreateOrderBody,
  CreatePosOrderBody,
  CustomerOrder,
  HealthReport,
  PaymentStartResult,
  PaymentVerifyResult,
  PosSaleResult,
  ProductListItem,
  ProductQuery,
  PublicProduct,
  Session,
  SkuLookupResult,
  UpdateAddressBody,
  UserRole,
  GeneratedProductCode,
  GeneratedVariantCode,
} from "../types";

/** Per-call options every helper accepts. Cancellation lives here. */
export type CallOptions = Pick<
  RequestOptions,
  "signal" | "cache" | "next" | "timeoutMs" | "headers" | "meta"
>;

/** Options for the two routes that REQUIRE an `Idempotency-Key`. */
export interface IdempotentCallOptions extends CallOptions {
  /**
   * The logical attempt this call belongs to. Reuse the same object across
   * every retry of that attempt; call `renew()` only when starting over.
   * Omitted → a fresh key is minted for this single call.
   */
  attempt?: IdempotentAttempt | string;
}

/**
 * Narrow an arbitrary options object down to the primitives a query string can
 * carry, dropping `undefined`/`null` entries.
 *
 * The parameter is `object`, not `Record<string, unknown>`: an INTERFACE has no
 * index signature, so `ProductQuery` or `SalesReportQuery` would not be
 * assignable to the record form even though every one of their properties is
 * perfectly fine here. Widening the parameter is the fix; casting at the call
 * sites would just hide the same mismatch five times over.
 */
function toQuery(input: object | undefined): QueryParams | undefined {
  if (!input) return undefined;
  const out: QueryParams = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      out[key] = value as Array<string | number>;
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

export function createAuthResource(client: ApiClient) {
  // Derived once from the client's audience: a surface cannot call another
  // surface's auth routes even by mistake, because it never learns their paths.
  const routes = authRoutes(client.audience);
  return {
    /**
     * The ONLY authoritative session source. Returns `null` when signed out
     * rather than throwing, because "am I signed in?" is a question, not an error.
     */
    async me(options: CallOptions = {}): Promise<Session | null> {
      try {
        // `{ data: SessionView }` → nested form.
        return await client.get<Session>(routes.me, { ...options, envelope: "data" });
      } catch (error) {
        if (isApiError(error) && error.status === 401) return null;
        throw error;
      }
    },

    /** Sets `access_token` + `refresh_token` cookies. Returns no tokens. */
    async login(
      body: { username: string; password: string },
      options: CallOptions = {},
    ): Promise<{ message: string }> {
      const result = await client.post<{ message: string }>(routes.login, body, {
        ...options,
        envelope: "spread",
        auth: false,
      });
      client.auth.markSignedIn();
      return result;
    },

    /** 429 here carries `details.retryAfterSeconds` and `error: OTP_COOLDOWN`. */
    sendOtp(body: { mobile: string }, options: CallOptions = {}): Promise<{ message: string }> {
      return client.post<{ message: string }>(routes.sendOtp, body, {
        ...options,
        envelope: "spread",
        auth: false,
      });
    },

    /** Creates the customer account on first success and sets both cookies. */
    async verifyOtp(
      body: { mobile: string; code: string },
      options: CallOptions = {},
    ): Promise<{ message: string }> {
      const result = await client.post<{ message: string }>(routes.verifyOtp, body, {
        ...options,
        envelope: "spread",
        auth: false,
      });
      client.auth.markSignedIn();
      return result;
    },

    /**
     * Force a refresh through the single-flight coordinator. You almost never
     * need this — the client refreshes automatically on a 401.
     */
    refresh(): Promise<boolean> {
      return client.auth.runRefresh();
    },

    /** Idempotent: returns `revoked: 0` when there was no valid cookie. */
    async logout(options: CallOptions = {}): Promise<{ message: string; revoked: number }> {
      const result = await client.post<{ message: string; revoked: number }>(routes.logout, undefined, {
        ...options,
        envelope: "spread",
        auth: false,
      });
      client.auth.signOut("logout");
      return result;
    },

    async logoutAll(options: CallOptions = {}): Promise<{ message: string; revoked: number }> {
      const result = await client.post<{ message: string; revoked: number }>(
        routes.logoutAll,
        undefined,
        { ...options, envelope: "spread" },
      );
      client.auth.signOut("logout");
      return result;
    },

    /**
     * Change your OWN password.
     *
     * Requires the CURRENT password as well as the session: a cookie proves
     * the browser signed in once, not that the owner is at the keyboard.
     *
     * ON SUCCESS THE CALLER IS SIGNED OUT. Every session of this user, in
     * every audience and on every device, is invalidated server-side — that is
     * the point of a password change — so the client marks itself signed out
     * rather than leaving a dead cookie to fail on the next call. Send the
     * user back to the sign-in form.
     *
     * This is also the only route that clears `mustChangePassword`, and it is
     * reachable while that flag is set (every other route answers 403
     * `PASSWORD_CHANGE_REQUIRED` until it is cleared).
     */
    async changePassword(
      body: { currentPassword: string; newPassword: string },
      options: CallOptions = {},
    ): Promise<{ message: string }> {
      const result = await client.post<{ message: string }>(
        routes.changePassword,
        body,
        { ...options, envelope: "spread" },
      );
      client.auth.signOut("logout");
      return result;
    },

    /** `super_admin` only. Note the response key is `user`, not `data`. */
    register(
      body: { username: string; password: string; role?: UserRole[]; branchId?: number },
      options: CallOptions = {},
    ): Promise<{ message: string; user: unknown }> {
      return client.post<{ message: string; user: unknown }>("/auth/register", body, {
        ...options,
        envelope: "spread",
      });
    },
  };
}

// ---------------------------------------------------------------------------

export function createCatalogResource(client: ApiClient) {
  return {
    /**
     * `GET /products` — pagination lives at the TOP LEVEL of the envelope
     * (`data`, `total`, `page`, `limit`, `totalPages` are all siblings of
     * `success`). `normalizePage` absorbs that.
     */
    async listProducts(
      query: ProductQuery = {},
      options: CallOptions = {},
    ): Promise<Page<ProductListItem>> {
      const { page, limit } = clampPageQuery(query);
      const body = await client.get<unknown>("/products", {
        ...options,
        envelope: "spread",
        query: toQuery({ ...query, page, limit }),
      });
      return normalizePage<ProductListItem>(body);
    },

    /** Public detail. Only ACTIVE variants; availability recomputed per request. */
    getProduct(id: number, options: CallOptions = {}): Promise<PublicProduct> {
      return client.get<PublicProduct>(`/products/${id}`, { ...options, envelope: "data" });
    },

    /** `super_admin`. Declared before `/products/:id` on the server. */
    getProductAdmin(id: number, options: CallOptions = {}): Promise<AdminProduct> {
      return client.get<AdminProduct>(`/products/admin/${id}`, { ...options, envelope: "data" });
    },

    /** Toggle. Owner comes from the cookie; the body carries only the product. */
    toggleBookmark(
      productId: number,
      options: CallOptions = {},
    ): Promise<{ message: string; data: { bookmarked: boolean } }> {
      return client.post<{ message: string; data: { bookmarked: boolean } }>(
        "/products/bookmark",
        { productId },
        { ...options, envelope: "spread" },
      );
    },

    /** NOT paginated: a bare array under `data`. */
    listCategories(options: CallOptions = {}): Promise<Category[]> {
      return client.get<Category[]>("/categories", { ...options, envelope: "data" });
    },

    listAttributes(options: CallOptions = {}): Promise<ProductAttribute[]> {
      return client.get<ProductAttribute[]>("/attributes", { ...options, envelope: "data" });
    },

    /** `super_admin`. Creates the product, its variants, categories and images atomically. */
    createProduct(
      body: CreateProductBody,
      options: CallOptions = {},
    ): Promise<{ message: string; data: AdminProduct }> {
      return client.post<{ message: string; data: AdminProduct }>("/products", body, {
        ...options,
        envelope: "spread",
      });
    },

    /**
     * `super_admin`. PARTIAL upsert.
     *
     *  - `variants` entries WITHOUT `id` create; WITH `id` update; unmentioned
     *    variants are untouched. `isActive: false` retires a variant — there is
     *    no hard delete, because `order_items` reference it.
     *  - `stock` is honoured ONLY when creating a variant. On an update it is
     *    rejected: stock moves exclusively through the ledger
     *    (`adjustVariantStock`), so every change has a movement row.
     *  - `images` is the COMPLETE desired ordered set. Omit to leave images
     *    alone; `[]` deletes them all.
     */
    updateProduct(
      id: number,
      body: UpdateProductBody,
      options: CallOptions = {},
    ): Promise<{ message: string; data: AdminProduct }> {
      return client.patch<{ message: string; data: AdminProduct }>(`/products/${id}`, body, {
        ...options,
        envelope: "spread",
      });
    },

    /**
     * Allocate a fresh «کد محصول» — `super_admin`, admin audience only.
     *
     * Server-side and concurrency-safe (a PostgreSQL sequence), so two admins
     * clicking «تولید خودکار کد» at the same instant never receive the same
     * value. The code is NOT reserved: abandoning the form simply leaves a gap
     * in the sequence, which is harmless and deliberately not chased.
     */
    generateProductCode(
      options: CallOptions = {},
    ): Promise<GeneratedProductCode> {
      return client.post<GeneratedProductCode>(
        "/products/admin/codes/product",
        {},
        { ...options, envelope: "data" },
      );
    },

    /**
     * Allocate a fresh «کد گونه» under `productCode`.
     *
     * The parent is normalised server-side and echoed back, so a caller that
     * sent a half-typed or Persian-digit code learns the canonical form it
     * must store alongside the child.
     */
    generateVariantCode(
      productCode: string,
      options: CallOptions = {},
    ): Promise<GeneratedVariantCode> {
      return client.post<GeneratedVariantCode>(
        "/products/admin/codes/variant",
        { productCode },
        { ...options, envelope: "data" },
      );
    },

    /**
     * `super_admin`. Reservation-aware stock movement.
     *
     * The below-reserved refusal has TWO statuses — 409 `STOCK_BELOW_RESERVED`
     * from the pre-check and 400 from the authoritative re-check under the
     * variant lock. Treat both as the SAME refusal; `details` carries
     * `requestedStock` / `physicalStock` / `basketReserved` / `orderAllocated`.
     */
    adjustVariantStock(
      variantId: number,
      body: AdjustVariantStockBody,
      options: CallOptions = {},
    ): Promise<{ message: string; data: StockAdjustResult }> {
      return client.post<{ message: string; data: StockAdjustResult }>(
        `/products/variants/${variantId}/stock/adjust`,
        body,
        { ...options, envelope: "spread" },
      );
    },

    /**
     * `super_admin`. Returns a DETACHED image; attach it by listing its id in a
     * product create/update `images` array. The field name must be `file`.
     */
    uploadImage(
      file: File | Blob,
      options: CallOptions = {},
    ): Promise<{ message: string; data: ImageView }> {
      const form = new FormData();
      form.append("file", file);
      // No Content-Type header: the browser must set the multipart boundary.
      return client.post<{ message: string; data: ImageView }>("/products/uploadImage", form, {
        ...options,
        envelope: "spread",
      });
    },

    /** `super_admin`. The category list is otherwise public. */
    createCategory(
      body: { title: string },
      options: CallOptions = {},
    ): Promise<{ message: string; data: unknown }> {
      return client.post<{ message: string; data: unknown }>("/categories", body, {
        ...options,
        envelope: "spread",
      });
    },
  };
}

// ---------------------------------------------------------------------------

export function createCartResource(client: ApiClient) {
  return {
    /**
     * `GET /cart` — `notices` is a SIBLING of `data`, so this uses the spread
     * mode and returns both. Also the recovery path for missed realtime frames:
     * it lazily expires reservations before answering, so its result is
     * authoritative in a way an `availability:updated` frame never is.
     */
    get(options: CallOptions = {}): Promise<CartView> {
      return client.get<CartView>("/cart", { ...options, envelope: "spread" });
    },

    /** Reserves stock for 4 hours. */
    add(
      body: { productId: number; variantId?: number; quantity: number },
      options: CallOptions = {},
    ): Promise<{ message: string; data: CartLine }> {
      return client.post<{ message: string; data: CartLine }>("/cart", body, {
        ...options,
        envelope: "spread",
      });
    },

    /** `quantity` is ABSOLUTE; `0` removes the line and returns `data: null`. */
    setQuantity(
      lineId: number,
      quantity: number,
      options: CallOptions = {},
    ): Promise<{ message: string; data: CartLine | null }> {
      return client.patch<{ message: string; data: CartLine | null }>(
        `/cart/${lineId}`,
        { quantity },
        { ...options, envelope: "spread" },
      );
    },

    /** NOT idempotent — a second delete is a 404. */
    remove(lineId: number, options: CallOptions = {}): Promise<{ message: string }> {
      return client.delete<{ message: string }>(`/cart/${lineId}`, undefined, {
        ...options,
        envelope: "spread",
      });
    },
  };
}

// ---------------------------------------------------------------------------

export function createOrdersResource(client: ApiClient) {
  return {
    /** `POST /orders/quote` — a 200 with no body. Customers (`site`) only. */
    quote(options: CallOptions = {}): Promise<CheckoutPreview> {
      return client.post<CheckoutPreview>("/orders/quote", undefined, {
        ...options,
        envelope: "data",
      });
    },

    /**
     * Online checkout. `Idempotency-Key` is REQUIRED.
     *
     * Resend the SAME key for every retry of one attempt: a rolled-back request
     * rolls its key back too, and a completed one replays its original response
     * verbatim (one sale, one stock decrement). `quoteToken` is deliberately not
     * part of the server's request hash, so refreshing the quote and retrying
     * with the same key is correct, not reuse.
     */
    checkout(
      body: CreateOrderBody,
      options: IdempotentCallOptions = {},
    ): Promise<{ message: string; data: CheckoutResult }> {
      return client.post<{ message: string; data: CheckoutResult }>("/orders", body, {
        ...stripAttempt(options),
        envelope: "spread",
        idempotencyKey: options.attempt ?? client.newIdempotencyKey("checkout"),
      });
    },

    /** In-store sale (`sale` / `super_admin`). `Idempotency-Key` is REQUIRED. */
    posSale(
      body: CreatePosOrderBody,
      options: IdempotentCallOptions = {},
    ): Promise<{ message: string; data: PosSaleResult }> {
      return client.post<{ message: string; data: PosSaleResult }>("/orders/pos", body, {
        ...stripAttempt(options),
        envelope: "spread",
        idempotencyKey: options.attempt ?? client.newIdempotencyKey("pos"),
      });
    },

    /** Staff list. NOT paginated; branch-scoped for a `sale` user. */
    listStaffOrders(options: CallOptions = {}): Promise<unknown[]> {
      return client.get<unknown[]>("/orders", { ...options, envelope: "data" });
    },

    /** Staff detail. An out-of-branch order is a 403 here (not a 404). */
    getStaffOrder(id: number, options: CallOptions = {}): Promise<unknown> {
      return client.get<unknown>(`/orders/${id}`, { ...options, envelope: "data" });
    },

    /** Audit trail, oldest first. Empty array, never a 404. */
    getOrderActions(id: number, options: CallOptions = {}): Promise<unknown[]> {
      return client.get<unknown[]>(`/orders/${id}/actions`, { ...options, envelope: "data" });
    },

    /** `canceled`/`refunded` must go through `void`/`return`, not this. */
    updateStatus(
      id: number,
      status: string,
      options: CallOptions = {},
    ): Promise<{ message: string; data: unknown }> {
      return client.patch<{ message: string; data: unknown }>(
        `/orders/status/${id}`,
        { status },
        { ...options, envelope: "spread" },
      );
    },

    void(id: number, reason?: string, options: CallOptions = {}): Promise<{ message: string; data: unknown }> {
      return client.post<{ message: string; data: unknown }>(
        `/orders/${id}/void`,
        reason === undefined ? {} : { reason },
        { ...options, envelope: "spread" },
      );
    },

    return(
      id: number,
      reason?: string,
      options: CallOptions = {},
    ): Promise<{ message: string; data: unknown }> {
      return client.post<{ message: string; data: unknown }>(
        `/orders/${id}/return`,
        reason === undefined ? {} : { reason },
        { ...options, envelope: "spread" },
      );
    },

    /** `GET /me/orders` — pagination NESTED under `data`, key `totalPages`. */
    async listMyOrders(query: PageQuery = {}, options: CallOptions = {}): Promise<Page<CustomerOrder>> {
      const { page, limit } = clampPageQuery(query);
      const body = await client.get<unknown>("/me/orders", {
        ...options,
        envelope: "data",
        query: { page, limit },
      });
      return normalizePage<CustomerOrder>(body);
    },

    /** Another customer's order is a 404 — render it identically to "missing". */
    getMyOrder(id: number, options: CallOptions = {}): Promise<CustomerOrder> {
      return client.get<CustomerOrder>(`/me/orders/${id}`, { ...options, envelope: "data" });
    },
  };
}

function stripAttempt(options: IdempotentCallOptions): CallOptions {
  const { attempt: _attempt, ...rest } = options;
  return rest;
}

// ---------------------------------------------------------------------------

export function createPaymentResource(client: ApiClient) {
  return {
    /** Someone else's order is a 400 here, not a 403. */
    start(orderId: number, options: CallOptions = {}): Promise<{ message: string; data: PaymentStartResult }> {
      return client.post<{ message: string; data: PaymentStartResult }>(
        "/payment/start",
        { orderId },
        { ...options, envelope: "spread" },
      );
    },

    /**
     * Body must be `{ trackId }` ONLY — the global ValidationPipe runs with
     * `forbidNonWhitelisted`, so an extra key is a 400. An unknown or foreign
     * trackId returns an identical 404 (`PAYMENT_ATTEMPT_NOT_FOUND`); a gateway
     * failure is a 502.
     */
    verify(trackId: string, options: CallOptions = {}): Promise<{ message: string; data: PaymentVerifyResult }> {
      return client.post<{ message: string; data: PaymentVerifyResult }>(
        "/payment/verify",
        { trackId },
        { ...options, envelope: "spread" },
      );
    },
  };
}

// ---------------------------------------------------------------------------

export function createAddressResource(client: ApiClient) {
  return {
    /** `GET /me/addresses` — nested, page-count key is `totalPage` (singular). */
    async listMine(query: PageQuery = {}, options: CallOptions = {}): Promise<Page<Address>> {
      const { page, limit } = clampPageQuery(query);
      const body = await client.get<unknown>("/me/addresses", {
        ...options,
        envelope: "data",
        query: { page, limit },
      });
      return normalizePage<Address>(body);
    },

    getMine(id: number, options: CallOptions = {}): Promise<Address> {
      return client.get<Address>(`/me/addresses/${id}`, { ...options, envelope: "data" });
    },

    createMine(body: CreateAddressBody, options: CallOptions = {}): Promise<{ message: string; data: Address }> {
      return client.post<{ message: string; data: Address }>("/me/addresses", body, {
        ...options,
        envelope: "spread",
      });
    },

    updateMine(
      id: number,
      body: UpdateAddressBody,
      options: CallOptions = {},
    ): Promise<{ message: string; data: Address }> {
      return client.patch<{ message: string; data: Address }>(`/me/addresses/${id}`, body, {
        ...options,
        envelope: "spread",
      });
    },

    deleteMine(id: number, options: CallOptions = {}): Promise<{ message: string }> {
      return client.delete<{ message: string }>(`/me/addresses/${id}`, undefined, {
        ...options,
        envelope: "spread",
      });
    },

    /** Admin directory. `super_admin` only; page-count key is `tatalPage` (typo). */
    async listAll(query: PageQuery = {}, options: CallOptions = {}): Promise<Page<Address>> {
      const { page, limit } = clampPageQuery(query);
      const body = await client.get<unknown>("/address", {
        ...options,
        envelope: "data",
        query: { page, limit },
      });
      return normalizePage<Address>(body);
    },
  };
}

// ---------------------------------------------------------------------------

export function createBranchResource(client: ApiClient) {
  return {
    /** The array form: nested under `data`. */
    list(options: CallOptions = {}): Promise<Branch[]> {
      return client.get<Branch[]>("/branch", { ...options, envelope: "data" });
    },

    /**
     * The CALLER'S OWN branch, or `null` when they have none.
     *
     * USE THIS FROM THE TILL. `get(id)` below is admin-audience only, so a POS
     * session calling it gets a 401 — a failed authenticated request on every
     * page load, and a header that falls back to printing the branch NUMBER
     * because it never learned the name. This route serves both surfaces and
     * discloses nothing the caller does not already hold: `branchId` is on
     * their own session.
     */
    mine(options: CallOptions = {}): Promise<Branch | null> {
      return client.get<Branch | null>("/branch/mine", {
        ...options,
        envelope: "data",
      });
    },

    /**
     * One branch by id. ADMIN AUDIENCE ONLY — a till session is refused with
     * 401; use `mine()` there.
     *
     * The object form: SPREAD at top level with no `data` key at all.
     */
    get(id: number, options: CallOptions = {}): Promise<Branch> {
      return client.get<Branch>(`/branch/${id}`, { ...options, envelope: "spread" });
    },

    create(body: CreateBranchBody, options: CallOptions = {}): Promise<Branch> {
      return client.post<Branch>("/branch", body, { ...options, envelope: "spread" });
    },

    update(id: number, body: Partial<CreateBranchBody>, options: CallOptions = {}): Promise<Branch> {
      return client.patch<Branch>(`/branch/${id}`, body, { ...options, envelope: "spread" });
    },

    /** Hard delete; an FK conflict surfaces as a 500. Returns the removed row. */
    remove(id: number, options: CallOptions = {}): Promise<Branch> {
      return client.delete<Branch>(`/branch/${id}`, undefined, { ...options, envelope: "spread" });
    },
  };
}

// ---------------------------------------------------------------------------

export function createInventoryResource(client: ApiClient) {
  return {
    /** Staff only. Unknown SKU is a 404. */
    lookupSku(sku: string, options: CallOptions = {}): Promise<SkuLookupResult> {
      return client.get<SkuLookupResult>("/inventory/lookup", {
        ...options,
        envelope: "data",
        query: { sku },
      });
    },

    /**
     * Staff only. Not paginated.
     *
     * The server accepts at most 100 ids per call, and ONE unknown id fails the
     * WHOLE request with a 404 — so never mix speculative ids in.
     *
     * WHY THE CHUNKING LIVES HERE. It used to be the caller's problem, and the
     * two apps disagreed: the POS till chunked, the storefront did not. A
     * 101-id basket therefore worked in one app and 404'd in the other. The
     * request cap is a property of the endpoint, not of any one screen, so it
     * is enforced once, here. Chunks run concurrently and are re-joined in the
     * caller's original id order; a 404 still fails the whole call, because a
     * partial availability answer is worse than none.
     */
    async availability(
      variantIds: number[],
      options: CallOptions = {},
    ): Promise<AvailabilitySnapshot[]> {
      const unique = [...new Set(variantIds)];
      if (unique.length === 0) return [];

      const CHUNK = 100;
      const chunks: number[][] = [];
      for (let i = 0; i < unique.length; i += CHUNK) {
        chunks.push(unique.slice(i, i + CHUNK));
      }

      const results = await Promise.all(
        chunks.map((chunk) =>
          client.get<AvailabilitySnapshot[]>("/inventory/availability", {
            ...options,
            envelope: "data",
            query: { variantIds: chunk },
          }),
        ),
      );

      const byId = new Map<number, AvailabilitySnapshot>();
      for (const snapshot of results.flat()) byId.set(snapshot.variantId, snapshot);
      return variantIds
        .map((id) => byId.get(id))
        .filter((s): s is AvailabilitySnapshot => s !== undefined);
    },
  };
}

// ---------------------------------------------------------------------------

export function createAdminResource(client: ApiClient) {
  return {
    /** `GET /users` (plural — there is no `/user`). Nested pagination. */
    async listUsers(
      query: PageQuery & { role?: UserRole } = {},
      options: CallOptions = {},
    ): Promise<Page<unknown>> {
      const { page, limit } = clampPageQuery(query);
      const body = await client.get<unknown>("/users", {
        ...options,
        envelope: "data",
        query: toQuery({ page, limit, role: query.role }),
      });
      return normalizePage<unknown>(body);
    },

    /** `GET /customer` (singular). Pagination at the TOP LEVEL. */
    async listCustomers(query: PageQuery = {}, options: CallOptions = {}): Promise<Page<unknown>> {
      const { page, limit } = clampPageQuery(query);
      const body = await client.get<unknown>("/customer", {
        ...options,
        envelope: "spread",
        query: { page, limit },
      });
      return normalizePage<unknown>(body);
    },

    /** Ids here are `customers.id`, NOT `users.id`. */
    getCustomer(id: number, options: CallOptions = {}): Promise<unknown> {
      return client.get<unknown>(`/customer/${id}`, { ...options, envelope: "data" });
    },

    /** Roles list. `super_admin` only. */
    listRoles(options: CallOptions = {}): Promise<Array<{ id: number; name: string }>> {
      return client.get<Array<{ id: number; name: string }>>("/roles", {
        ...options,
        envelope: "data",
      });
    },

    /** Note: this DELETE carries a JSON body. */
    unassignRole(
      body: { userId: number; roleId: number },
      options: CallOptions = {},
    ): Promise<{ message: string }> {
      return client.delete<{ message: string }>("/roles/remove", body, {
        ...options,
        envelope: "spread",
      });
    },

    /**
     * `GET /reports/sales` — TOP-LEVEL pagination with its OWN limits
     * (default 20, max 200, unlike the `PaginationDto` 10/100).
     */
    async salesReport(
      query: PageQuery & Record<string, unknown> = {},
      options: CallOptions = {},
    ): Promise<Page<unknown>> {
      const { page, limit } = clampPageQuery(query, REPORTS_MAX_PAGE_LIMIT, REPORTS_DEFAULT_PAGE_LIMIT);
      const body = await client.get<unknown>("/reports/sales", {
        ...options,
        envelope: "spread",
        query: toQuery({ ...query, page, limit }),
      });
      return normalizePage<unknown>(body);
    },

    /** Summary has NO `data` wrapper at all — everything is top level. */
    salesSummary(
      query: SalesReportQuery = {},
      options: CallOptions = {},
    ): Promise<SalesSummaryResponse> {
      return client.get<SalesSummaryResponse>("/reports/sales/summary", {
        ...options,
        envelope: "spread",
        query: toQuery(query),
      });
    },

    /**
     * `GET /reports/sales`, keeping the envelope's siblings.
     *
     * `salesReport` above throws away `range`, `filters` and `semantics` on its
     * way through `normalizePage`, and those are the parts that make the
     * numbers interpretable (which timezone, which UTC bounds, which branch the
     * server actually resolved). This returns the whole body.
     */
    salesList(
      query: SalesReportQuery = {},
      options: CallOptions = {},
    ): Promise<SalesListResponse> {
      const { page, limit } = clampPageQuery(query, REPORTS_MAX_PAGE_LIMIT, REPORTS_DEFAULT_PAGE_LIMIT);
      return client.get<SalesListResponse>("/reports/sales", {
        ...options,
        envelope: "spread",
        query: toQuery({ ...query, page, limit }),
      });
    },

    /**
     * `GET /reports/sales/by-cashier`.
     *
     * `data` is sliced by the SELLER (`orders.cashierUserId`, written once at
     * sale time). `reversalsByActor` is sliced by whoever PROCESSED a reversal.
     * They are the same money cut two ways — never add them together.
     */
    salesByCashier(
      query: SalesReportQuery = {},
      options: CallOptions = {},
    ): Promise<SalesByCashierResponse> {
      return client.get<SalesByCashierResponse>("/reports/sales/by-cashier", {
        ...options,
        envelope: "spread",
        query: toQuery(query),
      });
    },

    /**
     * `GET /reports/sales/:id`. Line items come from the immutable sale-time
     * snapshots, so the answer is stable after the catalogue changes.
     *
     * NOTE: unlike a customer lookup, this route decides the 404 FIRST, so an
     * out-of-branch `sale` user really can tell "exists elsewhere" (403) from
     * "does not exist" (404). That is the server's choice, not ours.
     */
    saleDetail(id: number, options: CallOptions = {}): Promise<SaleDetailResponse> {
      return client.get<SaleDetailResponse>(`/reports/sales/${id}`, {
        ...options,
        envelope: "spread",
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Reports — response shapes
// ---------------------------------------------------------------------------

export interface SalesReportQuery extends PageQuery {
  /** Inclusive local calendar day, `YYYY-MM-DD`, in the report timezone. */
  from?: string;
  /** Inclusive local calendar day, `YYYY-MM-DD`. */
  to?: string;
  /** The SELLING cashier — not whoever processed a later reversal. */
  cashierUserId?: number;
  /** `super_admin` only; a `sale` user is pinned to their own branch. */
  branchId?: number;
  channel?: "online" | "pos";
  status?: string;
}

/** The resolved range. `endUtc` is EXCLUSIVE — the range is half-open. */
export interface ReportRange {
  from: string | null;
  to: string | null;
  startUtc: string | null;
  endUtc: string | null;
  boundarySql?: string;
}

export interface ReportFilters {
  branchId: number | null;
  cashierUserId: number | null;
  channel: string | null;
  status: string | null;
}

/**
 * INTEGER RIAL AS A BASE-10 STRING — the money contract for every reporting
 * route on this client.
 *
 * WHY A STRING. These are PostgreSQL `bigint` columns and `SUM()`s over them,
 * which PostgreSQL widens to `numeric`; node-postgres returns both as strings
 * so that the driver never decides what to round. The server no longer
 * converts them, because `Number()` is exact only to 2^53 − 1 = 9 007 199 254
 * 740 991 Rial and a year of turnover at these prices is already in the 10^12
 * range — and because `netSales`, a subtraction of two such values, goes wrong
 * before either operand does.
 *
 * DO NOT `Number()` THEM. Render with `formatRialString` (or `<Money>`) from
 * `@kazhal/ui`, which groups the digit string without parsing it, and add them
 * with `addRialStrings`, which is `BigInt` arithmetic. `a + b` on two of these
 * concatenates.
 *
 * `netSales = grossSales − refundedTotal − voidedTotal`, each taken from the
 * same range but from its OWN event date, so nothing is double-counted across
 * two periods, and the subtraction is done in `BigInt` on the server. It can
 * legitimately be NEGATIVE — a month with more returns than sales — so the
 * string may carry a leading `-`.
 *
 * COUNTS STAY NUMBERS. `orderCount`, `salesCount`, `unitsSold` and friends are
 * bounded by the number of rows and line quantities in the database, a range
 * whose smallness is explicit, so widening them would only make every consumer
 * parse a value that was never at risk.
 *
 * THE UNIT IS RIAL, ALWAYS. Nothing in this contract ever appends or removes a
 * zero to convert to Toman; a display that wants Toman divides at the point of
 * display.
 *
 * There is NO profit figure anywhere: cost of goods is not modelled in this
 * system, and `semantics.profit` says so on every response.
 */
export interface SalesTotals {
  orderCount: number;
  salesCount: number;
  nonSaleCount: number;
  pendingCount: number;
  canceledOrFailedCount: number;
  voidedCount: number;
  refundedCount: number;
  /** Integer Rial as a decimal string. */
  grossSales: string;
  /** Integer Rial as a decimal string. */
  refundedTotal: string;
  /** Integer Rial as a decimal string. */
  voidedTotal: string;
  /** Integer Rial as a decimal string. May be negative. */
  netSales: string;
  unitsSold: number;
  unitsVoided: number;
  unitsRefunded: number;
}

/**
 * Refunded orders in scope whose refund date could not be recovered.
 *
 * A DATA-QUALITY FIGURE, NOT A PERIOD TOTAL — never add it into one. It is
 * excluded from a ranged `refundedTotal` and included in an unranged one.
 */
export interface SalesDataQuality {
  refundsWithUnknownEventDate: {
    count: number;
    /** Integer Rial as a decimal string. */
    total: string;
    note: string;
  };
}

export interface SalesSummaryResponse {
  timezone: string;
  range: ReportRange;
  filters: ReportFilters;
  totals: SalesTotals;
  /**
   * Deliberately OUTSIDE `totals`. NOTE THE NESTING: the server has always
   * answered `dataQuality.refundsWithUnknownEventDate.{count,total,note}`, and
   * this type used to declare a flat `{count,total,note}` that no response ever
   * matched.
   */
  dataQuality?: SalesDataQuality;
  semantics: Record<string, string>;
}

/**
 * One row of `GET /reports/sales`.
 *
 * A row is listed when ANY of its money events falls in the range;
 * `soldInRange` / `refundedInRange` / `voidedInRange` say WHICH event put it
 * there and are exactly the booleans the summary aggregates. Note the row's
 * total really is snake_case `total_price` on the wire.
 */
export interface SalesRow {
  id: number;
  orderNumber: string | null;
  channel: string;
  status: string;
  fulfillmentState: string;
  paymentMethod: string | null;
  soldAt: string | null;
  paidAt: string | null;
  voidedAt: string | null;
  refundedAt: string | null;
  revenueAt: string | null;
  countsAsSale: boolean;
  soldInRange: boolean;
  refundedInRange: boolean;
  voidedInRange: boolean;
  branchId: number | null;
  branchNameSnapshot: string | null;
  cashierUserId: number | null;
  cashierDisplaySnapshot: string | null;
  customerId: number | null;
  /** Integer Rial as a decimal string. */
  subtotal: string;
  /** Integer Rial as a decimal string. Snake_case on the wire, deliberately. */
  total_price: string;
  unitCount: number;
}

export interface SalesListResponse {
  timezone: string;
  range: ReportRange;
  filters: ReportFilters;
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  data: SalesRow[];
  semantics: Record<string, string>;
}

/** One SELLER. Money is integer Rial as a decimal string — see {@link SalesTotals}. */
export interface CashierSalesRow {
  cashierUserId: number | null;
  cashierDisplaySnapshot: string | null;
  orderCount: number;
  salesCount: number;
  grossSales: string;
  unitsSold: number;
  refundedCount: number;
  refundedTotal: string;
  voidedCount: number;
  voidedTotal: string;
  /** May be negative. */
  netSales: string;
}

/**
 * One person who PROCESSED a reversal. The same money as
 * {@link CashierSalesRow}'s refund/void totals sliced by a different person —
 * the two lists must never be added together.
 */
export interface ReversalByActorRow {
  actorUserId: number | null;
  actorDisplaySnapshot?: string | null;
  reversalCount: number;
  voidCount: number;
  refundCount: number;
  voidedTotal: string;
  refundedTotal: string;
}

export interface SalesByCashierResponse {
  timezone: string;
  range: ReportRange;
  filters: ReportFilters;
  data: CashierSalesRow[];
  reversalsByActor: ReversalByActorRow[];
  semantics: Record<string, string>;
}

/** One line of a sale, rendered from the immutable sale-time snapshot. */
export interface SaleDetailItem {
  id: number;
  productId: number | null;
  variantId: number | null;
  productTitle: string | null;
  sku: string | null;
  attributes: Record<string, string> | null;
  quantity: number;
  /** Integer Rial as a decimal string. */
  unitPrice: string;
  /** Integer Rial as a decimal string. */
  totalPrice: string;
}

export interface SaleDetail {
  id: number;
  orderNumber: string | null;
  channel: string;
  status: string;
  fulfillmentState: string;
  paymentMethod: string | null;
  soldAt: string | null;
  paidAt: string | null;
  revenueAt: string | null;
  voidedAt: string | null;
  refundedAt: string | null;
  countsAsSale: boolean;
  seller: {
    cashierUserId: number | null;
    cashierDisplaySnapshot: string | null;
    branchId: number | null;
    branchNameSnapshot: string | null;
  };
  reversedBy: {
    action: string;
    actorUserId: number | null;
    actorDisplaySnapshot: string | null;
    reason: string | null;
    at: string;
  } | null;
  customer: { id: number; mobile: string | null; name: string | null } | null;
  /** Integer Rial as a decimal string. */
  subtotal: string;
  /** Integer Rial as a decimal string. */
  totalPrice: string;
  items: SaleDetailItem[];
  actions: Array<{
    id: number;
    action: string;
    fromStatus: string | null;
    toStatus: string | null;
    actorUserId: number | null;
    actorDisplaySnapshot: string | null;
    reason: string | null;
    createdAt: string;
  }>;
}

export interface SaleDetailResponse {
  timezone: string;
  data: SaleDetail;
  semantics: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Manual reconciliation queue (owner decision D-2) — `super_admin` only
//
// THE CASE ID IS THE ORDER ID. There is no separate case identifier: a case is
// a decision about one order, and one order can carry several receipts that
// belong to the same case.
//
// All money on these routes is INTEGER RIAL **as a STRING** — the columns are
// `bigint`, and rounding them through a JavaScript `number` is silent data
// loss. Do not `Number()` them; format the digits directly.
// ---------------------------------------------------------------------------

/** Why an order is in the queue. A case can carry several of these at once. */
export type ReconciliationCaseType =
  | "unapplied_receipt"
  | "fulfilment_incomplete"
  | "awaiting_stock"
  | "operator_open";

/** The mutations the server will honour from a case's CURRENT state. */
export type ReconciliationActionName =
  | "retry_fulfilment"
  | "mark_refund_required"
  | "confirm_external_refund"
  | "mark_backorder"
  | "resolve_no_action";

/** Which kind of "nothing needed to happen" a no-action close asserts. */
export type ReconciliationResolutionType =
  | "no_discrepancy"
  | "settled_externally"
  | "customer_agreed"
  | "gateway_duplicate";

/** The operator lifecycle. `null` (never touched) is NOT the same as `open`. */
export type OrderReconciliationState =
  | "open"
  | "refund_required"
  | "refund_confirmed"
  | "backordered"
  | "resolved";

export type ReconciliationPaymentStatus =
  | "pending"
  | "success"
  | "failed"
  | "refunded"
  | "confirmed_unapplied";

export type PaymentReconciliationReason =
  | "duplicate_confirmed"
  | "order_not_payable"
  | "late_confirmation_unapplied"
  | "late_confirmation_applied"
  | "amount_mismatch"
  | "amount_missing"
  | "amount_invalid";

/** Money on a case. `confirmedHeld` and `refundedTotal` are DISJOINT buckets. */
export interface ReconciliationMoney {
  orderTotal: string;
  confirmedHeld: string;
  /** The `confirmed_unapplied` subset of `confirmedHeld` — money that settled nothing. */
  confirmedUnapplied: string;
  refundedTotal: string;
  hasAmountDiscrepancy: boolean;
}

export interface ReconciliationCaseSummary {
  /** Numeric `orders.id`. This IS the case id. */
  orderId: number;
  orderNumber: string | null;
  channel: string;
  orderStatus: string;
  fulfillmentState: string;
  branchId: number | null;
  /** Every reason this order is in the queue. Never empty. */
  caseTypes: ReconciliationCaseType[];
  reconciliationState: OrderReconciliationState | null;
  reconciliationResolvedAt: string | null;
  /**
   * Whether ANY receipt authorizes consuming this order's stock — the exact
   * predicate the fulfilment claim evaluates. `false` on a paid, unfulfilled
   * order is precisely the population this queue exists for.
   */
  fulfilmentAuthorized: boolean;
  money: ReconciliationMoney;
  paidAt: string | null;
  createdAt: string;
}

export interface ReconciliationReceipt {
  /** Numeric `payment.id` — what `confirm-refund` names. */
  id: number;
  status: ReconciliationPaymentStatus;
  /** What WE asked for. Integer Rial as a string. */
  amount: string;
  /** What the GATEWAY reported. `null` when it reported nothing usable. */
  gatewayAmount: string | null;
  /** The gateway's figure verbatim when it could not be stored as an integer. */
  gatewayAmountRaw: string | null;
  /** The gateway's reference. The session id (`track_id`) is never exposed. */
  refNumber: string | null;
  requiresReconciliation: boolean;
  reconciliationReason: PaymentReconciliationReason | null;
  reconciledAt: string | null;
  paidAt: string | null;
  createdAt: string;
}

/** The fulfilment claim's own diagnosis, clause by clause, per receipt. */
export interface ReconciliationAuthorizationClause {
  paymentId: number;
  isSuccess: boolean;
  hasGatewayAmount: boolean;
  gatewayMatchesAmount: boolean;
  amountMatchesOrder: boolean;
  reasonResolved: boolean;
  qualifies: boolean;
}

export interface ReconciliationAuditEntry {
  id: number;
  action: string;
  paymentId: number | null;
  /** The operator as NAMED at the time; survives renaming or deletion. */
  actorDisplaySnapshot: string;
  actorUserId: number | null;
  reason: string;
  fromPaymentStatus: string | null;
  toPaymentStatus: string | null;
  fromOrderStatus: string | null;
  toOrderStatus: string | null;
  fromReconciliationState: string | null;
  toReconciliationState: string | null;
  externalReference: string | null;
  /** Integer Rial as a string. */
  amount: string | null;
  createdAt: string;
}

export interface ReconciliationStock {
  /** Whether the goods were EVER consumed. Zero → nothing can be restored. */
  fulfilmentMovements: number;
  /** Net `SUM(delta)`. Negative means stock left the building. */
  netMovementDelta: number;
  /** Units held by ACTIVE allocations. A hold, not physical stock. */
  activeAllocationUnits: number;
  orderedUnits: number;
}

/** The only contact detail projected. No address, no token, no password state. */
export interface ReconciliationCustomer {
  userId: number | null;
  customerId: number | null;
  mobile: string | null;
  displayName: string | null;
}

export interface ReconciliationCaseDetail extends ReconciliationCaseSummary {
  customer: ReconciliationCustomer;
  receipts: ReconciliationReceipt[];
  authorizationClauses: ReconciliationAuthorizationClause[];
  stock: ReconciliationStock;
  /** The append-only audit trail, oldest first. */
  actions: ReconciliationAuditEntry[];
  /**
   * Render exactly these buttons. The server validates every source state
   * independently — this list is a convenience, never the authorization.
   */
  allowedActions: ReconciliationActionName[];
}

export interface ReconciliationActionResult {
  orderId: number;
  action: string;
  /** The `payment_actions` row just written. */
  actionId: number;
  orderStatus: string;
  fulfillmentState: string;
  reconciliationState: OrderReconciliationState | null;
  /** RETRY ONLY. Whether THIS call consumed the stock. */
  fulfilled?: boolean;
  /**
   * RETRY ONLY. Non-null when fulfilment was REFUSED because no receipt
   * authorizes consuming stock. Never render such an order as progressing.
   */
  blocked?: string | null;
  /** REFUND CONFIRMATION ONLY. False when the order never consumed stock. */
  stockRestored?: boolean;
  /** Operator-facing. Never shown to a customer. */
  message: string;
}

/**
 * THE SIMPLE VIEW of the queue: where a case is in the workflow.
 *
 * `ReconciliationCaseType` says WHAT IS WRONG and a case can carry several at
 * once. This says WHERE IT IS, and a case is in exactly one — the three
 * partition the queue, so a manager who empties all three has handled
 * everything and nothing can hide between two tabs.
 */
export type ReconciliationStage = "needs_action" | "tracking" | "closed";

export interface ReconciliationQuery extends PageQuery {
  /**
   * Preferred over the technical filters for an operator-facing view. ANDed
   * with `resolved` rather than overriding it, so a contradictory pair returns
   * nothing instead of silently ignoring one of them.
   */
  stage?: ReconciliationStage;
  caseType?: ReconciliationCaseType;
  paymentStatus?: ReconciliationPaymentStatus;
  orderStatus?: string;
  fulfillmentState?: string;
  /** Online orders have no branch, so this filter excludes them by construction. */
  branchId?: number;
  /** ISO-8601 instant. */
  createdFrom?: string;
  createdTo?: string;
  /**
   * `true` = only closed cases, `false` = only open ones. OMIT to see BOTH,
   * which is the server's default and the safe one: an unresolved discrepancy
   * must not be able to hide behind a default filter.
   */
  resolved?: boolean;
}

/**
 * Options for a reconciliation MUTATION.
 *
 * `attempt` is REQUIRED here, unlike checkout: every one of these routes takes
 * a mandatory `Idempotency-Key`, and one key must cover one DECISION across
 * every retry of it, so that a double-click cannot record the decision — or
 * move the money — twice.
 */
export interface ReconciliationMutationOptions extends CallOptions {
  attempt: IdempotentAttempt | string;
}

/** Counts behind the queue's summary cards. See `summary()`. */
export interface ReconciliationQueueSummary {
  timezone: string;
  /** These three partition the queue. */
  needsAction: number;
  tracking: number;
  closed: number;
  /** Overlapping views of the unresolved cases. DO NOT SUM. */
  paidOrderIncomplete: number;
  stockProblem: number;
  refundRequired: number;
  unappliedReceipt: number;
  amountDiscrepancy: number;
  /** Closed within the current local calendar day in `timezone`. */
  resolvedToday: number;
}

/** Mandatory on every mutation; >= 4 characters; written to the audit trail. */
export interface ReconciliationReasonBody {
  reason: string;
}

export interface MarkRefundRequiredBody extends ReconciliationReasonBody {
  /** Integer Rial. Recorded on the audit row; NOT a promise and NOT a refund. */
  expectedAmount?: number;
}

export interface ConfirmExternalRefundBody extends ReconciliationReasonBody {
  /** Numeric `payment.id` of the RECEIPT that was refunded. Nothing is inferred. */
  paymentId: number;
  /** Integer Rial actually refunded. Validated against the receipt's figures. */
  amount: number;
  /** The PROVIDER's reference. Charset `[A-Za-z0-9._:/-]`, 1–128 chars. */
  externalReference: string;
}

export interface ResolveReconciliationBody extends ReconciliationReasonBody {
  resolutionType: ReconciliationResolutionType;
}

export function createReconciliationResource(client: ApiClient) {
  const mutate = (
    orderId: number,
    path: string,
    body: ReconciliationReasonBody,
    options: ReconciliationMutationOptions,
  ): Promise<{ message: string; data: ReconciliationActionResult }> => {
    const { attempt, ...rest } = options;
    return client.post<{ message: string; data: ReconciliationActionResult }>(
      `/payment/admin/reconciliation/${orderId}/${path}`,
      body,
      { ...rest, envelope: "spread", idempotencyKey: attempt },
    );
  };

  return {
    /**
     * `GET /payment/admin/reconciliation`. Newest money first.
     *
     * The default is EVERYTHING, resolved cases included. Narrow explicitly
     * with `resolved: false`; do not assume the server hides closed cases.
     */
    async listQueue(
      query: ReconciliationQuery = {},
      options: CallOptions = {},
    ): Promise<Page<ReconciliationCaseSummary>> {
      const { page, limit } = clampPageQuery(query);
      const body = await client.get<unknown>("/payment/admin/reconciliation", {
        ...options,
        envelope: "data",
        query: toQuery({ ...query, page, limit }),
      });
      return normalizePage<ReconciliationCaseSummary>(body);
    },

    /**
     * `GET /payment/admin/reconciliation/summary`.
     *
     * The nine counts behind the queue's summary cards, in ONE request.
     * `needsAction + tracking + closed` is the whole queue; every other figure
     * is an OVERLAPPING view of the unresolved part, so they must never be
     * added together.
     */
    summary(options: CallOptions = {}): Promise<ReconciliationQueueSummary> {
      return client.get<ReconciliationQueueSummary>(
        "/payment/admin/reconciliation/summary",
        { ...options, envelope: "data" },
      );
    },

    /**
     * `GET /payment/admin/reconciliation/:orderId`. The case id IS the order id.
     * 404 `RECONCILIATION_CASE_NOT_FOUND` when no order has that id OR the
     * order has nothing outstanding.
     */
    getCase(orderId: number, options: CallOptions = {}): Promise<ReconciliationCaseDetail> {
      return client.get<ReconciliationCaseDetail>(
        `/payment/admin/reconciliation/${orderId}`,
        { ...options, envelope: "data" },
      );
    },

    /**
     * Re-drives fulfilment. The authorization predicate is NOT relaxed: read
     * `blocked` before telling anyone the order is on its way.
     * 409 `ORDER_NOT_RETRYABLE` / `RECONCILIATION_ALREADY_RESOLVED`.
     */
    retryFulfilment(
      orderId: number,
      body: ReconciliationReasonBody,
      options: ReconciliationMutationOptions,
    ) {
      return mutate(orderId, "retry-fulfilment", body, options);
    },

    /**
     * RECORDS AN OBLIGATION. IT DOES NOT REFUND ANYTHING — no payment row is
     * touched and no gateway is called. The case deliberately STAYS open.
     */
    markRefundRequired(
      orderId: number,
      body: MarkRefundRequiredBody,
      options: ReconciliationMutationOptions,
    ) {
      return mutate(orderId, "mark-refund-required", body, options);
    },

    /**
     * REPORTS a refund the operator already completed with the provider. The
     * receipt's own figures are never rewritten. 409 `REFUND_ALREADY_CONFIRMED`
     * / `PAYMENT_NOT_REFUNDABLE`, 404 `PAYMENT_NOT_ON_ORDER`,
     * 400 `REFUND_AMOUNT_INVALID`.
     */
    confirmExternalRefund(
      orderId: number,
      body: ConfirmExternalRefundBody,
      options: ReconciliationMutationOptions,
    ) {
      return mutate(orderId, "confirm-refund", body, options);
    },

    /**
     * Keep a paid order open and wait for stock. No stock is consumed and none
     * is promised. 409 `ORDER_NOT_BACKORDERABLE`.
     */
    markBackorder(
      orderId: number,
      body: ReconciliationReasonBody,
      options: ReconciliationMutationOptions,
    ) {
      return mutate(orderId, "mark-backorder", body, options);
    },

    /**
     * Close a case with no money moving. A case marked `refund_required` cannot
     * be closed this way — 409 `REFUND_PENDING_CONFIRMATION`.
     */
    resolve(
      orderId: number,
      body: ResolveReconciliationBody,
      options: ReconciliationMutationOptions,
    ) {
      return mutate(orderId, "resolve", body, options);
    },
  };
}

// ---------------------------------------------------------------------------

export function createHealthResource(client: ApiClient) {
  return {
    /**
     * Answers 200 OR 503, but BOTH bodies carry `success: true`. Read `status`
     * and `database`; never infer readiness from the envelope.
     */
    async check(options: CallOptions = {}): Promise<HealthReport> {
      const result = await client.requestDetailed<HealthReport>("/health", {
        ...options,
        method: "GET",
        envelope: "spread",
        auth: false,
        acceptStatuses: [503],
      });
      return result.data;
    },
  };
}
