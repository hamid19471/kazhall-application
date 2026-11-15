import type {
  CreateProductBody,
  CreateVariantBody,
  KazhalApi,
  ProductVisibility,
  UpsertVariantBody,
} from "@kazhal/api-client";

/**
 * ===========================================================================
 * THE ADMIN API SURFACE
 * ===========================================================================
 *
 * WHY IT IS HERE AND NOT IN `@kazhal/api-client`. That package is shared with
 * the till (`apps/store`), which has no use for a single one of these routes
 * and should not carry their types. `ApiClient` already exposes a typed
 * transport (`client.get<T>` / `post` / `patch` / `put` / `delete`), so the
 * only thing a resource layer adds is naming the route, the envelope mode and
 * the payload type in one place — which is exactly what this file does, for
 * the admin console alone.
 *
 * ENVELOPE MODES, because getting one wrong is a silent `undefined`:
 *  - `"data"`   the handler returned `{ data: X }`      → X
 *  - `"spread"` the handler's keys sit beside `success` → the whole body
 * Every call below states which, matching the controller it talks to.
 *
 * MONEY IS A STRING. Every Rial figure from these endpoints is a `bigint`
 * cast with `::text`. Never `Number()` it; format with `formatRialString` from
 * `lib/money.ts`.
 */

type CallOptions = { signal?: AbortSignal };

/** The shape every paginated admin list returns. */
export interface AdminPage<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Narrows a filter object to what a query string can carry, dropping empties.
 *
 * The parameter is `object`, not `Record<string, unknown>`: an INTERFACE has no
 * index signature, so `AdminUserFilters` would not be assignable to the record
 * form even though every one of its properties is fine here. Widening the
 * parameter is the fix; casting at each call site would hide the same mismatch
 * a dozen times over. (`@kazhal/api-client` solved it the same way.)
 */
function query(params: object): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface DashboardMoney {
  grossSales: string;
  refundedTotal: string;
  voidedTotal: string;
  netSales: string;
}

/**
 * TODAY'S FIGURES. Every field names the timestamp that places it in the day,
 * because four different event dates are in play and mixing two of them under
 * one label — which a single `orderCount` used to do — produces a number a
 * store manager cannot act on.
 *
 *   `ordersCreated*`  → `orders.created_at` (the row's birth instant)
 *   `*ByRevenueDate`,
 *   `salesCount`,
 *   `unitsSold`       → `COALESCE(paidAt, soldAt)` (when the money was taken)
 *   `refunded*`       → `refundedAt`   `voided*` → `voidedAt`
 *
 * An order created today and paid tomorrow is in `ordersCreated` TODAY and in
 * `salesCount` TOMORROW. Never add across axes.
 *
 * COUNTS ONLY — no money. Today's gross, refunds, voids and net moved to
 * {@link DashboardFinancial}, which the API gates on the built-in `super_admin`
 * role. `dashboard.read` is delegatable; the money is not.
 */
export interface DashboardTotals {
  /** Rows CREATED today, any status. Not revenue. */
  ordersCreated: number;
  /** Of those, the ones whose money has since been taken — possibly on a later day. */
  ordersCreatedPaid: number;
  /** Of those, the ones still awaiting payment. Never revenue. */
  ordersCreatedPending: number;
  /** Of those, the ones that failed or were canceled with no money taken. */
  ordersCreatedFailedOrCanceled: number;

  /** What `/reports/sales/summary` calls `totals.orderCount`. Revenue-date axis. */
  ordersByRevenueDate: number;
  /** Orders whose MONEY WAS TAKEN today. */
  salesCount: number;
  nonSaleCount: number;
  pendingByRevenueDate: number;
  canceledOrFailedByRevenueDate: number;
  unitsSold: number;

  /** Orders REFUNDED today, however long ago they were sold. */
  refundedCount: number;
  unitsRefunded: number;
  /** Paid sales VOIDED today, however long ago they were rung up. */
  voidedCount: number;
  unitsVoided: number;
}

/** The `semantics` block the endpoint returns verbatim. Strings, all of them. */
export type DashboardSemantics = Record<string, string>;

export interface DashboardSummary {
  timezone: string;
  period: { date: string; startUtc: string; endUtc: string; label: "today" };
  totals: DashboardTotals;
  pipeline: {
    /** ONLINE orders PENDING right now, of any age. Never revenue. */
    pendingWebOrders: number;
    awaitingFulfilment: number;
    fulfilmentFailed: number;
    paidAwaitingProcessing: number;
    openReconciliationCases: number;
    refundRequiredCases: number;
  };
  inventory: {
    lowStockVariants: number;
    outOfStockVariants: number;
    trackedVariants: number;
    lowStockThreshold: number;
    scope: "global";
  };
  /**
   * The last few orders as a WORK QUEUE. No `totalPrice`: per-order money on a
   * screen gated only by `dashboard.read` is a cashier-performance strip in
   * miniature, and whether the viewer may see order values is `orders.read`.
   */
  recentOrders: Array<{
    id: number;
    orderNumber: string | null;
    channel: string;
    status: string;
    fulfillmentState: string;
    branchName: string | null;
    cashierDisplay: string | null;
    revenueAt: string | null;
    createdAt: string;
  }>;
  /** What each figure means, returned verbatim by the API. */
  semantics: DashboardSemantics;
}

/**
 * TODAY'S MONEY — `GET /admin/dashboard/financial`, main administrator only.
 *
 * A SEPARATE CONTRACT, not a nullable branch of the summary. The API gates it
 * on the built-in `super_admin` role plus the `admin` audience, exactly as it
 * gates `/reports/*`, because it is the same kind of data and the owner's rule
 * about it is the same: not delegable, and not expressible as a capability
 * anybody could be granted.
 *
 * A delegated administrator's console never requests this, and would be
 * refused 403 if it did.
 */
export interface DashboardFinancial {
  timezone: string;
  period: { date: string; startUtc: string; endUtc: string; label: "today" };
  money: DashboardMoney;
  byChannel: Array<{
    channel: string;
    salesCount: number;
    unitsSold: number;
    grossSales: string;
    netSales: string;
  }>;
  byBranch: Array<{
    branchId: number | null;
    branchName: string | null;
    salesCount: number;
    grossSales: string;
    netSales: string;
  }>;
  topVariants: Array<{
    variantId: number | null;
    sku: string | null;
    productId: number | null;
    productTitle: string;
    unitsSold: number;
    grossSales: string;
  }>;
  semantics: DashboardSemantics;
  /**
   * GROSS profit for the same day (docs/PURCHASE-COST-ACCOUNTING.md §9) —
   * present only once the API reports it, so it is optional and the card
   * renders nothing without it. Never net profit: no expense is modelled.
   */
  profit?: DashboardProfit;
}

export interface DashboardProfit {
  /** `null` when no sale in the period has a known cost. */
  grossProfit: string | null;
  grossMarginPercent: string | null;
  coveragePercent: string | null;
  knownNetRevenue: string;
  unknownNetRevenue: string;
}

export function fetchDashboard(
  api: KazhalApi,
  params: { lowStockThreshold?: number } = {},
  options: CallOptions = {},
): Promise<DashboardSummary> {
  return api.client.get<DashboardSummary>("/admin/dashboard/summary", {
    ...options,
    envelope: "data",
    query: query(params),
  });
}

/**
 * Today's money. Requires the built-in `super_admin` role.
 *
 * Called only from the dashboard, and only when the session holds that role —
 * see `isSuperAdmin`. Firing it for a delegated administrator would be a 403
 * they never needed to see.
 */
export function fetchDashboardFinancial(
  api: KazhalApi,
  options: CallOptions = {},
): Promise<DashboardFinancial> {
  return api.client.get<DashboardFinancial>("/admin/dashboard/financial", {
    ...options,
    envelope: "data",
  });
}

/**
 * The badge counts the sidebar shows. Derived from the ONE dashboard call.
 *
 * That call is now the OPERATIONAL summary, which carries no money at all — so
 * the admin shell no longer fetches the business's takings on every page load
 * in order to render three integers.
 */
export interface AdminNavCounts {
  reconciliation: number;
  fulfilment: number;
  lowStock: number;
}

export async function fetchNavCounts(
  api: KazhalApi,
  options: CallOptions = {},
): Promise<AdminNavCounts> {
  const summary = await fetchDashboard(api, {}, options);
  return {
    reconciliation: summary.pipeline.openReconciliationCases,
    fulfilment: summary.pipeline.awaitingFulfilment + summary.pipeline.fulfilmentFailed,
    lowStock: summary.inventory.lowStockVariants + summary.inventory.outOfStockVariants,
  };
}

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

export interface PermissionSpec {
  code: string;
  labelFa: string;
  descriptionFa: string;
  risk: "normal" | "sensitive" | "critical";
}

export interface PermissionGroup {
  key: string;
  titleFa: string;
  permissions: PermissionSpec[];
}

export interface RoleSummary {
  id: number;
  name: string;
  titleFa: string;
  description: string | null;
  isSystem: boolean;
  isActive: boolean;
  userCount: number;
  permissionCount: number;
}

export interface RoleDetail extends RoleSummary {
  permissions: string[];
  permissionsReadOnly: boolean;
}

export interface EffectiveAccess {
  userId: number;
  identifier: string;
  isActive: boolean;
  roles: Array<{
    id: number;
    name: string;
    titleFa: string;
    isSystem: boolean;
    isActive: boolean;
  }>;
  permissions: string[];
  audiences: string[];
}

export function fetchPermissionCatalogue(
  api: KazhalApi,
  options: CallOptions = {},
): Promise<{ groups: PermissionGroup[] }> {
  return api.client.get<{ groups: PermissionGroup[] }>("/admin/access/permissions", {
    ...options,
    envelope: "spread",
  });
}

export function fetchRoles(api: KazhalApi, options: CallOptions = {}): Promise<RoleSummary[]> {
  return api.client.get<RoleSummary[]>("/admin/access/roles", {
    ...options,
    envelope: "data",
  });
}

/**
 * The reduced role shape `GET /admin/users/assignable-roles` returns.
 *
 * A STRICT SUBSET of {@link RoleSummary} — no `userCount`, and above all no
 * `permissions` array. It is the shape a user form needs and nothing more, so
 * that a delegated user manager who holds no `rbac.read` cannot read the
 * access-control catalogue through the back door of the form that lets them
 * hire a cashier.
 */
