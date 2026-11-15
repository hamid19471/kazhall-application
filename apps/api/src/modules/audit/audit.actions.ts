/**
 * THE ADMINISTRATIVE ACT CATALOGUE.
 *
 * Stable machine codes, mirrored by Persian labels in
 * `apps/web/lib/audit-labels.ts`. A code is written into rows that outlive the
 * code that wrote them, so renaming one orphans history — add and retire
 * instead.
 */
export const AuditAction = {
  // access control
  ROLE_CREATED: 'role.created',
  ROLE_UPDATED: 'role.updated',
  ROLE_ACTIVATED: 'role.activated',
  ROLE_DEACTIVATED: 'role.deactivated',
  ROLE_DELETED: 'role.deleted',
  ROLE_PERMISSIONS_CHANGED: 'role.permissions.changed',
  USER_ROLES_CHANGED: 'user.roles.changed',

  // users
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_ACTIVATED: 'user.activated',
  USER_DEACTIVATED: 'user.deactivated',
  USER_BRANCH_CHANGED: 'user.branch.changed',
  USER_PASSWORD_RESET: 'user.password.reset',
  USER_PASSWORD_CHANGED: 'user.password.changed',
  USER_SESSIONS_REVOKED: 'user.sessions.revoked',

  // branches
  BRANCH_CREATED: 'branch.created',
  BRANCH_UPDATED: 'branch.updated',
  BRANCH_ACTIVATED: 'branch.activated',
  BRANCH_DEACTIVATED: 'branch.deactivated',

  // catalogue
  CATEGORY_CREATED: 'category.created',
  CATEGORY_UPDATED: 'category.updated',
  CATEGORY_DELETED: 'category.deleted',
  ATTRIBUTE_CREATED: 'attribute.created',
  ATTRIBUTE_UPDATED: 'attribute.updated',
  ATTRIBUTE_DELETED: 'attribute.deleted',
  ATTRIBUTE_VALUE_CREATED: 'attribute.value.created',
  ATTRIBUTE_VALUE_UPDATED: 'attribute.value.updated',
  ATTRIBUTE_VALUE_DELETED: 'attribute.value.deleted',
  PRODUCT_CREATED: 'product.created',
  PRODUCT_UPDATED: 'product.updated',
  /**
   * A product's «کد محصول» was retyped, cascading to every variant's «کد گونه».
   *
   * Separate from `PRODUCT_UPDATED` because it is the one product edit that
   * rewrites OTHER rows, and an auditor asking "why did this variant's code
   * change" needs an entry that answers it directly rather than a generic
   * update they have to correlate by timestamp.
   */
  PRODUCT_CODE_CHANGED: 'product.code_changed',
  VARIANT_ACTIVATED: 'variant.activated',
  VARIANT_DEACTIVATED: 'variant.deactivated',

  // inventory
  STOCK_ADJUSTED: 'stock.adjusted',

  // purchase cost (docs/PURCHASE-COST-ACCOUNTING.md). `audit.read` is
  // delegable, so these summaries carry quantities and ids ONLY — never a Rial
  // cost. The cost evidence itself is on the super_admin-only movement.
  INVENTORY_RECEIPT_RECORDED: 'inventory.receipt.recorded',
  INVENTORY_CORRECTION_RECORDED: 'inventory.correction.recorded',
  INVENTORY_VALUATION_INITIALIZED: 'inventory.valuation.initialized',
  PURCHASE_COST_CHANGED: 'inventory.purchase_cost.changed',

  // monthly pricing plans (docs/MONTHLY-PRICING.md). Same rule as purchase
  // cost: `audit.read` is delegable, so these summaries carry ids, counts and
  // field NAMES only — never a cost, a revenue target, a rate or a price. The
  // prices themselves are in the super_admin-only `pricing_price_changes`.
  PRICING_PLAN_CREATED: 'pricing.plan.created',
  PRICING_PLAN_UPDATED: 'pricing.plan.updated',
  PRICING_PLAN_DELETED: 'pricing.plan.deleted',
  PRICING_PLAN_CALCULATED: 'pricing.plan.calculated',
  PRICING_PLAN_APPROVED: 'pricing.plan.approved',
  PRICING_PLAN_APPLIED: 'pricing.plan.applied',
  PRICING_PLAN_ROLLED_BACK: 'pricing.plan.rolled_back',

  // orders
  ORDER_STATUS_CHANGED: 'order.status.changed',
  ORDER_VOIDED: 'order.voided',
  ORDER_RETURNED: 'order.returned',
  ORDER_LINES_ADJUSTED: 'order.lines.adjusted',

  // reconciliation
  RECONCILIATION_ACTION: 'reconciliation.action',
} as const;

export type AuditActionCode = (typeof AuditAction)[keyof typeof AuditAction];

export const AUDIT_ACTION_CODES: readonly string[] = Object.freeze(
  Object.values(AuditAction),
);

/** Target kinds, so the audit screen can link a row back to its subject. */
export const AuditTarget = {
  USER: 'user',
  ROLE: 'role',
  BRANCH: 'branch',
  CATEGORY: 'category',
  ATTRIBUTE: 'attribute',
  ATTRIBUTE_VALUE: 'attribute_value',
  PRODUCT: 'product',
  VARIANT: 'variant',
  ORDER: 'order',
  PRICING_PLAN: 'pricing_plan',
} as const;

export type AuditTargetType = (typeof AuditTarget)[keyof typeof AuditTarget];
