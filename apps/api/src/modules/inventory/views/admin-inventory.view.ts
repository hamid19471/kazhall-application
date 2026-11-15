import { StockMovementReason } from '../entities/stock-movement.entity';

/**
 * ============================================================================
 * STOCK IS ONE GLOBAL POOL — there is no per-branch stock in this system.
 * ============================================================================
 *
 * `product_variants.stock` is a single number per sellable unit, and neither
 * `stock_reservations` nor `stock_movements` carries a branch that scopes it:
 * `stock_movements.branchId` records WHERE a sale was rung up, it does not
 * partition the shelf. A POS sale in branch A and an online order therefore
 * compete for exactly the same units.
 *
 * This constant is exported and put on the wire (`scope` on the stock list) so
 * the console can render that disclosure from the API instead of hard-coding a
 * sentence that would silently become a lie the day per-branch stock lands. If
 * it ever does, this becomes `'branch'` for branch-scoped reads and every
 * client that renders the field follows without a deploy.
 */
export const STOCK_SCOPE = 'global' as const;
export type StockScope = typeof STOCK_SCOPE;

/**
 * Default `lowStockThreshold` for the admin stock list.
 *
 * THIS IS A DISPLAY HEURISTIC, NOT A BUSINESS RULE. Nothing in the domain
 * defines "low": the owner has never set a reorder point, there is no column
 * for one, and no code path refuses a sale because of it. It exists so the
 * stock screen can colour a row and count a badge, and it is a request
 * parameter precisely so an operator can disagree with it per view. Do not
 * promote it to a rule (a purchase suggestion, an alert, a blocked sale)
 * without the owner setting a real per-variant reorder point first.
 */
export const DEFAULT_LOW_STOCK_THRESHOLD = 5;

/** Upper bound accepted for `lowStockThreshold`, so the filter stays sane. */
export const MAX_LOW_STOCK_THRESHOLD = 1000;

/** How many ledger rows the single-variant detail view carries inline. */
export const VARIANT_DETAIL_MOVEMENT_LIMIT = 20;

export interface AdminStockCategoryView {
  id: number;
  title: string;
}

/**
 * ONE ROW IS ONE VARIANT, never one product.
 *
 * The variant is the only sellable unit (see `ProductVariant.isDefault`), so a
 * product-level row would have to sum or hide the numbers that matter — and a
 * product whose blue SKU is exhausted while its red one is full is neither "in
 * stock" nor "out of stock" at product level.
 */
export interface AdminStockRowView {
  variantId: number;
  sku: string;
  isActive: boolean;
  isDefault: boolean;
  productId: number;
  productTitle: string;
  categories: AdminStockCategoryView[];
  /**
   * The variant's OWN price in integer Rial, `null` when it inherits. NULL is
   * the inheritance signal; ZERO IS A REAL PRICE and must never be treated as
   * "unset" — that is why this is reported separately from `effectivePrice`.
   */
  price: number | null;
  /** `COALESCE(v.price, p."basePrice")`. `null` only when neither is set. */
  effectivePrice: number | null;
  /** `product_variants.stock` — what is on the shelf. */
  physicalStock: number;
  basketReserved: number;
  orderAllocated: number;
  /** `physicalStock − basketReserved − orderAllocated`, clamped at 0. */
  availableForWeb: number;
  /** `physicalStock − orderAllocated`, clamped at 0. */
  availableForPos: number;
  /** `0 < availableForWeb <= lowStockThreshold`. Heuristic — see the constant. */
  lowStock: boolean;
  outOfStock: boolean;
}

/**
 * Counted over the FILTERED set, not over the page.
 *
 * The dashboard header and the page header ask the same question, and a
 * summary derived from the 10 rows that happen to be on page 3 would answer a
 * different one. It costs one aggregate query, never a second pass over rows.
 */
export interface AdminStockSummaryView {
  lowStockCount: number;
  outOfStockCount: number;
  /**
   * Every variant in the filtered set. Identical to `total` by construction —
   * the aggregate that produces the counts also produces the page total, which
   * is why the list costs two queries rather than three.
   */
  trackedVariantCount: number;
}

export interface AdminStockListPage {
  data: AdminStockRowView[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  summary: AdminStockSummaryView;
  /** Always `'global'` today. See `STOCK_SCOPE`. */
  scope: StockScope;
}

/**
 * One row of the append-only physical-stock ledger, joined to the names a
 * human needs to read it.
 *
 * `reason` is the MACHINE reason (`pos_sale`, `manual_adjustment`, …) and is
 * the only one code may branch on. `reasonText` is the HUMAN sentence beside
 * it (migration 0024) and is `null` for every movement no person authored.
 * The two are siblings, never substitutes: a client renders both.
 */
export interface AdminStockMovementRowView {
  id: number;
  variantId: number;
  sku: string;
  productId: number;
  productTitle: string;
  /** Negative for a decrement, positive for a restore. Never zero. */
  delta: number;
  /** COMMITTED physical stock immediately after this movement. */
  balanceAfter: number;
  reason: StockMovementReason;
  /**
   * The explanation an administrator typed for a manual adjustment, stored on
   * the ledger row itself since migration 0024.
   *
   * `null` for every SYSTEM-generated movement (a POS sale, an online
   * fulfilment, a cancellation or return restore) — nobody authored a sentence
   * for those — and `null` on rows written before the column existed, whose
   * explanations live only in `admin_audit_log`. It is never an empty string:
   * a blank value is refused by the database.
   */
  reasonText: string | null;
  orderId: number | null;
  /** `null` for a movement with no order (a manual adjustment) — LEFT JOIN. */
  orderNumber: string | null;
  actorUserId: number | null;
  /** Survives a rename, deactivation or deletion of the actor. */
  actorDisplaySnapshot: string | null;
  /** WHERE a sale was rung up. It does NOT scope the stock — see STOCK_SCOPE. */
  branchId: number | null;
  createdAt: Date;
}

export interface AdminMovementListPage {
  data: AdminStockMovementRowView[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface AdminVariantStockDetailView extends AdminStockRowView {
  /** Newest first, capped at `VARIANT_DETAIL_MOVEMENT_LIMIT`. */
  recentMovements: AdminStockMovementRowView[];
}