export interface AssignableRole {
  id: number;
  name: string;
  titleFa: string | null;
  description: string | null;
  isSystem: boolean;
  /** Always true — inactive roles are never listed. */
  isActive: boolean;
  /** HOW MANY capabilities the role grants, never WHICH ones. */
  permissionCount: number;
}

/**
 * The roles the CURRENT principal may actually assign.
 *
 * WHY THIS AND NOT `fetchRoles`. `GET /admin/access/roles` requires
 * `rbac.read`, so the create-user form used to demand a capability that has
 * nothing to do with creating a user — and refused to submit without it. This
 * route requires `users.create` OR `users.update` instead, and returns exactly
 * the roles that `POST /admin/users` would accept from this caller, so the
 * form can no longer offer something the server will reject.
 *
 * It is not an authorisation: the mutation re-checks. It is the form asking
 * the question early instead of discovering the answer as a 403.
 */
export function fetchAssignableRoles(
  api: KazhalApi,
  options: CallOptions = {},
): Promise<AssignableRole[]> {
  return api.client.get<AssignableRole[]>("/admin/users/assignable-roles", {
    ...options,
    envelope: "data",
  });
}

export function fetchRole(
  api: KazhalApi,
  id: number,
  options: CallOptions = {},
): Promise<RoleDetail> {
  return api.client.get<RoleDetail>(`/admin/access/roles/${id}`, {
    ...options,
    envelope: "data",
  });
}

export function createRole(
  api: KazhalApi,
  body: { name: string; titleFa: string; description?: string; permissions?: string[] },
): Promise<{ message: string; data: RoleDetail }> {
  return api.client.post<{ message: string; data: RoleDetail }>(
    "/admin/access/roles",
    body,
    { envelope: "spread" },
  );
}

export function updateRole(
  api: KazhalApi,
  id: number,
  body: { titleFa?: string; description?: string },
): Promise<{ message: string; data: RoleDetail }> {
  return api.client.patch<{ message: string; data: RoleDetail }>(
    `/admin/access/roles/${id}`,
    body,
    { envelope: "spread" },
  );
}

export function setRolePermissions(
  api: KazhalApi,
  id: number,
  permissions: string[],
): Promise<{ message: string; data: RoleDetail }> {
  return api.client.put<{ message: string; data: RoleDetail }>(
    `/admin/access/roles/${id}/permissions`,
    { permissions },
    { envelope: "spread" },
  );
}

export function setRoleActive(
  api: KazhalApi,
  id: number,
  isActive: boolean,
): Promise<{ message: string; data: RoleDetail }> {
  return api.client.patch<{ message: string; data: RoleDetail }>(
    `/admin/access/roles/${id}/active`,
    { isActive },
    { envelope: "spread" },
  );
}

export function setUserRoles(
  api: KazhalApi,
  userId: number,
  roleIds: number[],
): Promise<{ message: string; data: EffectiveAccess }> {
  return api.client.put<{ message: string; data: EffectiveAccess }>(
    `/admin/access/users/${userId}/roles`,
    { roleIds },
    { envelope: "spread" },
  );
}

/**
 * `DELETE /roles/:id` — the ROLE CATALOGUE delete, not a user's assignment.
 *
 * It lives on the older `/roles` controller (now capability-gated like
 * everything else) and keeps every safety guarantee it shipped with: built-in
 * roles are refused with 409 `ROLE_BUILTIN_PROTECTED`, and a role anybody
 * still holds is refused with 409 `ROLE_IN_USE` carrying the count — both
 * enforced inside one transaction holding a row lock, because
 * `user_roles."rolesId"` is ON DELETE CASCADE and an unguarded delete would
 * silently strip the role from every holder.
 */
export function deleteRole(api: KazhalApi, id: number): Promise<{ message: string }> {
  return api.client.delete<{ message: string }>(`/roles/${id}`, undefined, {
    envelope: "spread",
  });
}

export function fetchEffectiveAccess(
  api: KazhalApi,
  userId: number,
  options: CallOptions = {},
): Promise<EffectiveAccess> {
  return api.client.get<EffectiveAccess>(`/admin/access/users/${userId}/effective`, {
    ...options,
    envelope: "data",
  });
}

// ---------------------------------------------------------------------------
// Users and cashiers
// ---------------------------------------------------------------------------

export interface AdminRoleRef {
  id: number;
  name: string;
  titleFa: string;
  isSystem: boolean;
  isActive: boolean;
}

export interface AdminUserRow {
  id: number;
  username: string | null;
  mobile: string | null;
  identifier: string;
  isStaff: boolean;
  isActive: boolean;
  mustChangePassword: boolean;
  branchId: number | null;
  branchName: string | null;
  branchIsActive: boolean | null;
  roles: AdminRoleRef[];
  canAccess: { storefront: boolean; admin: boolean; pos: boolean };
  activeSessionCount: number;
  createdAt: string;
}

export interface AdminUserDetail extends AdminUserRow {
  permissions: string[];
  sessionsByAudience: Record<string, number>;
  salesCount: number;
  passwordChangedAt: string | null;
  deactivatedAt: string | null;
}

export interface AdminCashierRow extends AdminUserRow {
  canSellNow: boolean;
  blockedReason:
    | "account_deactivated"
    | "no_branch"
    | "branch_inactive"
    | "password_change_required"
    | null;
}

export interface AdminUserFilters {
  page?: number;
  limit?: number;
  search?: string;
  roleId?: number;
  branchId?: number;
  status?: "active" | "deactivated";
  kind?: "staff" | "customer";
}

export function fetchUsers(
  api: KazhalApi,
  filters: AdminUserFilters = {},
  options: CallOptions = {},
): Promise<AdminPage<AdminUserRow>> {
  return api.client.get<AdminPage<AdminUserRow>>("/admin/users", {
    ...options,
    envelope: "spread",
    query: query(filters),
  });
}

export function fetchUser(
  api: KazhalApi,
  id: number,
  options: CallOptions = {},
): Promise<AdminUserDetail> {
  return api.client.get<AdminUserDetail>(`/admin/users/${id}`, {
    ...options,
    envelope: "data",
  });
}

export function fetchCashiers(
  api: KazhalApi,
  filters: AdminUserFilters = {},
  options: CallOptions = {},
): Promise<AdminPage<AdminCashierRow> & { filteredOut: number }> {
  return api.client.get<AdminPage<AdminCashierRow> & { filteredOut: number }>(
    "/admin/cashiers",
    { ...options, envelope: "spread", query: query(filters) },
  );
}

export function createUser(
  api: KazhalApi,
  body: {
    username: string;
    password: string;
    mobile?: string | null;
    branchId?: number | null;
    roleIds: number[];
    mustChangePassword?: boolean;
  },
): Promise<{ message: string; data: AdminUserDetail }> {
  return api.client.post<{ message: string; data: AdminUserDetail }>(
    "/admin/users",
    body,
    { envelope: "spread" },
  );
}

export function updateUser(
  api: KazhalApi,
  id: number,
  body: { username?: string; mobile?: string | null; branchId?: number | null },
): Promise<{ message: string; data: AdminUserDetail }> {
  return api.client.patch<{ message: string; data: AdminUserDetail }>(
    `/admin/users/${id}`,
    body,
    { envelope: "spread" },
  );
}

export function setUserActive(
  api: KazhalApi,
  id: number,
  isActive: boolean,
): Promise<{ message: string; data: AdminUserDetail }> {
  return api.client.patch<{ message: string; data: AdminUserDetail }>(
    `/admin/users/${id}/active`,
    { isActive },
    { envelope: "spread" },
  );
}

export function revokeUserSessions(
  api: KazhalApi,
  id: number,
): Promise<{ message: string; revoked: number }> {
  return api.client.post<{ message: string; revoked: number }>(
    `/admin/users/${id}/revoke-sessions`,
    undefined,
    { envelope: "spread" },
  );
}

