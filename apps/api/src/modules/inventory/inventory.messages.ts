/**
 * Messages owned by workstream D (inventory core).
 *
 * These are deliberately kept in the inventory module rather than in
 * `src/common/constants` because `common/constants` only has two D-owned
 * files (cart.messages.ts, payment.messages.ts) and adding a third would
 * collide with another workstream.
 *
 * PRIVACY: none of these strings may ever be interpolated with staff
 * identity, branch identity, or another customer's data. A customer is told
 * *that* their line changed and *why*, never *who* caused it.
 */
export const InventoryMessages = {
  VARIANT_NOT_FOUND: 'Product variant not found',
  VARIANT_IDS_REQUIRED: 'At least one variant id is required',
  QUANTITY_MUST_BE_POSITIVE: 'Quantity must be greater than zero',
  DUPLICATE_VARIANT_IN_REQUEST:
    'The same variant appears more than once; aggregate quantities before calling',
  RESERVATION_CONCURRENTLY_MODIFIED:
    'Reservation was modified concurrently; the operation was rolled back',
  STOCK_CONCURRENTLY_MODIFIED:
    'Stock was modified concurrently; the operation was rolled back',
  CART_LINE_CONCURRENTLY_MODIFIED:
    'Basket line was modified concurrently; the operation was rolled back',
  NEGATIVE_STOCK_REJECTED: 'Physical stock may never be negative',
  /**
   * THE ONE SELLABILITY RULE, in the words the API says out loud.
   *
   * Raw physical availability remains visible for inventory management, but
   * `isActive = false` makes the variant unsellable through both Storefront
   * and POS. Nothing about a retired variant's stock, reservations or
   * allocations is hidden from an administrator; it simply cannot be sold.
   */
  VARIANT_INACTIVE:
    'This variant is deactivated and cannot be sold; it remains visible for inventory management only',
  /**
   * The POS refusal for a product the cashier's branch does not carry.
   *
   * Says NOTHING about which branches do carry it — that is another shop's
   * configuration and is not the till's business.
   */
  PRODUCT_NOT_AVAILABLE_IN_BRANCH:
    'This product is not offered at this branch and cannot be sold here',
  ORDER_NOT_FOUND: 'Order not found',
  ORDER_ITEM_WITHOUT_VARIANT:
    'Order contains a line without a product variant and cannot be fulfilled from stock',
} as const;

/** Customer-visible explanation for a basket line that changed underneath them. */
export const BasketChangeExplanation = {
  sold_in_store:
    'Some of these units were sold in store before you checked out',
  reservation_expired: 'Your 4-hour hold on these units expired',
} as const;
