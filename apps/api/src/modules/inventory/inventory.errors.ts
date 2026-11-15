import { InventoryMessages } from './inventory.messages';

/**
 * Raised when a guarded conditional UPDATE (R2 / R3) affected a number of rows
 * other than exactly 1.
 *
 * This is never expected in a correct run: every guarded UPDATE in
 * InventoryService is preceded by a `SELECT ... FOR UPDATE` on the same row, so
 * the guard can only fail if an invariant has already been violated. Throwing
 * rolls the caller's transaction back, which is the only safe outcome.
 */
export class ConcurrentModificationError extends Error {
  constructor(
    readonly entity:
      | 'reservation'
      | 'variant'
      | 'cart_item'
      | 'order'
      | 'payment',
    readonly id: number,
    readonly affected: number,
  ) {
    super(
      `${
        entity === 'reservation'
          ? InventoryMessages.RESERVATION_CONCURRENTLY_MODIFIED
          : entity === 'variant'
            ? InventoryMessages.STOCK_CONCURRENTLY_MODIFIED
            : InventoryMessages.CART_LINE_CONCURRENTLY_MODIFIED
      } (${entity} ${id}, affected=${affected})`,
    );
    this.name = 'ConcurrentModificationError';
  }
}

/**
 * Raised when a SELL path is asked to move units of a variant whose
 * authoritative, row-locked `product_variants.isActive` is false.
 *
 * THE RULE THIS ENFORCES
 * ----------------------
 * Raw physical availability remains visible for inventory management, but
 * `isActive = false` makes the variant unsellable through both Storefront and
 * POS -- regardless of physical stock, SKU lookup, cached UI state or a direct
 * API call.
 *
 * WHY IT IS A SEPARATE CLASS AND NOT `InsufficientStockError`. A retired
 * variant usually has plenty of stock; reporting "not enough stock" would be a
 * lie, and a till would show a quantity the cashier could see on the shelf.
 * The two conditions also have different remedies: stock is fixed by selling
 * less, this is fixed only by an administrator reactivating the SKU.
 *
 * WHY IT CARRIES ONLY `variantId` AND `sku`. Those are the two facts the till
 * already has on the line it is refusing, so echoing them lets the UI mark the
 * right row. No stock number, no reservation detail, no branch or cashier
 * attribution travels with the refusal.
 *
 * The thrower is always inside the caller's transaction and always AFTER the
 * `SELECT ... FOR UPDATE` that produced the value it read, so the answer cannot
 * be stale: see `InventoryService.assertSellableUnderLock`.
 */
export class VariantInactiveError extends Error {
  /**
   * THE stable machine-readable code for this refusal, defined once.
   *
   * Two HTTP surfaces answer with it -- `POST /orders/pos` and the basket
   * routes -- and a client branches on it rather than on the message. It lives
   * on the error class because that is the one thing both surfaces already
   * import; a second literal in either module could drift from this one
   * without anything failing to compile.
   */
  static readonly CODE = 'VARIANT_INACTIVE';

  constructor(
    readonly variantId: number,
    readonly sku: string | null,
  ) {
    super(`${InventoryMessages.VARIANT_INACTIVE} (variant ${variantId})`);
    this.name = 'VariantInactiveError';
  }
}

/**
 * ============================================================================
 * THE PRODUCT IS NOT OFFERED AT THIS BRANCH.
 *
 * Raised inside the POS sale transaction, under the same lock as every other
 * sellability decision, when the cashier's branch is not covered by the
 * product's `branchVisibility` (migration 0030).
 *
 * DELIBERATELY NOT `VariantInactiveError`. A variant withdrawn from one branch
 * may be active, in stock, and selling briskly at the branch next door —
 * reusing the inactive code would tell the cashier the product is
 * discontinued, which is false, and would make "retired everywhere" and "not
 * carried here" indistinguishable in exactly the case this feature exists to
 * separate.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CARRIES, AND WHAT IT MUST NEVER CARRY
 * ---------------------------------------------------------------------------
 * The fields below are all things the cashier's own request already named, or
 * that identify the line they are looking at. They let the till point at the
 * offending basket row.
 *
 * It must NEVER carry: another branch's visibility configuration (which would
 * tell a cashier what a different shop sells), the product's branch list, the
 * mode, another customer, a reservation, a stock number the till is not
 * already authorised to see, or any role data. `InventoryMessages`' header
 * rule — "none of these strings may ever be interpolated with staff identity,
 * branch identity, or another customer's data" — applies to this payload too.
 * ============================================================================
 */
export class ProductNotAvailableInBranchError extends Error {
  /**
   * THE stable machine-readable code, defined once on the class so the POS
   * client and the HTTP mapper cannot drift apart — the same reasoning as
   * `VariantInactiveError.CODE`.
   */
  static readonly CODE = 'PRODUCT_NOT_AVAILABLE_IN_BRANCH';

  constructor(
    readonly productId: number,
    readonly productCode: string | null,
    readonly variantId: number,
    readonly variantCode: string | null,
    readonly branchId: number,
  ) {
    super(
      `${InventoryMessages.PRODUCT_NOT_AVAILABLE_IN_BRANCH} ` +
        `(product ${productId}, variant ${variantId}, branch ${branchId})`,
    );
    this.name = 'ProductNotAvailableInBranchError';
  }
}
