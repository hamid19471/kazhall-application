/**
 * Persian sentences and stable codes for the simple-product opening quantity.
 *
 * PERSIAN, for the same load-bearing reason as the image messages: the Admin
 * console's `FormError` renders `message` verbatim and does no code lookup, so
 * whatever the API puts there is literally what a store manager reads while
 * trying to add a product.
 *
 * Both refusals here are about a request that contradicts itself or exceeds the
 * caller's authority, so each one says what would make it work rather than
 * merely what is wrong.
 */
export const InitialStockMessages = {
  /**
   * Deliberately explains WHY rather than just refusing. A caller who sent
   * both almost certainly believes the number applies to the whole product,
   * and needs to know the variants already carry their own.
   */
  WITH_VARIANTS:
    'موجودی اولیه فقط برای «محصول ساده» است. این محصول گونه دارد و موجودی هر گونه جداگانه ثبت می‌شود.',

  /**
   * The authorisation refusal. Says the one thing that unblocks the user —
   * create it with zero and ask somebody who can adjust inventory — instead of
   * naming a permission code they cannot grant themselves.
   */
  REQUIRES_INVENTORY_ADJUST:
    'برای ثبت موجودی اولیهٔ بیش از صفر، دسترسی «تغییر موجودی» لازم است. می‌توانید کالا را با موجودی صفر بسازید و سپس از بخش موجودی آن را تکمیل کنید.',

  /**
   * THE SENTENCE THE OWNER ASKED FOR, shown beside the quantity field in the
   * Admin form. Exported from here so the API and the form quote one string
   * and cannot drift into describing the number differently.
   */
  GLOBAL_QUANTITY_NOTICE:
    'این موجودی بین سایت و تمام شعب مجاز مشترک است و برای هر شعبه جداگانه محاسبه نمی‌شود.',
} as const;

/**
 * Stable machine-readable codes. `GlobalExceptionFilter` promotes a payload's
 * string `error` to the top level, so a client branches on these and never on
 * the sentence above.
 */
export const InitialStockErrorCodes = {
  /** 400 — `initialStock` sent together with explicit `variants`. */
  INITIAL_STOCK_WITH_VARIANTS: 'INITIAL_STOCK_WITH_VARIANTS',
  /** 403 — positive `initialStock` without `inventory.adjust`. */
  INITIAL_STOCK_REQUIRES_INVENTORY_ADJUST:
    'INITIAL_STOCK_REQUIRES_INVENTORY_ADJUST',
} as const;
