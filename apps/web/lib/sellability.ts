/**
 * Is this product buyable right now, from the storefront's point of view?
 *
 * ## Why it is a function in `lib/` and not a ternary in the component
 *
 * The rule has a case that is easy to get wrong and impossible to see from the
 * happy path: a product with NO sellable variant at all. The public projection
 * omits retired variants entirely, so "every variant deactivated" arrives at
 * the client as `variants: []` — and a rule written as "is the SELECTED
 * variant out of stock?" answers `false` there, because nothing is selected.
 * That is how the detail page came to offer an enabled "افزودن به سبد" for the
 * one product that cannot be bought through any channel.
 *
 * It matters most immediately after a void or a return: those put physical
 * units back, so a retired variant can hold stock again — visible to inventory
 * management, sellable nowhere. The API refuses such a basket either way
 * (`VARIANT_INACTIVE`, or `PRODUCT_NOT_SELLABLE` when no variant resolves);
 * this is what stops the page from inviting the click. See
 * `apps/api/docs/ARCHITECTURE.md` §7.
 */
export function isProductSoldOut(input: {
  /** How many variants the PUBLIC projection returned. Retired ones are absent. */
  sellableVariantCount: number;
  /**
   * The selected variant's advisory `inStock`, or `null` when nothing is
   * selected or the server sent no availability for it.
   */
  selectedInStock: boolean | null;
}): boolean {
  if (input.sellableVariantCount === 0) return true;
  if (input.selectedInStock === null) return false;
  return !input.selectedInStock;
}
