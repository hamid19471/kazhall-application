export const CartMessages = {
  CART_ITEM_ADDED: 'Product added to cart successfully',
  CART_ITEM_UPDATED: 'Cart item updated successfully',
  CART_ITEM_REMOVED: 'Product removed from cart successfully',
  CART_ITEM_NOT_FOUND: 'Product not found in cart',
  QUANTITY_MUST_BE_POSITIVE: 'Quantity must be greater than zero',
  VARIANT_REQUIRED_FOR_PRODUCT:
    'This product is sold by variant; select a variant',
  VARIANT_NOT_PART_OF_PRODUCT:
    'The selected variant does not belong to this product',
  /**
   * Every sellable product has at least one ACTIVE variant -- a simple product
   * has a DEFAULT one (migration 0012). A product with none has been fully
   * retired, so there is nothing to reserve and nothing to sell. This is NOT
   * "out of stock": a 0-stock variant is still sellable-in-principle and is
   * shown in the catalog as out of stock.
   */
  PRODUCT_NOT_SELLABLE: 'This product is not currently available for sale',
  CART_WRITE_CONFLICT:
    'Your basket was being changed at the same time; please retry',
} as const;

/**
 * Customer-facing explanations for a basket line that changed without the
 * customer asking.
 *
 * PRIVACY (acceptance test 21): these strings state WHAT happened and never
 * WHO caused it. No staff name, no staff id, no branch, no other customer's
 * basket may ever appear in a cart response.
 */
export const CartChangeMessages = {
  /**
   * The product was withdrawn from the WEBSITE («نمایش در وب‌سایت» off).
   *
   * ENGLISH and developer-facing, like every other string in this map — the
   * Persian copy the customer reads lives in `apps/web/lib/labels.ts`. The
   * wording is careful not to claim the item is discontinued: it may be
   * perfectly active and selling over the counter, and only the SITE channel
   * has been closed.
   */
  channel_unavailable:
    'This product is no longer offered on the website and cannot be ordered here',
  sold_in_store:
    'Some of these units were sold in one of our stores before you checked out',
  reservation_expired:
    'Your 4-hour hold on these units expired and they were returned to stock',
  /**
   * Migration 0013 only. The line predates the uniform sellable-SKU model: it
   * named no variant, so it never held a reservation, and the default variant
   * it was repointed at starts at stock 0 because nobody had ever counted the
   * product. Fabricating a hold would have handed out units that do not exist,
   * so the line is soft-removed and explained instead.
   */
  stock_not_counted:
    'This product is now tracked as a stock-keeping unit. We have no counted stock for it yet, so we could not keep it in your basket — please add it again once it is back in stock',
  /**
   * DERIVED per read from the variant's current `isActive`, never stored — see
   * `CartLineChangeReason.NOT_SELLABLE`.
   *
   * It says the line cannot be ordered and asks for it to be removed. It does
   * NOT say the line was removed (nothing removes it: the hold is intact and
   * the units are still held), and it does NOT invite the customer to add the
   * item again, because `assertSellableUnderLock` refuses that with
   * `VARIANT_INACTIVE`.
   */
  not_sellable:
    'This item is no longer available for sale, so it cannot be ordered. Please remove it from your basket to continue',
} as const;

export const CartStockMessages = {
  notEnough: (available: number, requested: number) =>
    `Not enough stock: requested ${requested}, available ${available}`,
} as const;
