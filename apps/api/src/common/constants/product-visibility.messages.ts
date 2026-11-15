/**
 * Persian sentences for «محل عرضه محصول» — the channel/branch visibility
 * refusals.
 *
 * PERSIAN, on purpose: every one of these is read by a store manager standing
 * in front of the product form. They name the CONTROL that is wrong, so the
 * Admin UI can put each sentence beside the field that caused it rather than
 * at the top of the page.
 *
 * PRIVACY. None of these may ever name another product, another branch's
 * configuration, or a role. A refusal says what the operator must change and
 * nothing about catalogue rows they may not be allowed to see.
 */
export const ProductVisibilityMessages = {
  SITE_FLAG_INVALID: 'وضعیت نمایش در وب‌سایت باید مشخص باشد.',
  BRANCH_MODE_INVALID:
    'حالت نمایش در شعب باید یکی از «هیچ شعبه‌ای»، «همه شعب» یا «شعب منتخب» باشد.',
  BRANCH_ID_INVALID: 'شناسهٔ شعبه معتبر نیست.',

  /**
   * An empty selection under «شعب منتخب» is a real mistake, not an edge case:
   * on screen it reads as a deliberate choice while behaving exactly like
   * «هیچ شعبه‌ای». The database refuses it too (a deferrable constraint
   * trigger), so this sentence and that trigger say the same thing.
   */
  BRANCHES_REQUIRED:
    'برای حالت «شعب منتخب» باید دست‌کم یک شعبه انتخاب شود؛ در غیر این صورت «هیچ شعبه‌ای» را انتخاب کنید.',

  /**
   * Branch ids sent alongside «هیچ شعبه‌ای» or «همه شعب» are refused rather
   * than dropped. Accepting them would persist a configuration the operator
   * never saw: the mode would win and their chosen branches would vanish
   * without a word.
   */
  BRANCHES_NOT_ALLOWED_FOR_MODE:
    'فهرست شعب فقط در حالت «شعب منتخب» معنا دارد. ابتدا حالت را به «شعب منتخب» تغییر دهید.',

  /**
   * Unknown and deactivated branches are ONE message on purpose. From the
   * operator's side they are the same problem — "this branch cannot be
   * chosen" — and separating them would let a caller probe which branch ids
   * exist by watching which refusal comes back.
   */
  BRANCHES_UNUSABLE:
    'یک یا چند شعبهٔ انتخاب‌شده در دسترس نیستند (ناشناخته یا غیرفعال). فهرست شعب را تازه کنید و دوباره انتخاب کنید.',

  /**
   * The authorization refusal. Deliberately explicit that BOTH widening and
   * narrowing are covered: unpublishing looks harmless because it removes
   * reach rather than granting it, but it takes a product off the storefront
   * and out of every till, which is the same commercial blast radius.
   */
  VISIBILITY_FORBIDDEN:
    'تغییر «محل عرضه محصول» فقط از عهدهٔ مدیر ارشد برمی‌آید. این محدودیت شامل انتشار، لغو انتشار و تغییر فهرست شعب می‌شود.',

  /**
   * Shown beside the visibility section for a delegated editor, and repeated in
   * the Admin UI next to the branch picker. NOT an error — a statement of the
   * domain boundary, because "my branch is selected, so my branch has its own
   * stock" is the most likely wrong inference from this whole feature.
   */
  STOCK_IS_GLOBAL_NOTICE:
    'موجودی کالا سراسری است و به تفکیک شعبه نگهداری نمی‌شود. انتخاب شعبه فقط تعیین می‌کند کالا کجا قابل عرضه باشد؛ همهٔ شعب از یک موجودی واحد می‌فروشند.',

  /** The storefront-side refusal, shown on the basket and at checkout. */
  CHANNEL_UNAVAILABLE:
    'این کالا دیگر در وب‌سایت عرضه نمی‌شود و ثبت سفارش آن ممکن نیست؛ برای ادامه، آن را از سبد بردارید.',
} as const;

/**
 * Stable machine-readable codes. `GlobalExceptionFilter` promotes a payload's
 * string `error` to the top level, so a client branches on `error` and never
 * on the human-readable `message`.
 */
export const ProductVisibilityErrorCodes = {
  /** 400 — a malformed flag, mode or branch id. */
  VISIBILITY_INVALID: 'VISIBILITY_INVALID',
  /** 400 — mode is `selected` with no branches. */
  BRANCHES_REQUIRED: 'BRANCHES_REQUIRED',
  /** 400 — branch ids supplied under a mode that has no use for them. */
  BRANCHES_NOT_ALLOWED_FOR_MODE: 'BRANCHES_NOT_ALLOWED_FOR_MODE',
  /** 400 — branch ids that are unknown, or inactive and newly selected. */
  BRANCHES_UNUSABLE: 'BRANCHES_UNUSABLE',
  /** 403 — the actor is not `super_admin`. */
  VISIBILITY_FORBIDDEN: 'VISIBILITY_FORBIDDEN',
} as const;

/**
 * THE STOREFRONT SELLABILITY REASON.
 *
 * Deliberately NOT `variant_inactive`, and the distinction is load-bearing:
 * a variant withdrawn from the WEBSITE may still be perfectly active and
 * selling briskly in the shops. Reusing `variant_inactive` would tell a
 * customer the product is discontinued, tell the POS the same thing, and make
 * the two channels indistinguishable in exactly the case this feature exists
 * to separate.
 *
 * Nor is it reused for the POS refusal — see `PRODUCT_NOT_AVAILABLE_IN_BRANCH`
 * in `inventory.errors.ts`. One condition per channel, one name each.
 *
 * Lowercase snake to match `CartLineChangeReason` and `CheckoutChangeKind`,
 * which are statements about the basket handshake, rather than the
 * SCREAMING_SNAKE of `InventoryConflictCode`, which are refusals about the
 * world. See `orders.service.ts:127-139` for that convention.
 */
export const CHANNEL_UNAVAILABLE_REASON = 'channel_unavailable' as const;
