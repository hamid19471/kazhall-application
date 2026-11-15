/**
 * Customer-facing strings for the ONLINE checkout boundary.
 *
 * Kept out of `order.messages.ts` deliberately: that file is the POS/order
 * admin vocabulary, and checkout is the one place where the customer — not a
 * cashier — is the audience. Mixing them is how a message written for an
 * operator ends up on a shopper's screen.
 *
 * PRIVACY. Exactly like `CartChangeMessages`, these say WHAT happened and never
 * WHO caused it. "Some units were sold in one of our stores" is allowed; the
 * branch, the cashier and any other customer's basket are not.
 */
export const CheckoutMessages = {
  /** ENGLISH, developer-facing; the storefront renders its own Persian copy. */
  CHANNEL_UNAVAILABLE:
    'One or more items are no longer offered on the website. Remove them from the basket to continue.',
  BASKET_EMPTY:
    'Your basket is empty. Add something to it before checking out.',

  /**
   * Every active line lost its hold before checkout could run — the whole
   * basket evaporated underneath the customer. Distinct from BASKET_EMPTY
   * because the customer DID have items and deserves to be told why they went.
   */
  BASKET_NO_LONGER_AVAILABLE:
    'None of the items in your basket are still available. Your basket has been updated.',

  CONTENTS_CHANGED:
    'Your basket changed before this order could be placed. Review the changes and confirm to continue.',

  PRICE_CHANGED:
    'The price of one or more items changed before this order could be placed. Review the new total and confirm to continue.',

  /**
   * No quote presented. This is the ordinary FIRST step of checkout, not an
   * error state: the customer has to be shown exactly what they are buying, and
   * at what price, before an order can be placed. The response carries a fresh
   * quote to show them.
   */
  QUOTE_REQUIRED:
    'Review your order before it is placed. Confirm the items and total shown to continue.',

  /**
   * Deliberately ONE message for expired, malformed, unsigned, tampered and
   * belonging-to-another-customer. Distinguishing them would tell a prober
   * whether a captured token was genuine; the precise reason is in the server
   * log instead.
   */
  QUOTE_INVALID:
    'This order confirmation is no longer valid. Review the items and total shown and confirm again to continue.',

  /**
   * The quote is authentic, unexpired and the customer's own — but the basket
   * it priced is not the basket that exists now.
   */
  QUOTE_STALE:
    'Your basket changed after you reviewed it. Review the updated items and total and confirm again to continue.',

  /**
   * A TRANSIENT race inside a single request, not a change the customer needs
   * to approve: a basket line for a SKU we had not locked appeared between the
   * discovery read and the locked read, so its price could not be read
   * authoritatively. Nothing is decided and nothing is charged.
   *
   * The client should simply request a new quote and retry. It gets its own
   * code because the recovery is different from every other 409 — there is no
   * diff to show a customer, and there is no quote in the response, because a
   * basket we could not price cannot be quoted.
   */
  RETRY_REQUIRED:
    'We could not confirm your basket just now. Please try again.',

  /**
   * A line whose SKU can no longer be sold — in practice, a variant an
   * administrator deactivated while it sat in this basket.
   *
   * IT IS REACHABLE, and the wording had to change with it. This used to read
   * "It has been removed from your basket", which was written when the only
   * way to reach this kind was a pre-sellable-SKU row that failed loudly at
   * checkout. Nothing removes the line now: deactivating a variant releases no
   * reservation and touches no quantity, so the units are still held and still
   * in the basket — they simply cannot be bought. Telling a customer the line
   * was removed while it is visibly still there is worse than saying nothing.
   *
   * It also deliberately does NOT invite the customer to add the item again:
   * `InventoryService.assertSellableUnderLock` refuses that with
   * `409 VARIANT_INACTIVE`, so "try again later" would be a dead end.
   */
  LINE_NOT_SELLABLE:
    'This item is no longer available for sale, so it cannot be ordered. Remove it from your basket to continue.',

  IDEMPOTENCY_KEY_REQUIRED:
    'An Idempotency-Key header is required so a retried checkout cannot place two orders. Your app should generate one per checkout attempt and reuse it on every retry.',

  IDEMPOTENCY_KEY_MALFORMED:
    'Idempotency-Key must be 8 to 200 printable ASCII characters with no whitespace.',
} as const;