export function resetUserPassword(
  api: KazhalApi,
  id: number,
  temporaryPassword: string,
): Promise<{ message: string; revoked: number }> {
  return api.client.post<{ message: string; revoked: number }>(
    `/admin/users/${id}/password`,
    { temporaryPassword },
    { envelope: "spread" },
  );
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export interface AdminBranchRow {
  id: number;
  name: string;
  address: string | null;
  phone: string | null;
  isActive: boolean;
  activeStaffCount: number;
  totalStaffCount: number;
  orderCount: number;
  openOrderCount: number;
  createdAt: string;
}

export interface AdminBranchDetail extends AdminBranchRow {
  staff: Array<{
    id: number;
    identifier: string;
    mobile: string | null;
    isActive: boolean;
    roles: string[];
  }>;
}

export function fetchBranches(
  api: KazhalApi,
  filters: { page?: number; limit?: number; search?: string; isActive?: boolean } = {},
  options: CallOptions = {},
): Promise<AdminPage<AdminBranchRow>> {
  return api.client.get<AdminPage<AdminBranchRow>>("/branch", {
    ...options,
    envelope: "spread",
    query: query(filters),
  });
}

export function fetchBranch(
  api: KazhalApi,
  id: number,
  options: CallOptions = {},
): Promise<AdminBranchDetail> {
  return api.client.get<AdminBranchDetail>(`/branch/${id}`, {
    ...options,
    envelope: "data",
  });
}

export function createBranch(
  api: KazhalApi,
  body: { name: string; address?: string; phone?: string },
): Promise<{ message: string; data: AdminBranchRow }> {
  return api.client.post<{ message: string; data: AdminBranchRow }>("/branch", body, {
    envelope: "spread",
  });
}

export function updateBranch(
  api: KazhalApi,
  id: number,
  body: { name?: string; address?: string; phone?: string },
): Promise<{ message: string; data: AdminBranchRow }> {
  return api.client.patch<{ message: string; data: AdminBranchRow }>(
    `/branch/${id}`,
    body,
    { envelope: "spread" },
  );
}

export function setBranchActive(
  api: KazhalApi,
  id: number,
  isActive: boolean,
): Promise<{ message: string; data: AdminBranchDetail }> {
  return api.client.patch<{ message: string; data: AdminBranchDetail }>(
    `/branch/${id}/active`,
    { isActive },
    { envelope: "spread" },
  );
}

export function deleteBranch(api: KazhalApi, id: number): Promise<{ message: string }> {
  return api.client.delete<{ message: string }>(`/branch/${id}`, undefined, {
    envelope: "spread",
  });
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export interface AuditRow {
  id: string;
  actorUserId: number | null;
  actorDisplaySnapshot: string;
  actorAudience: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  targetLabel: string | null;
  summary: Record<string, unknown> | null;
  createdAt: string;
}

export function fetchAudit(
  api: KazhalApi,
  filters: {
    page?: number;
    limit?: number;
    action?: string;
    targetType?: string;
    targetId?: string;
    actorUserId?: number;
    from?: string;
    to?: string;
  } = {},
  options: CallOptions = {},
): Promise<AdminPage<AuditRow>> {
  return api.client.get<AdminPage<AuditRow>>("/admin/audit", {
    ...options,
    envelope: "spread",
    query: query(filters),
  });
}

// ---------------------------------------------------------------------------
// Orders
//
// `GET /orders` is the ADMIN list: a bounded, filtered projection, not the
// order entity. Two properties of it shape everything below.
//
//  1. IT IS AN ALLOW-LIST. The server names every field it publishes
//     (`views/admin-order.view.ts`), so the gateway session id, the live
//     `addresses` row and the live catalogue row are absent by construction —
//     not merely unused here. The types therefore mirror the view exactly and
//     must not be "helpfully" widened with fields the wire does not carry.
//  2. THE LIST CARRIES MINIMAL CUSTOMER IDENTITY ON PURPOSE. `customerDisplay`
//     is a name or an already-masked telephone number (`***1234`), masked by
//     the SERVER. Nothing in this app may attempt to un-mask it; the full
//     address and telephone number exist only on the detail endpoint, which an
//     operator has to open deliberately.
// ---------------------------------------------------------------------------

export type AdminOrderChannel = "online" | "pos";

/** Every member of the API's `OrderStatusEnum`, in lifecycle order. */
export const ADMIN_ORDER_STATUSES = [
  "pending",
  "paid",
  "processing",
  "shipped",
  "delivered",
  "canceled",
  "failed",
  "refunded",
] as const;
export type AdminOrderStatus = (typeof ADMIN_ORDER_STATUSES)[number];

/** Every member of the API's `FulfillmentStateEnum` — the state of the GOODS. */
export const ADMIN_FULFILLMENT_STATES = [
  "not_required",
  "pending",
  "fulfilled",
  "awaiting_stock",
  "failed",
] as const;
export type AdminFulfillmentState = (typeof ADMIN_FULFILLMENT_STATES)[number];

/**
 * The DERIVED money state of an order, computed by the server from its receipts
 * with the precedence `success > refunded > pending > failed > none`.
 *
 * `none` is not "no payment attempt ever": a receipt whose status is
 * `confirmed_unapplied` — real money that deliberately settled nothing — is
 * also reported as `none`, because calling it `success` or `pending` would each
 * be a false statement. Such an order belongs to the reconciliation queue, and
 * this field is a coarse list filter rather than a reconciliation report.
 */
export const ADMIN_ORDER_PAYMENT_STATES = [
  "success",
  "refunded",
  "pending",
  "failed",
  "none",
] as const;
export type AdminOrderPaymentState = (typeof ADMIN_ORDER_PAYMENT_STATES)[number];

/** Every member of the API's `OrderReconciliationState`. NULL is not one of them. */
export const ADMIN_RECONCILIATION_STATES = [
  "open",
  "refund_required",
  "refund_confirmed",
  "backordered",
  "resolved",
] as const;
export type AdminReconciliationState = (typeof ADMIN_RECONCILIATION_STATES)[number];

/**
 * The reconciliation FILTER, which has one more value than the column.
 *
 * A query string cannot express NULL, and NULL here is a real and distinct
 * state — "this case has never been touched", which is NOT the same as `open`.
 * The server accepts the literal `none` for it, so the console must send that
 * string rather than omitting the parameter (omitting it means "any").
 */
export const ADMIN_RECONCILIATION_FILTERS = [
  ...ADMIN_RECONCILIATION_STATES,
  "none",
] as const;
export type AdminOrderReconciliationFilter =
  (typeof ADMIN_RECONCILIATION_FILTERS)[number];

/**
 * Which timestamp `from`/`to` range on. Three genuinely different questions,
 * and the answer to "what did we sell in Shahrivar" is not the answer to "what
 * money arrived in Shahrivar" — an online basket checked out on the last day of
 * a month and paid on the first of the next belongs to one month's orders and
 * the other month's revenue.
 */
export const ADMIN_ORDER_DATE_FIELDS = ["sold", "paid", "created"] as const;
export type AdminOrderDateField = (typeof ADMIN_ORDER_DATE_FIELDS)[number];

/** One row of `GET /orders`. Every money figure is an integer-Rial STRING. */
export interface AdminOrderRow {
  id: number;
  orderNumber: string | null;
  channel: AdminOrderChannel;
  status: AdminOrderStatus;
  fulfillmentState: AdminFulfillmentState;
  paymentState: AdminOrderPaymentState;
  reconciliationState: AdminReconciliationState | null;
  branchId: number | null;
  /** The branch name AS IT WAS at sale time. Survives a later rename. */
  branchNameSnapshot: string | null;
  cashierUserId: number | null;
  /** WHO SOLD IT, frozen at sale time — never the person who later voided it. */
  cashierDisplaySnapshot: string | null;
  customerId: number | null;
  /** Already masked by the server where it is a telephone number. */
  customerDisplay: string | null;
  userId: number | null;
  itemCount: number;
  unitCount: number;
  subtotal: string;
  totalPrice: string;
  soldAt: string | null;
  paidAt: string | null;
  voidedAt: string | null;
  refundedAt: string | null;
  createdAt: string | null;
}

/**
 * One sold line, read from the IMMUTABLE `order_items.*Snapshot` columns.
 *
 * `productId` / `variantId` are provenance only. The title, the SKU and the
 * attributes are what they were when the sale was rung up, which is why
 * renaming or re-pricing a product cannot rewrite a historical order.
 */
export interface AdminOrderItem {
  id: number;
  productId: number | null;
  variantId: number | null;
  productTitleSnapshot: string;
  variantSkuSnapshot: string | null;
  attributesSnapshot: Record<string, string> | null;
  quantity: number;
  unitPrice: string;
  totalPrice: string;
}

/**
 * WHERE THE GOODS WERE SENT, frozen at checkout — `orders.addressSnapshot`,
 * never the live `addresses` row the customer can still edit or delete.
 *
 * `capturedAt === null` marks a pre-migration order whose text was
 * RECONSTRUCTED. `backfilled` is the entity's own flag for the same condition;
 * the server's allow-list does not currently project it, so it is optional here
 * and either signal is treated as "reconstructed" rather than as a claim about
 * what the address said at order time.
 */
export interface AdminOrderAddressSnapshot {
  addressId: number;
  province: string;
  city: string;
  address: string;
  postalCode: string;
  receiverMobile: string;
  capturedAt: string | null;
  backfilled?: boolean;
}

/** One receipt. The gateway SESSION id is not served and must never be shown. */
export interface AdminOrderPayment {
  id: number;
  status: string;
  /** What WE asked for. */
  amount: string;
  /** What the GATEWAY reported. NULL when it reported nothing usable. */
  gatewayAmount: string | null;
  /** The reference an operator quotes. NOT the gateway session id. */
  refNumber: string | null;
  paidAt: string | null;
  requiresReconciliation: boolean;
  reconciliationReason: string | null;
  reconciledAt: string | null;
  createdAt: string | null;
}

/** The phase-2 retry queue for one order. `lastError` is raw internal text. */
export interface AdminOrderFulfilment {
  state: AdminFulfillmentState;
  attempts: number;
  lastAttemptAt: string | null;
  /** NULL means DUE NOW, not "never". */
  nextAttemptAt: string | null;
  lastError: string | null;
}

export interface AdminOrderReconciliation {
  state: AdminReconciliationState | null;
  resolvedAt: string | null;
}

/**
 * One order, for the administrator.
 *
 * `allowedStatusTransitions`, `canVoid` and `canReturn` are computed BY THE
 * SERVER from the same conditions its mutation endpoints enforce, and already
 * filtered by this caller's capabilities. The console must offer exactly what
 * they say and nothing more: deriving affordances from a local copy of the
 * rules is how an operator finds out by clicking a button and getting a 409.
 */
export interface AdminOrderDetail extends AdminOrderRow {
  items: AdminOrderItem[];
  address: AdminOrderAddressSnapshot | null;
  customer: { id: number; mobile: string; name: string | null } | null;
  user: { id: number; identifier: string } | null;
  payments: AdminOrderPayment[];
  fulfilment: AdminOrderFulfilment;
  reconciliation: AdminOrderReconciliation;
  allowedStatusTransitions: AdminOrderStatus[];
  canVoid: boolean;
  canReturn: boolean;
}

/** One append-only entry of an order's administrative history. */
export interface AdminOrderAction {
  id: number;
  /** `status_change`, `void`, `return` or `refund`. */
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorUserId: number | null;
  /** WHO DID IT, frozen at the time of the act. Survives a rename or deletion. */
  actorDisplaySnapshot: string;
  reason: string | null;
  createdAt: string;
}

export interface AdminOrderFilters {
  page?: number;
  limit?: number;
  /** Matches `orderNumber` anywhere; a bare number also matches `id` exactly. */
  search?: string;
  channel?: AdminOrderChannel;
  status?: AdminOrderStatus;
  fulfillmentState?: AdminFulfillmentState;
  paymentState?: AdminOrderPaymentState;
  branchId?: number;
  cashierUserId?: number;
  customerId?: number;
  userId?: number;
  reconciliationState?: AdminOrderReconciliationFilter;
  /** INCLUSIVE local calendar day (`YYYY-MM-DD`) in the report timezone. */
  from?: string;
  /** INCLUSIVE local calendar day. The day itself is fully included. */
  to?: string;
  dateField?: AdminOrderDateField;
}

/** `GET /orders` — `orders.read`. The handler's keys sit beside `success`. */
export function fetchOrders(
  api: KazhalApi,
  filters: AdminOrderFilters = {},
  options: CallOptions = {},
): Promise<AdminPage<AdminOrderRow>> {
  return api.client.get<AdminPage<AdminOrderRow>>("/orders", {
    ...options,
    envelope: "spread",
    query: query(filters),
  });
}

/** `GET /orders/:id` — `orders.read`. Returns `{ data: … }`. */
export function fetchOrder(
  api: KazhalApi,
  id: number,
  options: CallOptions = {},
): Promise<AdminOrderDetail> {
  return api.client.get<AdminOrderDetail>(`/orders/${id}`, {
    ...options,
    envelope: "data",
  });
}

/**
 * `GET /orders/:id/actions` — a SEPARATE capability, `orders.actions.read`.
 *
 * The page is nested inside `data`, so the envelope mode is `"data"` and the
 * `AdminPage` comes back whole. The server's default limit here is 50 rather
 * than 10: an order's history is normally read in one go.
 */
export function fetchOrderActions(
  api: KazhalApi,
  id: number,
  filters: { page?: number; limit?: number } = {},
  options: CallOptions = {},
): Promise<AdminPage<AdminOrderAction>> {
  return api.client.get<AdminPage<AdminOrderAction>>(`/orders/${id}/actions`, {
    ...options,
    envelope: "data",
    query: query(filters),
  });
}

/**
 * `PATCH /orders/status/:id` — `orders.status.update`.
 *
 * Moves the order along its lifecycle. It moves NO money and touches NO stock;
 * `canceled` and `refunded` are deliberately unreachable through it, because
 * those two have to restore stock and are owned by void and return.
 */
export function updateOrderStatus(
  api: KazhalApi,
  id: number,
  status: AdminOrderStatus,
): Promise<{ message: string; data: AdminOrderRow }> {
  return api.client.patch<{ message: string; data: AdminOrderRow }>(
    `/orders/status/${id}`,
    { status },
    { envelope: "spread" },
  );
}

/**
 * `POST /orders/:id/void` — `orders.void`. 200, not 201.
 *
 * Restores every unit to stock, removes the sale from the figures and marks the
 * order cancelled. Not reversible. `reason` is optional per `ReverseOrderDto`
 * and is stored on the append-only `order_actions` row with the acting user.
 */
export function voidOrder(
  api: KazhalApi,
  id: number,
  body: { reason?: string } = {},
): Promise<{ message: string; data: AdminOrderRow }> {
  return api.client.post<{ message: string; data: AdminOrderRow }>(
    `/orders/${id}/void`,
    body,
    { envelope: "spread" },
  );
}

/**
 * `POST /orders/:id/return` — `orders.return`. 200, not 201.
 *
 * Restores stock and records a REFUND in the reports, dated today rather than
 * on the original sale date. It moves no money: there is no gateway refund API
 * in this system, so the money itself is returned in the provider's own panel.
 */
export function returnOrder(
  api: KazhalApi,
  id: number,
  body: { reason?: string } = {},
): Promise<{ message: string; data: AdminOrderRow }> {
  return api.client.post<{ message: string; data: AdminOrderRow }>(
    `/orders/${id}/return`,
    body,
    { envelope: "spread" },
  );
}

// ---------------------------------------------------------------------------
// Categories
//
// THE CATEGORY LIST IS FLAT. `categories` has no `parentId` column, so there is
// no hierarchy to read, write or render — see `AdminCategoryRow`. The admin list
// (`/categories/admin`) differs from the public one only by carrying
// `createdAt` and by being paginated and searchable; product MEMBERSHIP is owned
// by the product endpoints (`categoryIds` on product create/update is the whole
// desired set), which is why nothing here can move a product between categories.
// ---------------------------------------------------------------------------

export interface AdminCategoryRow {
  id: number;
  title: string;
  /** Products currently in this category. A non-zero count blocks the delete. */
  productCount: number;
  createdAt: string;
}

export interface AdminCategoryFilters {
  page?: number;
  limit?: number;
  /** Case-insensitive substring of the title. */
  search?: string;
}

/**
 * What a category WRITE returns.
 *
 * Deliberately NOT `AdminCategoryRow`: the create and rename handlers return the
 * saved entity, whose timestamps are the raw snake_case columns and which
 * carries no `productCount` at all. Typing it as the list row would promise a
 * count the wire does not send and the screen would render `undefined`.
 */
export interface AdminCategoryWritten {
  id: number;
  title: string;
  created_at?: string;
  updated_at?: string;
}

/** `GET /categories/admin` — `categories.read`. Keys sit beside `success`. */
export function fetchAdminCategories(
  api: KazhalApi,
  filters: AdminCategoryFilters = {},
  options: CallOptions = {},
): Promise<AdminPage<AdminCategoryRow>> {
  return api.client.get<AdminPage<AdminCategoryRow>>("/categories/admin", {
    ...options,
    envelope: "spread",
    query: query(filters),
  });
}

/**
 * `POST /categories` — `categories.create`.
 *
 * 409 `CATEGORY_TITLE_TAKEN` with `details: { title }` when the title already
 * exists case-insensitively. The server compares in the application with no
 * unique constraint behind it, so this catches the ordinary human duplicate and
 * not a race — which is why the console must render the refusal rather than
 * treat a successful POST as proof of uniqueness.
 */
export function createCategory(
  api: KazhalApi,
  body: { title: string },
): Promise<{ message: string; data: AdminCategoryWritten }> {
  return api.client.post<{ message: string; data: AdminCategoryWritten }>(
    "/categories",
    body,
    { envelope: "spread" },
  );
}

/** `PATCH /categories/:id` — `categories.update`. Title only. */
export function renameCategory(
  api: KazhalApi,
  id: number,
  body: { title: string },
): Promise<{ message: string; data: AdminCategoryWritten }> {
  return api.client.patch<{ message: string; data: AdminCategoryWritten }>(
    `/categories/${id}`,
    body,
    { envelope: "spread" },
  );
}

/**
 * `DELETE /categories/:id` — `categories.delete`.
 *
 * Refused with 409 `CATEGORY_IN_USE` and `details: { categoryId, productCount }`
 * while any product is still in the category. The endpoint never detaches the
 * products for the caller, because the membership it would drop is recorded
 * nowhere else and could not be reconstructed.
 */
export function deleteCategory(api: KazhalApi, id: number): Promise<{ message: string }> {
  return api.client.delete<{ message: string }>(`/categories/${id}`, undefined, {
    envelope: "spread",
  });
}

// ---------------------------------------------------------------------------
// Attributes (the variant vocabulary)
//
// ATTRIBUTES ARE PAGINATED, THEIR VALUES ARE NOT. The server inlines every value
// of every attribute it returns, because half a colour list answers no question
// an administrator has, while the number of attributes grows with the catalogue.
//
// There is no "replace the values" call and there must not be one:
// `ProductAttribute.values` is `orphanedRowAction: 'delete'`, so a PATCH that
// accepted the whole array would retire every value the payload happened to
// omit — rows that live variants reference and that are frozen into
// `order_items.attributesSnapshot`. Adding, renaming and deleting are therefore
// three separate, explicit acts.
// ---------------------------------------------------------------------------

export interface AdminAttributeValueRow {
  id: number;
  value: string;
  /** Product variants using this value. A non-zero count blocks its delete. */
  variantCount: number;
}

export interface AdminAttributeRow {
  id: number;
  name: string;
  values: AdminAttributeValueRow[];
}

/**
 * What an attribute WRITE returns: the attribute with its values, but WITHOUT
 * the `variantCount` on each — the write handlers do not compute usage. The
 * screen therefore refetches the list rather than patching a row in place from
 * this, which would silently zero every count.
 */
export interface AdminAttributeWritten {
  id: number;
  name: string;
  values: Array<{ id: number; value: string }>;
}

/** What a VALUE rename returns — the value plus its parent, nothing else. */
export interface AdminAttributeValueWritten {
  id: number;
  value: string;
  attribute: { id: number; name: string };
}

/** `GET /attributes/admin` — `attributes.read`. Server default limit is 50. */
export function fetchAdminAttributes(
  api: KazhalApi,
  filters: { page?: number; limit?: number } = {},
  options: CallOptions = {},
): Promise<AdminPage<AdminAttributeRow>> {
  return api.client.get<AdminPage<AdminAttributeRow>>("/attributes/admin", {
    ...options,
    envelope: "spread",
    query: query(filters),
  });
}

/** `POST /attributes` — `attributes.create`. At least one value is required. */
export function createAttribute(
  api: KazhalApi,
  body: { name: string; values: string[] },
): Promise<{ message: string; data: AdminAttributeWritten }> {
  return api.client.post<{ message: string; data: AdminAttributeWritten }>(
    "/attributes",
    body,
    { envelope: "spread" },
  );
}

/**
 * `PATCH /attributes/:id` — `attributes.update`. Renames the ATTRIBUTE.
 *
 * 409 `ATTRIBUTE_ALREADY_EXISTS` with `details: { name }`.
 */
export function renameAttribute(
  api: KazhalApi,
  id: number,
  body: { name: string },
): Promise<{ message: string; data: AdminAttributeWritten }> {
  return api.client.patch<{ message: string; data: AdminAttributeWritten }>(
    `/attributes/${id}`,
    body,
    { envelope: "spread" },
  );
}

/**
 * `POST /attributes/:id/values` — `attributes.create`, not `.update`.
 *
 * ADDS values; the existing ones are left alone. 409
 * `ATTRIBUTE_VALUE_ALREADY_EXISTS` with `details: { attributeId, values }` when
 * one of them is already there.
 */
export function addAttributeValues(
  api: KazhalApi,
  id: number,
  body: { values: string[] },
): Promise<{ message: string; data: AdminAttributeWritten }> {
  return api.client.post<{ message: string; data: AdminAttributeWritten }>(
    `/attributes/${id}/values`,
    body,
    { envelope: "spread" },
  );
}

/**
 * `PATCH /attributes/values/:id` — `attributes.update`. The id is an
 * `attribute_values.id`, NOT an `attributes.id`.
 *
 * The new text applies from now on. It does NOT rewrite history: a sold line
 * keeps the attribute text copied into `order_items.attributesSnapshot` at sale
 * time, so past orders keep reading as they were rung up.
 */
export function renameAttributeValue(
  api: KazhalApi,
  id: number,
  body: { value: string },
): Promise<{ message: string; data: AdminAttributeValueWritten }> {
  return api.client.patch<{ message: string; data: AdminAttributeValueWritten }>(
    `/attributes/values/${id}`,
    body,
    { envelope: "spread" },
  );
}

/**
 * `DELETE /attributes/:id` — `attributes.delete`.
 *
 * 409 `ATTRIBUTE_IN_USE` with `details: { attributeId, variantCount }` while any
 * of its values is still on a variant. WHICH variants block it is not served by
 * any endpoint, so a screen may report the count and must not invent the list.
 */
export function deleteAttribute(api: KazhalApi, id: number): Promise<{ message: string }> {
  return api.client.delete<{ message: string }>(`/attributes/${id}`, undefined, {
    envelope: "spread",
  });
}

/**
 * `DELETE /attributes/values/:id` — `attributes.delete`.
 *
 * 409 `ATTRIBUTE_IN_USE` with `details: { attributeValueId, variantCount }`.
 */
export function deleteAttributeValue(
  api: KazhalApi,
  id: number,
): Promise<{ message: string }> {
  return api.client.delete<{ message: string }>(`/attributes/values/${id}`, undefined, {
    envelope: "spread",
  });
}

// ---------------------------------------------------------------------------
// Inventory
//
// STOCK IS ONE GLOBAL POOL. There is no per-branch stock column anywhere in
// this schema, so no route here takes a branch and no figure below is
// branch-scoped. The list reports that fact on the wire as `scope: "global"`,
// and the console renders its disclosure FROM THAT FIELD rather than from a
// hardcoded sentence — the day stock becomes per-branch, the screen should stop
// claiming otherwise because the API stopped saying so.
//
// FIVE QUANTITIES, NEVER INTERCHANGEABLE:
//   physicalStock    what is on the shelf
//   basketReserved   held by customers' baskets (four-hour reservations)
//   orderAllocated   held by created-but-unpaid/unfulfilled online orders
//   availableForWeb  physicalStock − basketReserved − orderAllocated
//   availableForPos  physicalStock − orderAllocated
// The gap between the last two is exactly what a till sale may take from
// baskets. Both are clamped at 0 for display.
//
// MONEY HERE IS A NUMBER, not a string: `product_variants.price` and
// `products.basePrice` are integer columns well inside `Number.MAX_SAFE_INTEGER`
// and the server sends them as JSON numbers. Render them with `<Money />`.
// `price === null` means the variant INHERITS the product's base price — and
// ZERO IS A REAL PRICE, so a falsy test here would misreport a free item as an
// inheriting one.
// ---------------------------------------------------------------------------

/** Always `"global"` today. Typed as a string union so a new scope is a type error. */
export type StockScope = "global";

/**
 * The three stock bands. They PARTITION the filtered set for a given threshold,
 * so `in_stock` means "comfortably stocked" (`availableForWeb > threshold`) and
 * not merely "> 0" — overlapping bands would make the header counts contradict
 * the rows underneath them.
 */
export const STOCK_STATES = ["in_stock", "low_stock", "out_of_stock"] as const;
export type StockStateFilter = (typeof STOCK_STATES)[number];

/** The API's `StockMovementReason`, in full. Persian labels live in `lib/labels.ts`. */
export const STOCK_MOVEMENT_REASONS = [
  "pos_sale",
  "online_fulfillment",
  "cancellation_restore",
  "return_restore",
  "manual_adjustment",
  /*
   * Opening stock written with a product (or a variant created later). The API
   * has written it since opening stock became ledgered; the filter and the
   * labels simply never listed it.
   */
  "initial_stock",
  /* Purchase-cost accounting (docs/PURCHASE-COST-ACCOUNTING.md §6). */
  "stock_receipt",
  "inventory_correction",
  /* `delta = 0`: legacy units given a value, no unit moved. */
  "valuation_initialization",
] as const;
export type StockMovementReason = (typeof STOCK_MOVEMENT_REASONS)[number];

/**
 * The server's default low-stock boundary, mirrored so a screen can SAY what it
 * is. It is a DISPLAY HEURISTIC, not an owner-set reorder point: nothing refuses
 * a sale because of it and no customer is ever shown it.
 */
export const DEFAULT_LOW_STOCK_THRESHOLD = 5;

/** One row of the stock list — ONE VARIANT, never one product. */
export interface InventoryStockRow {
  variantId: number;
  sku: string;
  isActive: boolean;
  isDefault: boolean;
  productId: number;
  productTitle: string;
  categories: Array<{ id: number; title: string }>;
  /** NULL = inherits the product's base price. `0` is a real price. */
  price: number | null;
  /** `COALESCE(variant.price, product.basePrice)` in integer Rial. */
  effectivePrice: number | null;
  physicalStock: number;
  basketReserved: number;
  orderAllocated: number;
  availableForWeb: number;
  availableForPos: number;
  /** Computed against the REQUESTED threshold, not a stored reorder point. */
  lowStock: boolean;
  outOfStock: boolean;
}

/** Computed over the WHOLE filtered set, not over the page. */
export interface InventorySummary {
  lowStockCount: number;
  outOfStockCount: number;
  trackedVariantCount: number;
}

export interface AdminInventoryFilters {
  page?: number;
  limit?: number;
  /** Product TITLE or variant SKU. A stockroom search is as often a code as a name. */
  search?: string;
  categoryId?: number;
  stockState?: StockStateFilter;
  lowStockThreshold?: number;
  /** Retired variants are hidden by default: they still hold physical stock. */
  includeInactive?: boolean;
}

/** One append-only ledger row. `stock_movements` is never updated or deleted. */
export interface StockMovementRow {
  id: number;
  variantId: number;
  sku: string;
  productId: number;
  productTitle: string;
  /** Signed. Negative took units off the shelf, positive put them back. */
  delta: number;
  /** COMMITTED physical stock immediately after this movement. */
  balanceAfter: number;
  reason: StockMovementReason;
  /**
   * The HUMAN sentence an administrator typed for a manual adjustment, stored
   * on the ledger row itself. It is a SIBLING of `reason`, never a
   * replacement: `reason` is the machine value the filter accepts, this is
   * what a reader needs.
   *
   * `null` for every SYSTEM movement (a POS sale, an online fulfilment, a
   * cancellation or return restore) — nobody authored one — and `null` on rows
   * written before the ledger could carry the text, whose explanations are
   * only in the administrative audit trail. Never an empty string, so a
   * truthiness test is safe here.
   */
  reasonText: string | null;
  orderId: number | null;
  orderNumber: string | null;
  actorUserId: number | null;
  /** WHO DID IT, frozen at the time. Survives a rename or a deleted account. */
  actorDisplaySnapshot: string | null;
  /** WHERE it was rung up. It does NOT scope the stock — see the header. */
  branchId: number | null;
  createdAt: string;
}

/** The single-variant read: the same row plus its most recent movements. */
export interface InventoryVariantDetail extends InventoryStockRow {
  recentMovements: StockMovementRow[];
}

/** What one adjustment reports back, so the caller need not re-read the row. */
export interface StockAdjustOutcome {
  variantId: number;
  productId: number;
  sku: string;
  previousStock: number;
  balanceAfter: number;
  basketReserved: number;
  orderAllocated: number;
  /** True when the NEW balance is under the held quantity, override or not. */
  belowReserved: boolean;
  availability: {
    physicalStock: number;
    basketReserved: number;
    orderAllocated: number;
    availableForWeb: number;
    availableForPos: number;
    lowStock: boolean;
    outOfStock: boolean;
  } | null;
}

/** `GET /admin/inventory` — `inventory.read`. `summary` and `scope` are siblings of `data`. */
export function fetchInventory(
  api: KazhalApi,
  filters: AdminInventoryFilters = {},
  options: CallOptions = {},
): Promise<AdminPage<InventoryStockRow> & { summary: InventorySummary; scope: StockScope }> {
  return api.client.get<
    AdminPage<InventoryStockRow> & { summary: InventorySummary; scope: StockScope }
  >("/admin/inventory", {
    ...options,
    envelope: "spread",
    query: query(filters),
  });
}

/**
 * `GET /admin/inventory/variants/:variantId` — `inventory.read`.
 *
 * Spread rather than `"data"` because `scope` sits BESIDE `data` on this route
 * too, and the disclosure is rendered from it. Retired variants resolve here
 * (with `isActive: false`) so their history stays readable.
 */
export function fetchInventoryVariant(
  api: KazhalApi,
  variantId: number,
  filters: { lowStockThreshold?: number } = {},
  options: CallOptions = {},
): Promise<{ data: InventoryVariantDetail; scope: StockScope }> {
  return api.client.get<{ data: InventoryVariantDetail; scope: StockScope }>(
    `/admin/inventory/variants/${variantId}`,
    { ...options, envelope: "spread", query: query(filters) },
  );
}

/**
 * `POST /admin/inventory/variants/:variantId/adjust` — `inventory.adjust`. 200.
 *
 * `reason` is MANDATORY, 4–500 chars AFTER TRIMMING — the server trims before it
 * validates, so a string of spaces is a 400. It is written to BOTH the ledger row
 * (`StockMovementRow.reasonText`, readable from `fetchStockMovements`) and the
 * administrative audit trail (`GET /admin/audit?action=stock.adjusted`).
 *
 * THE SAME REFUSAL ARRIVES WITH TWO STATUSES, and a caller must treat them
 * identically: **409** with `error: "STOCK_BELOW_RESERVED"` from the unlocked
 * pre-check, **400** from the authoritative re-check taken under the variant
 * row lock (whose message names the reserved quantities but carries no code). A
 * result below zero is refused with 400 always, override or not.
 */
export function adjustVariantStock(
  api: KazhalApi,
  variantId: number,
  body: {
    mode: "set" | "delta";
    value: number;
    reason: string;
    allowBelowReserved?: boolean;
  },
): Promise<{ message: string; data: StockAdjustOutcome; scope: StockScope }> {
  return api.client.post<{ message: string; data: StockAdjustOutcome; scope: StockScope }>(
    `/admin/inventory/variants/${variantId}/adjust`,
    body,
    { envelope: "spread" },
  );
}

export interface StockMovementFilters {
  page?: number;
  limit?: number;
  variantId?: number;
  productId?: number;
  reason?: StockMovementReason;
  /** System fulfilment writes a NULL actor, so any value here excludes it. */
  actorUserId?: number;
  orderId?: number;
  /** Inclusive lower bound on `createdAt`, ISO-8601. */
  from?: string;
  /** Inclusive upper bound on `createdAt`, ISO-8601. */
  to?: string;
}

/**
 * `GET /admin/inventory/movements` — `inventory.movements.read`, a capability of
 * its own and NOT implied by `inventory.read`.
 *
 * There is deliberately no free-text search: the ledger stores no free text.
 */
export function fetchStockMovements(
  api: KazhalApi,
  filters: StockMovementFilters = {},
  options: CallOptions = {},
): Promise<AdminPage<StockMovementRow>> {
  return api.client.get<AdminPage<StockMovementRow>>("/admin/inventory/movements", {
    ...options,
    envelope: "spread",
    query: query(filters),
  });
}

// ---------------------------------------------------------------------------
// Products (the admin list projection)
//
// A SUPERSET of the public list row, not a reuse of it. The public card answers
// "may a customer buy this, and for how much"; this one answers "is this product
// in a state I need to do something about", which needs the counts the storefront
// must never see (inactive variants, physical stock).
//
// THERE IS NO PRODUCT-LEVEL ACTIVE FLAG IN THIS SCHEMA. `sellableOnWeb` and
// `sellableOnPos` both mean "has at least one ACTIVE variant" and are therefore
// ALWAYS EQUAL — that is the honest answer, not a bug. What genuinely differs
// between the two surfaces is availability, which is what the two
// `has…AvailableStock` booleans report: a basket hold blocks a web sale and does
// not block a till sale. A product is unavailable exactly when every one of its
// variants is inactive.
// ---------------------------------------------------------------------------

export interface AdminProductRow {
  id: number;
  title: string;
  /** «کد محصول» — the shop's own business identifier. Searchable here and at the POS. */
  productCode: string;
  /**
   * WHERE THIS PRODUCT IS OFFERED, when the list endpoint reports it.
   *
   * Optional on purpose: `GET /products/admin` is a summary route and the
   * detail screen (`AdminProduct.visibility`) is the authority. A row that
   * arrives without it simply shows no channel summary, rather than claiming
   * the product is hidden — which is what a non-optional field defaulted to
   * `hiddenDraft` would do to every row on an older deployment.
   */
  visibility?: ProductVisibility;
  /** The product's own price, inherited by any variant whose `price` is NULL. */
  basePrice: number | null;
  categories: Array<{ id: number; title: string }>;
  primaryImage: { id: number; url: string; sortOrder: number | null } | null;
  /** EVERY variant, active or not. */
  variantCount: number;
  activeVariantCount: number;
  /** Physical stock summed over ACTIVE variants only. */
  totalStock: number;
  /** Cheapest active variant price, falling back to `basePrice`. */
  effectivePrice: number | null;
  /** Dearest active variant price, same fallback. Equal when there is one price. */
  maxEffectivePrice: number | null;
  /** OFFERABLE on the web — i.e. at least one active variant exists. */
  sellableOnWeb: boolean;
  /** OFFERABLE at the till. Always equal to `sellableOnWeb`; see the header. */
  sellableOnPos: boolean;
  /** Some active variant has `stock − basketReserved − orderAllocated > 0`. */
  hasWebAvailableStock: boolean;
  /** Some active variant has `stock − orderAllocated > 0`. */
  hasPosAvailableStock: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminProductFilters {
  page?: number;
  limit?: number;
  /** Product TITLE or any of its variants' SKUs — an admin often has the code. */
  search?: string;
  categoryId?: number;
  /** Tri-state: `true` = has an active variant, `false` = every variant is inactive. */
  sellable?: boolean;
  /** Band of the ACTIVE-variant stock TOTAL, with the same non-overlapping bands. */
  stockState?: StockStateFilter;
}

/** `GET /products/admin` — `products.read`. Keys sit beside `success`. */
export function fetchAdminProducts(
  api: KazhalApi,
  filters: AdminProductFilters = {},
  options: CallOptions = {},
): Promise<AdminPage<AdminProductRow>> {
  return api.client.get<AdminPage<AdminProductRow>>("/products/admin", {
    ...options,
    envelope: "spread",
    query: query(filters),
  });
}

// ===========================================================================
// PURCHASE COST, INVENTORY VALUATION AND GROSS PROFIT
//
// The contract is apps/api/docs/PURCHASE-COST-ACCOUNTING.md §13. Every route
// below is `@Roles(super_admin)` + `@Audiences('admin')` — a ROLE, not a
// delegable permission (§8) — so every caller in this app gates on
// `isSuperAdmin(session)` and never issues these requests for anybody else.
//
// WHY THESE TYPES LIVE HERE AND NOT IN `@kazhal/api-client`: that package is
// shared with the till (`apps/store`). Cashiers must never receive cost, and
// the cleanest way to keep that true is for the till's code base not to even
// know what a cost field is called.
//
// Money is an integer-Rial STRING everywhere (`"125000"`); percentages are
// two-decimal strings or `null`. Input money is sent as a base-10 string.
// Every mutation carries an `Idempotency-Key` minted ONCE per dialog open and
// reused on a retry of the same attempt.
// ===========================================================================

/**
 * The product-create / variant-create bodies, WITH the purchase cost.
 *
 * Only a super_admin's form ever sets `purchasePrice`; for anybody else the
 * key is never present (the API answers 403 PURCHASE_COST_FORBIDDEN).
 * Structural subtypes of the shared bodies, so `api.catalog.createProduct`
 * and `updateProduct` accept them unchanged.
 */
export type CostedCreateVariantBody = CreateVariantBody & { purchasePrice?: string };
export type CostedCreateProductBody = Omit<CreateProductBody, "variants"> & {
  purchasePrice?: string;
  variants?: CostedCreateVariantBody[];
};
export type CostedUpsertVariantBody = UpsertVariantBody & { purchasePrice?: string };

/**
 * Tolerates both `{ …view }` and `{ data: { …view } }` bodies: the handlers
 * are being written concurrently and §13 fixes the payload, not the wrapper.
 * `marker` is a key the view itself always carries.
 */
function single<T>(body: unknown, marker: string): T {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (record[marker] !== undefined) return body as T;
    const inner = record["data"];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      if ((inner as Record<string, unknown>)[marker] !== undefined) return inner as T;
    }
  }
  return body as T;
}

export type CostStatus = "valued" | "unvalued";

/** §13 `PoolView`. Counts are numbers, money strings. */
export interface CostPoolView {
  stock: number;
  unvaluedQuantity: number;
  valuedQuantity: number;
  /** Rial value of the VALUED units only — exact, never a rounded average. */
  inventoryCostValue: string;
  /** `floor(value / valuedQuantity)`, display only; null with no valued units. */
  averageUnitCost: string | null;
  costStatus: CostStatus;
}

export interface CostingVariantView extends CostPoolView {
  variantId: number;
  productId: number;
  productTitle: string;
  productCode: string | null;
  variantCode: string | null;
  sku: string;
  isDefault: boolean;
  isActive: boolean;
  sellingPrice: string | null;
  /** Last receipt's unit cost or the remembered default. Display/prefill only. */
  lastPurchaseUnitCost: string | null;
}

export interface CostingMovement {
  id: number;
  reason: StockMovementReason;
  delta: number;
  balanceAfter: number;
  unitCost: string | null;
  costDelta: string | null;
  inventoryValueAfter: string | null;
  unvaluedQuantityAfter: number | null;
  supplierReference: string | null;
  reasonText: string | null;
  orderId: number | null;
  actorDisplaySnapshot: string | null;
  createdAt: string;
}

export interface CostingVariantDetail extends CostingVariantView {
  recentMovements: CostingMovement[];
}

export interface CostingProductView {
  productId: number;
  productTitle: string;
  productCode: string | null;
  variants: CostingVariantView[];
  totals: { stock: number; unvaluedQuantity: number; inventoryCostValue: string };
}

/** `GET /admin/costing/products/:productId` — super_admin. */
export async function fetchCostingProduct(
  api: KazhalApi,
  productId: number,
  options: CallOptions = {},
): Promise<CostingProductView> {
  const body = await api.client.get<unknown>(`/admin/costing/products/${productId}`, {
    ...options,
    envelope: "spread",
  });
  return single<CostingProductView>(body, "variants");
}

/** `GET /admin/costing/variants/:variantId` — super_admin. Latest 20 movements. */
export async function fetchCostingVariant(
  api: KazhalApi,
  variantId: number,
  options: CallOptions = {},
): Promise<CostingVariantDetail> {
  const body = await api.client.get<unknown>(`/admin/costing/variants/${variantId}`, {
    ...options,
    envelope: "spread",
  });
  return single<CostingVariantDetail>(body, "variantId");
}

/** `GET /admin/costing/unvalued` — the legacy-valuation work list. */
export function fetchUnvaluedVariants(
  api: KazhalApi,
  params: { page?: number; limit?: number } = {},
  options: CallOptions = {},
): Promise<AdminPage<CostingVariantView>> {
  return api.client.get<AdminPage<CostingVariantView>>("/admin/costing/unvalued", {
    ...options,
    envelope: "spread",
    query: query(params),
  });
}

export interface StockReceiptBody {
  quantity: number;
  unitCost: string;
  supplierReference?: string;
  note?: string;
}

export interface StockReceiptResult {
  movementId: number;
  variantId: number;
  quantity: number;
  unitCost: string;
  incomingValue: string;
  before: CostPoolView;
  after: CostPoolView;
}

/**
 * `POST /admin/costing/variants/:variantId/receipts` — «ثبت ورود کالا». 201.
 * Same key + different body is 409 `STOCK_RECEIPT_IDEMPOTENCY_CONFLICT`.
 */
export async function postStockReceipt(
  api: KazhalApi,
  variantId: number,
  body: StockReceiptBody,
  idempotencyKey: string,
): Promise<StockReceiptResult> {
  const result = await api.client.post<unknown>(
    `/admin/costing/variants/${variantId}/receipts`,
    body,
    { envelope: "spread", idempotencyKey },
  );
  return single<StockReceiptResult>(result, "movementId");
}

/** Positive: exactly one of `unitCost` / `costUnknown`. Negative: neither. */
export interface InventoryCorrectionBody {
  quantityDelta: number;
  reason: string;
  unitCost?: string;
  costUnknown?: true;
  allowBelowReserved?: boolean;
}

export interface InventoryCorrectionResult {
  movementId: number;
  variantId: number;
  quantityDelta: number;
  costPolicy: "valued" | "unvalued" | "removed";
  costRemoved: string | null;
  before: CostPoolView;
  after: CostPoolView;
}

/** `POST /admin/costing/variants/:variantId/corrections` — «اصلاح موجودی». 201. */
export async function postInventoryCorrection(
  api: KazhalApi,
  variantId: number,
  body: InventoryCorrectionBody,
  idempotencyKey: string,
): Promise<InventoryCorrectionResult> {
  const result = await api.client.post<unknown>(
    `/admin/costing/variants/${variantId}/corrections`,
    body,
    { envelope: "spread", idempotencyKey },
  );
  return single<InventoryCorrectionResult>(result, "movementId");
}

/** Exactly one of `unitCost` / `totalValue`. */
export interface ValuationBody {
  expectedUnvaluedQuantity: number;
  unitCost?: string;
  totalValue?: string;
  note?: string;
}

export interface ValuationResult {
  movementId: number;
  variantId: number;
  valuedUnits: number;
  totalValue: string;
  before: CostPoolView;
  after: CostPoolView;
}

/**
 * `POST /admin/costing/variants/:variantId/valuation` — «ارزش‌گذاری موجودی قبلی».
 * 409 `INVENTORY_VALUATION_STALE` when the unvalued count moved; 409
 * `INVENTORY_ALREADY_VALUED` when nothing is unvalued.
 */
export async function postValuation(
  api: KazhalApi,
  variantId: number,
  body: ValuationBody,
  idempotencyKey: string,
): Promise<ValuationResult> {
  const result = await api.client.post<unknown>(
    `/admin/costing/variants/${variantId}/valuation`,
    body,
    { envelope: "spread", idempotencyKey },
  );
  return single<ValuationResult>(result, "movementId");
}

/** `PUT /admin/costing/variants/:variantId/purchase-price`. Never changes value. */
export async function putPurchasePrice(
  api: KazhalApi,
  variantId: number,
  unitCost: string | null,
  idempotencyKey: string,
): Promise<{ variantId: number; lastPurchaseUnitCost: string | null }> {
  const result = await api.client.put<unknown>(
    `/admin/costing/variants/${variantId}/purchase-price`,
    { unitCost },
    { envelope: "spread", idempotencyKey },
  );
  return single<{ variantId: number; lastPurchaseUnitCost: string | null }>(result, "variantId");
}

// ---------------------------------------------------------------------------
// Line adjustments — partial return / refund (§5)
// ---------------------------------------------------------------------------

export const LINE_ADJUSTMENT_KINDS = ["return_refund", "refund_only", "return_only"] as const;
export type LineAdjustmentKind = (typeof LINE_ADJUSTMENT_KINDS)[number];

export interface LineAdjustmentBody {
  kind: LineAdjustmentKind;
  reason: string;
  lines: Array<{ orderItemId: number; quantity: number }>;
}

export interface LineAdjustmentRow {
  id: number;
  orderItemId: number;
  revenueQuantity: number;
  revenueReversed: string;
  restockedKnownQuantity: number;
  restockedUnknownQuantity: number;
  cogsReversed: string | null;
}

export interface LineAdjustmentResult {
  orderId: number;
  kind: LineAdjustmentKind;
  adjustments: LineAdjustmentRow[];
  totals: { revenueReversed: string; cogsReversed: string; unitsRestocked: number };
}

/** `POST /admin/orders/:orderId/line-adjustments` — super_admin. 201. */
export async function postLineAdjustments(
  api: KazhalApi,
  orderId: number,
  body: LineAdjustmentBody,
  idempotencyKey: string,
): Promise<LineAdjustmentResult> {
  const result = await api.client.post<unknown>(
    `/admin/orders/${orderId}/line-adjustments`,
    body,
    { envelope: "spread", idempotencyKey },
  );
  return single<LineAdjustmentResult>(result, "adjustments");
}

// ---------------------------------------------------------------------------
// Gross profit reports — `/reports/profit/*` (§9)
// ---------------------------------------------------------------------------

export const PROFIT_GROUP_BY = [
  "day",
  "branch",
  "channel",
  "cashier",
  "product",
  "variant",
  "category",
] as const;
export type ProfitGroupBy = (typeof PROFIT_GROUP_BY)[number];

export type CostCoverage = "complete" | "partial" | "none";

export interface ProfitFilters {
  /** Inclusive local days, `YYYY-MM-DD`, Asia/Tehran. */
  from?: string;
  to?: string;
  channel?: AdminOrderChannel;
  branchId?: number;
  cashierUserId?: number;
  productId?: number;
  variantId?: number;
  categoryId?: number;
}

export interface ProfitSummary {
  timezone: string;
  range: { from: string | null; to: string | null; startUtc: string | null; endUtc: string | null };
  filters: Record<string, unknown>;
  totals: {
    grossSalesRevenue: string;
    revenueReversed: string;
    voidedRevenue: string;
    refundedRevenue: string;
    netSalesRevenue: string;
    unitsSold: number;
    unitsReturned: number;
    unitsRefundedWithoutReturn: number;
    knownCost: {
      grossRevenue: string;
      revenueReversed: string;
      netRevenue: string;
      cogs: string;
      cogsReversed: string;
      netCogs: string;
      grossProfit: string;
      grossMarginPercent: string | null;
      lineCount: number;
    };
    unknownCost: {
      grossRevenue: string;
      revenueReversed: string;
      netRevenue: string;
      pendingFulfilmentRevenue: string;
      unvaluedRevenue: string;
      lineCount: number;
    };
    coveragePercent: string | null;
    inventoryLosses: { units: number; knownCostRemoved: string; unknownCostUnits: number };
  };
  semantics?: Record<string, string>;
}

/** The money fields a breakdown row, an order row and an order total share. */
export interface ProfitMoneyFields {
  grossSalesRevenue: string;
  revenueReversed: string;
  netSalesRevenue: string;
  unitsSold: number;
  unitsReturned: number;
  knownNetRevenue: string;
  unknownNetRevenue: string;
  netCogs: string;
  /** `null` when coverage is `none` — rendered as "—", never as 0. */
  grossProfit: string | null;
  grossMarginPercent: string | null;
  coveragePercent: string | null;
  costCoverage: CostCoverage;
  warning: string | null;
}

export interface ProfitBreakdownRow extends ProfitMoneyFields {
  key: string | number | null;
  label: string | null;
}

export interface ProfitOrderRow extends ProfitMoneyFields {
  orderId: number;
  orderNumber: string | null;
  channel: AdminOrderChannel;
  branchNameSnapshot: string | null;
  cashierDisplaySnapshot: string | null;
  revenueAt: string | null;
}

export type OrderLineCostStatus = "pending" | "known" | "unknown";

export interface ProfitLineAdjustment {
  id: number;
  kind: "void" | LineAdjustmentKind;
  scope?: "order" | "line" | "legacy";
  revenueQuantity: number;
  revenueReversed: string;
  restockedKnownQuantity: number | null;
  restockedUnknownQuantity: number | null;
  cogsReversed: string | null;
  eventAt: string | null;
  reason?: string | null;
  actorDisplaySnapshot?: string | null;
}

export interface ProfitOrderLine {
  orderItemId: number;
  productTitle: string;
  productCode: string | null;
  variantCode: string | null;
  variantId: number | null;
  quantity: number;
  unitPrice: string;
  totalPrice: string;
  costStatus: OrderLineCostStatus;
  cogsTotal: string | null;
  unitCostDisplay: string | null;
  costKnownQuantity: number | null;
  costUnknownQuantity: number | null;
  /** What the line-adjustment form may still reverse. */
  remaining: { revenueUnits: number; restockUnits: number };
  adjustments: ProfitLineAdjustment[];
}

export interface ProfitOrderHeader {
  orderId?: number;
  orderNumber?: string | null;
  channel?: AdminOrderChannel;
  status?: string;
  branchNameSnapshot?: string | null;
  cashierDisplaySnapshot?: string | null;
  revenueAt?: string | null;
}

/**
 * `GET /reports/profit/orders/:orderId`. §13 names an "order header" without
 * fixing whether it is nested; both spellings are read (`order` first).
 */
export interface ProfitOrderDetail extends ProfitOrderHeader {
  order?: ProfitOrderHeader;
  lines: ProfitOrderLine[];
  totals?: Partial<ProfitMoneyFields>;
}

export async function fetchProfitSummary(
  api: KazhalApi,
  filters: ProfitFilters = {},
  options: CallOptions = {},
): Promise<ProfitSummary> {
  const body = await api.client.get<unknown>("/reports/profit/summary", {
    ...options,
    envelope: "spread",
    query: query(filters),
  });
  return single<ProfitSummary>(body, "totals");
}

export function fetchProfitBreakdown(
  api: KazhalApi,
  params: ProfitFilters & { groupBy: ProfitGroupBy; page?: number; limit?: number },
  options: CallOptions = {},
): Promise<AdminPage<ProfitBreakdownRow>> {
  return api.client.get<AdminPage<ProfitBreakdownRow>>("/reports/profit/breakdown", {
    ...options,
    envelope: "spread",
    query: query(params),
  });
}

export function fetchProfitOrders(
  api: KazhalApi,
  params: ProfitFilters & { page?: number; limit?: number },
  options: CallOptions = {},
): Promise<AdminPage<ProfitOrderRow>> {
  return api.client.get<AdminPage<ProfitOrderRow>>("/reports/profit/orders", {
    ...options,
    envelope: "spread",
    query: query(params),
  });
}

export async function fetchProfitOrder(
  api: KazhalApi,
  orderId: number,
  options: CallOptions = {},
): Promise<ProfitOrderDetail> {
  const body = await api.client.get<unknown>(`/reports/profit/orders/${orderId}`, {
    ...options,
    envelope: "spread",
  });
  return single<ProfitOrderDetail>(body, "lines");
}

// ---------------------------------------------------------------------------
// Monthly pricing plans (super_admin only; docs/MONTHLY-PRICING.md)
//
// Money is an integer-Rial string; rates are two-decimal percent strings.
// Inputs are sent the same way: amounts as base-10 strings, percents as text.
// ---------------------------------------------------------------------------

export const PRICING_PLAN_STATUSES = [
  "DRAFT",
  "CALCULATING",
  "READY_FOR_REVIEW",
  "APPROVED",
  "APPLYING",
  "APPLIED",
  "FAILED",
  "ROLLED_BACK",
] as const;
export type PricingPlanStatus = (typeof PRICING_PLAN_STATUSES)[number];

export const PRICING_ITEM_STATUSES = ["READY", "UNCHANGED", "NEEDS_REVIEW", "BLOCKED"] as const;
export type PricingItemStatus = (typeof PRICING_ITEM_STATUSES)[number];
export const PRICING_ITEM_VIEWS = ["exceptions", "all", "applicable"] as const;
export const PRICING_ITEM_DIRECTIONS = ["increase", "decrease", "none"] as const;
export const PRICING_ITEM_CHANNELS = ["site", "branches", "both", "none"] as const;
export const PRICING_ITEM_SORTS = [
  "product",
  "changePercent",
  "changeRial",
  "currentPrice",
  "finalPrice",
  "costBasis",
  "status",
] as const;

export interface PricingCostEntry {
  id: number;
  title: string;
  amountRial: string;
  scope: "general" | "branch";
  branchId: number | null;
  branchName: string | null;
  note: string | null;
  isActive: boolean;
  sortOrder: number;
}

export interface PricingRun {
  id: number;
  planId: number;
  kind: "calculate" | "apply" | "rollback";
  status: "queued" | "running" | "succeeded" | "failed";
  phase: string | null;
  totalItems: number;
  processedItems: number;
  expectedChangeCount: number | null;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  calculationMethod: string;
  formulaVersion: number;
  requestedByDisplay: string;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface PricingSummary {
  evaluated: number;
  ready: number;
  unchanged: number;
  needsReview: number;
  blocked: number;
  stale: number;
  included: number;
  approvedReview: number;
  applicable: number;
  applicableIncreases: number;
  applicableDecreases: number;
  overridden: number;
  averageChangePercent: string | null;
  minChangePercent: string | null;
  maxChangePercent: string | null;
}

export interface PricingPlanListRow {
  id: number;
  title: string;
  effectiveYear: number;
  effectiveMonth: number;
  status: PricingPlanStatus;
  calculationMethod: string;
  formulaVersion: number;
  itemCount: number;
  applicableCount: number;
  appliedAt: string | null;
  rolledBackAt: string | null;
  updatedAt: string;
}

export interface PricingPlan {
  id: number;
  title: string;
  effectiveYear: number;
  effectiveMonth: number;
  calculationMethod: string;
  formulaVersion: number;
  status: PricingPlanStatus;
  targetMonthlyRevenueRial: string | null;
  taxRatePercent: string | null;
  targetProfitMarginPercent: string | null;
  roundingStepRial: string;
  reviewMaxIncreasePercent: string;
  reviewDecreases: boolean;
  notes: string | null;
  copiedFromPlanId: number | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
  calculatedAt: string | null;
  approvedAt: string | null;
  appliedAt: string | null;
  rolledBackAt: string | null;
  costEntries: PricingCostEntry[];
  monthlyCostsTotalRial: string;
  operatingCostRatePercent: string | null;
  denominatorPercent: string | null;
  inputProblems: { code: string; message: string }[];
  isEditable: boolean;
  hasPreview: boolean;
  latestRun: PricingRun | null;
  summary: PricingSummary | null;
}

export interface PricingItem {
  id: number;
  variantId: number;
  productId: number;
  productTitle: string;
  productCode: string;
  variantCode: string;
  sku: string;
  isDefaultVariant: boolean;
  categoryIds: number[];
  visibleOnSite: boolean;
  branchVisibility: string;
  variantActive: boolean;
  costBasisRial: string | null;
  currentPriceRial: string | null;
  rawPrice: string | null;
  proposedPriceRial: string | null;
  overridePriceRial: string | null;
  finalPriceRial: string | null;
  changeRial: string | null;
  changePercent: string | null;
  status: PricingItemStatus;
  reasons: string[];
  included: boolean;
  reviewed: boolean;
  stale: boolean;
  staleReason: string | null;
  formulaVersion: number;
  calculatedAt: string;
  applicable: boolean;
}

export interface PricingItemFilters {
  view?: (typeof PRICING_ITEM_VIEWS)[number];
  search?: string;
  status?: PricingItemStatus;
  categoryId?: number;
  channel?: (typeof PRICING_ITEM_CHANNELS)[number];
  direction?: (typeof PRICING_ITEM_DIRECTIONS)[number];
  minChangePercent?: string;
  maxChangePercent?: string;
  included?: boolean;
  stale?: boolean;
}

export interface PricingItemQuery extends PricingItemFilters {
  page?: number;
  limit?: number;
  sort?: (typeof PRICING_ITEM_SORTS)[number];
  order?: "asc" | "desc";
}

export interface PricingPriceChange {
  id: number;
  runId: number;
  itemId: number | null;
  variantId: number;
  productId: number;
  kind: "apply" | "rollback";
  oldPriceRial: string | null;
  newPriceRial: string | null;
  revertsChangeId: number | null;
  calculationMethod: string;
  formulaVersion: number;
  changedByDisplay: string;
  changedAt: string;
  productTitle: string | null;
  variantCode: string | null;
  sku: string | null;
}

export interface PricingRollbackPreview {
  planStatus: PricingPlanStatus;
  applied: number;
  restorable: number;
  conflicts: number;
}

export interface UpdatePricingPlanBody {
  title?: string;
  effectiveYear?: number;
  effectiveMonth?: number;
  targetMonthlyRevenueRial?: string | null;
  taxRatePercent?: string;
  targetProfitMarginPercent?: string;
  roundingStepRial?: string;
  reviewMaxIncreasePercent?: string;
  reviewDecreases?: boolean;
  notes?: string | null;
}

export interface PricingCostEntryBody {
  title?: string;
  amountRial?: string;
  scope?: "general" | "branch";
  branchId?: number | null;
  note?: string | null;
  isActive?: boolean;
}

const PRICING = "/admin/pricing-plans";

export function fetchPricingPlans(
  api: KazhalApi,
  params: { page?: number; limit?: number; status?: PricingPlanStatus } = {},
  options: CallOptions = {},
): Promise<AdminPage<PricingPlanListRow>> {
  return api.client.get<AdminPage<PricingPlanListRow>>(PRICING, { ...options, envelope: "spread", query: query(params) });
}

export function fetchPricingPlan(api: KazhalApi, planId: number, options: CallOptions = {}): Promise<PricingPlan> {
  return api.client.get<PricingPlan>(`${PRICING}/${planId}`, { ...options, envelope: "data" });
}

export function createPricingPlan(
  api: KazhalApi,
  body: { title: string; effectiveYear: number; effectiveMonth: number; copyFromPlanId?: number },
): Promise<PricingPlan> {
  return api.client.post<PricingPlan>(PRICING, body, { envelope: "data" });
}

export function updatePricingPlan(api: KazhalApi, planId: number, body: UpdatePricingPlanBody): Promise<PricingPlan> {
  return api.client.patch<PricingPlan>(`${PRICING}/${planId}`, body, { envelope: "data" });
}

export function deletePricingPlan(api: KazhalApi, planId: number): Promise<unknown> {
  return api.client.delete<unknown>(`${PRICING}/${planId}`, { envelope: "data" });
}

export function addPricingCost(api: KazhalApi, planId: number, body: PricingCostEntryBody): Promise<PricingPlan> {
  return api.client.post<PricingPlan>(`${PRICING}/${planId}/costs`, body, { envelope: "data" });
}

export function updatePricingCost(
  api: KazhalApi,
  planId: number,
  entryId: number,
  body: PricingCostEntryBody,
): Promise<PricingPlan> {
  return api.client.patch<PricingPlan>(`${PRICING}/${planId}/costs/${entryId}`, body, { envelope: "data" });
}

export function removePricingCost(api: KazhalApi, planId: number, entryId: number): Promise<PricingPlan> {
  return api.client.delete<PricingPlan>(`${PRICING}/${planId}/costs/${entryId}`, { envelope: "data" });
}

export function reorderPricingCosts(api: KazhalApi, planId: number, entryIds: number[]): Promise<PricingPlan> {
  return api.client.put<PricingPlan>(`${PRICING}/${planId}/costs/order`, { entryIds }, { envelope: "data" });
}

export function calculatePricingPlan(api: KazhalApi, planId: number, idempotencyKey: string): Promise<PricingRun> {
  return api.client.post<PricingRun>(`${PRICING}/${planId}/calculate`, {}, { envelope: "data", idempotencyKey });
}

export function fetchPricingItems(
  api: KazhalApi,
  planId: number,
  params: PricingItemQuery,
  options: CallOptions = {},
): Promise<AdminPage<PricingItem>> {
  return api.client.get<AdminPage<PricingItem>>(`${PRICING}/${planId}/items`, {
    ...options,
    envelope: "spread",
    query: query(params),
  });
}

export function updatePricingItem(
  api: KazhalApi,
  planId: number,
  itemId: number,
  body: { included?: boolean; overridePriceRial?: string | null },
): Promise<PricingItem> {
  return api.client.patch<PricingItem>(`${PRICING}/${planId}/items/${itemId}`, body, { envelope: "data" });
}

export function bulkPricingItems(
  api: KazhalApi,
  planId: number,
  body: { filters: PricingItemFilters; included: boolean; approveNeedsReview?: boolean },
): Promise<{ updated: number; summary: PricingSummary }> {
  return api.client.post<{ updated: number; summary: PricingSummary }>(`${PRICING}/${planId}/items/bulk`, body, {
    envelope: "data",
  });
}

export function approvePricingPlan(api: KazhalApi, planId: number, expectedChangeCount: number): Promise<PricingPlan> {
  return api.client.post<PricingPlan>(`${PRICING}/${planId}/approve`, { expectedChangeCount }, { envelope: "data" });
}

export function unapprovePricingPlan(api: KazhalApi, planId: number): Promise<PricingPlan> {
  return api.client.post<PricingPlan>(`${PRICING}/${planId}/unapprove`, {}, { envelope: "data" });
}

export function applyPricingPlan(
  api: KazhalApi,
  planId: number,
  expectedChangeCount: number,
  idempotencyKey: string,
): Promise<PricingRun> {
  return api.client.post<PricingRun>(`${PRICING}/${planId}/apply`, { expectedChangeCount }, {
    envelope: "data",
    idempotencyKey,
  });
}

export function fetchPricingRollbackPreview(
  api: KazhalApi,
  planId: number,
  options: CallOptions = {},
): Promise<PricingRollbackPreview> {
  return api.client.get<PricingRollbackPreview>(`${PRICING}/${planId}/rollback-preview`, { ...options, envelope: "data" });
}

export function rollbackPricingPlan(api: KazhalApi, planId: number, idempotencyKey: string): Promise<PricingRun> {
  return api.client.post<PricingRun>(`${PRICING}/${planId}/rollback`, {}, { envelope: "data", idempotencyKey });
}

export function fetchPricingRun(api: KazhalApi, planId: number, runId: number, options: CallOptions = {}): Promise<PricingRun> {
  return api.client.get<PricingRun>(`${PRICING}/${planId}/runs/${runId}`, { ...options, envelope: "data" });
}

export function fetchPricingRuns(api: KazhalApi, planId: number, options: CallOptions = {}): Promise<PricingRun[]> {
  return api.client.get<PricingRun[]>(`${PRICING}/${planId}/runs`, { ...options, envelope: "data" });
}

export function fetchPricingChanges(
  api: KazhalApi,
  planId: number,
  params: { page?: number; limit?: number; kind?: "apply" | "rollback" } = {},
  options: CallOptions = {},
): Promise<AdminPage<PricingPriceChange>> {
  return api.client.get<AdminPage<PricingPriceChange>>(`${PRICING}/${planId}/changes`, {
    ...options,
    envelope: "spread",
    query: query(params),
  });
}
