import type { Route } from "next";

/**
 * URL builders.
 *
 * `typedRoutes` is on, so `<Link href="/cart">` and `router.push("/products")`
 * are checked against the real route tree — which is exactly what we want, and
 * which is also why this file exists.
 *
 * The generated `Route` type is a union of string LITERALS plus template
 * patterns (`/products?${string}`, `/products/${slug}`). A URL assembled at
 * runtime from a filter object is, to the type system, just `string`: there is
 * no way to prove to it that `qs` came from `URLSearchParams` over a whitelist
 * of keys. So the assertion is made ONCE, here, next to the code that builds
 * the string — instead of being sprinkled through twenty call sites, or worked
 * around by writing out every combination of filters by hand.
 *
 * Static, statically-known links (`href="/cart"`) do NOT go through here. They
 * are written literally at the call site so the compiler really does check
 * them, and a typo in a route name still fails the build.
 */

type QueryValue = string | number | boolean | null | undefined;

/** Drop empty values so `/products?search=&page=` never appears in a URL. */
export function buildQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    search.set(key, String(value));
  }
  return search.toString();
}

/** `path` must be a real route; `query` is appended when non-empty. */
export function href(path: string, query: Record<string, QueryValue> = {}): Route {
  const qs = buildQuery(query);
  return (qs === "" ? path : `${path}?${qs}`) as Route;
}

// --- storefront ------------------------------------------------------------

export const productsHref = (query: Record<string, QueryValue> = {}) => href("/products", query);
export const productHref = (id: number) => href(`/products/${id}`);
export const categoryHref = (categoryId: number) => href("/products", { categoryId });

// --- account ---------------------------------------------------------------

export const orderHref = (id: number) => href(`/account/orders/${id}`);
export const ordersHref = (query: Record<string, QueryValue> = {}) =>
  href("/account/orders", query);

/** Sends the customer to sign-in and back to where they were. */
export const signInHref = (next?: string) => href("/auth/sign-in", next ? { next } : {});

/** The gateway return page. `trackId` is echoed back by the gateway. */
export const paymentReturnHref = (query: Record<string, QueryValue> = {}) =>
  href("/checkout/payment/return", query);

// --- admin -----------------------------------------------------------------

/**
 * The ADMIN sign-in page — deliberately distinct from `signInHref`.
 *
 * Staff authenticate with a username and password against `POST /auth/admin/login`
 * (console) or `POST /auth/pos/login` (till);
 * customers authenticate with an OTP. Sending a locked-out administrator to the
 * customer's OTP screen — which has no password field at all — is how the admin
 * area became unreachable through the UI.
 */
export const adminLoginHref = (next?: string) =>
  href("/admin/login", next ? { next } : {});

export const adminProductsHref = (query: Record<string, QueryValue> = {}) =>
  href("/admin/products", query);
export const adminProductHref = (id: number) => href(`/admin/products/${id}`);
export const adminReconciliationHref = (query: Record<string, QueryValue> = {}) =>
  href("/admin/reconciliation", query);
export const adminCaseHref = (orderId: number) => href(`/admin/reconciliation/${orderId}`);
export const adminReportsHref = (query: Record<string, QueryValue> = {}) =>
  href("/admin/reports", query);
/** The super_admin-only GROSS profit report (docs/PURCHASE-COST-ACCOUNTING.md §9). */
export const adminProfitReportHref = (query: Record<string, QueryValue> = {}) =>
  href("/admin/reports/profit", query);
export const adminProfitOrderHref = (orderId: number) =>
  href(`/admin/reports/profit/orders/${orderId}`);
/** super_admin-only monthly cost-recovery pricing plans (docs/MONTHLY-PRICING.md). */
export const adminPricingPlansHref = (query: Record<string, QueryValue> = {}) => href("/admin/pricing", query);
export const adminPricingPlanHref = (planId: number, query: Record<string, QueryValue> = {}) =>
  href(`/admin/pricing/${planId}`, query);

/**
 * A same-origin path to return to after sign-in.
 *
 * Only a path is ever accepted: an absolute URL, a protocol-relative `//host`
 * or anything else that could leave this origin is discarded in favour of the
 * home page. An open redirect on a sign-in flow is a phishing primitive, and
 * the fact that the value came from our own `<Link>` is not a guarantee — it
 * arrives through the query string, where anyone can put anything.
 */
export function safeNextPath(raw: string | null | undefined): Route {
  if (typeof raw !== "string" || raw.length === 0) return "/" as Route;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/" as Route;
  return raw as Route;
}

// --- admin: people and branches --------------------------------------------

/**
 * WHY THESE TAKE IDS AND NOT USERNAMES.
 *
 * A username is editable — `PATCH /admin/users/:id` changes it — so a URL built
 * from one goes stale the moment somebody corrects a typo in a cashier's name.
 * The numeric id is the only stable handle, and it is what the route segment
 * parses.
 */
export const adminUsersHref = (query: Record<string, QueryValue> = {}) =>
  href("/admin/users", query);
export const adminUserHref = (id: number) => href(`/admin/users/${id}`);
export const adminCashiersHref = (query: Record<string, QueryValue> = {}) =>
  href("/admin/cashiers", query);
export const adminBranchesHref = (query: Record<string, QueryValue> = {}) =>
  href("/admin/branches", query);
export const adminBranchHref = (id: number) => href(`/admin/branches/${id}`);

// --- admin: orders and the audit trail -------------------------------------

/**
 * The order list, with its filters in the URL.
 *
 * Every filter this builder carries is server-side. That is the point of
 * putting them in the URL rather than in component state: a filtered set of
 * orders is a question an operator asks, and it has to be shareable, bookmarkable
 * and restorable by a refresh — "orders awaiting stock in Sanandaj" is a link,
 * not a sequence of clicks somebody has to be talked through on the telephone.
 */
export const adminOrdersHref = (query: Record<string, QueryValue> = {}) =>
  href("/admin/orders", query);

/**
 * One order. Takes the numeric id, never the order number.
 *
 * `orderNumber` is the human-facing handle and is what a customer quotes, but
 * the route segment is `orders/[id]` and parses an integer — and the id is the
 * only value the detail, actions, void and return endpoints accept.
 */
export const adminOrderHref = (id: number) => href(`/admin/orders/${id}`);

export const adminAuditHref = (query: Record<string, QueryValue> = {}) =>
  href("/admin/audit", query);

// --- admin: catalogue vocabulary and the stockroom -------------------------

export const adminCategoriesHref = (query: Record<string, QueryValue> = {}) =>
  href("/admin/categories", query);

export const adminAttributesHref = (query: Record<string, QueryValue> = {}) =>
  href("/admin/attributes", query);

export const adminInventoryHref = (query: Record<string, QueryValue> = {}) =>
  href("/admin/inventory", query);

/**
 * The append-only stock ledger.
 *
 * `variantId` in the query string, rather than a `movements/[variantId]` route,
 * because the ledger is ONE list with several orthogonal filters — variant,
 * product, reason, actor, order, date range — and none of them is more the
 * identity of the page than the others. A row's "see this variant's history"
 * link is therefore the same screen with one filter pre-filled, which is also
 * what makes it shareable.
 */
export const adminMovementsHref = (query: Record<string, QueryValue> = {}) =>
  href("/admin/inventory/movements", query);

/**
 * The product list, filtered to ONE CATEGORY.
 *
 * Used by the category screen's delete refusal: a category cannot be removed
 * while products are still in it, and the only useful thing to hand the manager
 * at that moment is the list of the products that are blocking it.
 */
export const adminProductsInCategoryHref = (categoryId: number) =>
  href("/admin/products", { categoryId });