/** Machine-readable discriminator on a 409 from the checkout endpoint. */
export enum CheckoutConflictCode {
  /**
   * 409 — one or more basket lines are no longer offered on the WEBSITE.
   *
   * The only unsellable condition with no inventory gate behind it, so
   * `checkout()` refuses it explicitly rather than letting the order through
   * with a diff attached. `retryable: false`: only an administrator
   * republishing the product changes the answer.
   *
   * Lowercase snake, matching its siblings: these are refusals about the
   * checkout HANDSHAKE, not about the world.
   */
  CHANNEL_UNAVAILABLE = 'channel_unavailable',
  /** Quantities and/or lines changed. `changes` explains each one. */
  CONTENTS_CHANGED = 'checkout_contents_changed',
  /** Only the money moved. */
  PRICE_CHANGED = 'checkout_price_changed',
  /**
   * No quote was presented. Ordinary first step: the response carries one.
   * A client that treats this as a hard error has skipped the review step.
   */
  QUOTE_REQUIRED = 'checkout_quote_required',
  /**
   * Expired, malformed, tampered, or issued to a different customer — one code
   * for all four, on purpose (see CheckoutMessages.QUOTE_INVALID).
   */
  QUOTE_INVALID = 'checkout_quote_invalid',
  /** Authentic quote, but the priced basket no longer matches. */
  QUOTE_STALE = 'checkout_quote_stale',
  /**
   * Transient in-request race (a SKU appeared after the lock set was chosen).
   * Retry with a new quote. Carries NO `quote` and NO `changes` — see
   * CheckoutMessages.RETRY_REQUIRED.
   */
  RETRY_REQUIRED = 'checkout_retry_required',
}

/** Why a single basket line is different from what the customer last saw. */
export enum CheckoutChangeKind {
  /** Units were taken by an in-store sale (POS priority). */
  SOLD_IN_STORE = 'sold_in_store',
  /** The 4-hour hold ran out. */
  RESERVATION_EXPIRED = 'reservation_expired',
  /** The line has no sellable SKU behind it any more. */
  NOT_SELLABLE = 'not_sellable',
  /**
   * The product was withdrawn from the WEBSITE (migration 0030).
   *
   * Deliberately the same string as `CartLineChangeReason.CHANNEL_UNAVAILABLE`,
   * so the basket screen and the checkout diff name one condition one way —
   * exactly the convention `NOT_SELLABLE` already follows.
   */
  CHANNEL_UNAVAILABLE = 'channel_unavailable',
  /** Same units, different money. */
  PRICE_CHANGED = 'price_changed',
  /** A line the quote did not contain is now in the basket. */
  LINE_ADDED = 'line_added',
  /** Same SKU and price, different quantity. */
  QUANTITY_CHANGED = 'quantity_changed',
  /**
   * The basket total differs from the quoted total.
   *
   * Reported ALONGSIDE the per-line changes rather than instead of them: a
   * basket can change materially while the total does not move at all (swap one
   * SKU for another at the same price, or halve one line and double another),
   * and a customer shown only "the total is the same" has been told nothing.
   */
  TOTAL_CHANGED = 'total_changed',
  /**
   * The line predates the sellable-SKU model and never had a reservation, so
   * migration 0013 could not carry it forward. Distinct from
   * RESERVATION_EXPIRED because telling the customer a hold expired when none
   * ever existed is simply a false statement.
   */
  STOCK_NOT_COUNTED = 'stock_not_counted',
}
