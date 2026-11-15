export const CategoryMessages = {
  CATEGORY_CREATED: 'Category created successfully',
  CATEGORY_UPDATED: 'Category updated successfully',
  CATEGORY_DELETED: 'Category deleted successfully',

  CATEGORY_NOT_FOUND: 'Category not found',
  CATEGORY_HAS_PRODUCTS: 'This category has products and cannot be deleted',

  /**
   * PERSIAN, on purpose — this one is read by a store manager, not by a
   * developer. It is the sentence shown both when the application's pre-check
   * catches the duplicate and when the `uq_categories_title_norm` index
   * catches it in a race, so the two paths are indistinguishable to the person
   * looking at the screen.
   *
   * "با همین نام" covers more than an exact match: titles are compared with
   * ک/ك and ی/ي folded together, ends trimmed and case ignored (see
   * `src/common/catalogue/catalogue-uniqueness.ts`).
   */
  CATEGORY_TITLE_TAKEN: 'دسته‌ای با همین نام از قبل وجود دارد.',
} as const;

/**
 * Stable machine-readable codes for the category refusals.
 *
 * `GlobalExceptionFilter` promotes a payload's string `error` property to the
 * TOP level of the error envelope, so throwing
 *
 *   new ConflictException({ error: CategoryErrorCodes.CATEGORY_IN_USE, ... })
 *
 * yields `{ statusCode: 409, message, error: 'CATEGORY_IN_USE', details: {…} }`.
 * A client branches on `error`, never on the human-readable `message`.
 */
export const CategoryErrorCodes = {
  /**
   * 409 — a category with the same NORMALISED title already exists.
   *
   * ENFORCED IN THE DATABASE since migration 0025: `uq_categories_title_norm`
   * is a unique index on `catalogue_norm(title)` (ک/ك and ی/ي folded, trimmed,
   * lower-cased — see `src/common/catalogue/catalogue-uniqueness.ts`).
   *
   * The service still runs a pre-check first, because it can name the title
   * that clashed; but the pre-check is no longer the guarantee. Two concurrent
   * creates of the same title now end as exactly one 201 and one 409, and the
   * loser is given THIS code by `translateCatalogueUniqueViolation`, so a race
   * and an ordinary duplicate are indistinguishable to the client.
   */
  CATEGORY_TITLE_TAKEN: 'CATEGORY_TITLE_TAKEN',
  /** 409 — products are still attached, so deleting would orphan the nav. */
  CATEGORY_IN_USE: 'CATEGORY_IN_USE',
} as const;
