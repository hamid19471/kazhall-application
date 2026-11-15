/**
 * Persian sentences for the «کد محصول» / «کد گونه» refusals.
 *
 * PERSIAN, on purpose — every one of these is read by a store manager standing
 * in front of the product form, not by a developer reading a log. They are the
 * sentences shown BOTH when the application's validation catches the problem
 * and when a database constraint catches it in a race, so the two paths are
 * indistinguishable to the person looking at the screen.
 *
 * Keyed by FIELD first (`productCode` / `variantCode`) so a caller that
 * already knows which input it is validating cannot accidentally show the
 * wrong noun — «کد محصول» where it meant «کد گونه» sends the manager to edit
 * the wrong box.
 */
export const ProductCodeMessages = {
  productCode: {
    REQUIRED: 'کد محصول الزامی است.',
    INVALID:
      'کد محصول فقط می‌تواند شامل حروف انگلیسی، ارقام و خط تیره باشد و نباید با خط تیره شروع یا تمام شود.',
    HAS_WHITESPACE: 'کد محصول نباید فاصله داشته باشد.',
    TOO_LONG: 'کد محصول طولانی‌تر از حد مجاز است.',
    /**
     * Deliberately says nothing about WHICH product holds the code. The person
     * being refused needs to know the value is taken so they can choose
     * another; telling them the title of a product they may have no permission
     * to see would leak catalogue data through an error message.
     */
    TAKEN: 'محصول دیگری با همین کد وجود دارد.',
  },
  variantCode: {
    REQUIRED: 'کد گونه الزامی است.',
    INVALID:
      'کد گونه فقط می‌تواند شامل حروف انگلیسی، ارقام و خط تیره باشد و نباید با خط تیره شروع یا تمام شود.',
    HAS_WHITESPACE: 'کد گونه نباید فاصله داشته باشد.',
    TOO_LONG: 'کد گونه طولانی‌تر از حد مجاز است.',
    TAKEN: 'گونه دیگری با همین کد وجود دارد.',
    /**
     * The relationship rule, stated as an instruction rather than a complaint:
     * a variant code must begin with its product's code.
     */
    UNRELATED:
      'کد گونه باید با کد محصول والد شروع شود؛ مثلاً برای محصول KZ-P-000001 کدی مانند KZ-P-000001-V000001.',
  },
  /** Shown when variant-code generation is asked for before a product code exists. */
  PRODUCT_CODE_REQUIRED_FIRST:
    'ابتدا کد محصول را وارد یا تولید کنید، سپس کد گونه را بسازید.',
} as const;

/**
 * Stable machine-readable codes for the business-code refusals.
 *
 * `GlobalExceptionFilter` promotes a payload's string `error` property to the
 * TOP level of the error envelope, so throwing
 *
 *   new ConflictException({ error: ProductCodeErrorCodes.PRODUCT_CODE_TAKEN, … })
 *
 * yields `{ statusCode: 409, message, error: 'PRODUCT_CODE_TAKEN', details }`.
 * A client branches on `error`, never on the human-readable `message`.
 *
 * Every payload carries `details.field`, which is the whole point: the Admin
 * form puts the sentence next to the input that caused it.
 */
export const ProductCodeErrorCodes = {
  /** 400 — the field was absent, empty, or whitespace only. */
  CODE_REQUIRED: 'CODE_REQUIRED',
  /** 400 — characters outside A-Z 0-9 '-', or a leading/trailing/doubled hyphen. */
  CODE_INVALID: 'CODE_INVALID',
  /** 400 — whitespace INSIDE the code; never silently deleted. */
  CODE_HAS_WHITESPACE: 'CODE_HAS_WHITESPACE',
  /** 400 — longer than the documented maximum for that field. */
  CODE_TOO_LONG: 'CODE_TOO_LONG',
  /** 400 — the variant code does not begin with its parent product's code. */
  VARIANT_CODE_UNRELATED: 'VARIANT_CODE_UNRELATED',

  /**
   * 409 — another product already holds this code.
   *
   * ENFORCED IN THE DATABASE by `uq_products_product_code` (migration 0031).
   * The service pre-checks first so it can name the value that clashed, but
   * the pre-check is not the guarantee: two concurrent creates of the same
   * manual code end as exactly one success and one 409, and the loser is given
   * THIS code by `translateProductCodeUniqueViolation`, so a race and an
   * ordinary duplicate are indistinguishable to the client.
   */
  PRODUCT_CODE_TAKEN: 'PRODUCT_CODE_TAKEN',
  /** 409 — another variant already holds this code (`uq_product_variants_variant_code`). */
  VARIANT_CODE_TAKEN: 'VARIANT_CODE_TAKEN',
} as const;
