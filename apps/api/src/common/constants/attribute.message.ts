export const AttributeMessages = {
  ATTRIBUTE_CREATED: 'Attribute created successfully',
  ATTRIBUTE_UPDATED: 'Attribute updated successfully',
  ATTRIBUTE_DELETED: 'Attribute deleted successfully',

  /**
   * PERSIAN, on purpose — read by a store manager, not by a developer. The
   * same sentence is produced by the application pre-check AND by
   * `translateCatalogueUniqueViolation` when `uq_product_attribute_name_norm`
   * catches a concurrent create, so the two paths look identical on screen.
   *
   * "با همین نام" is normalised: ک/ك and ی/ي fold together, ends are trimmed
   * and case is ignored (`src/common/catalogue/catalogue-uniqueness.ts`).
   */
  ATTRIBUTE_ALREADY_EXISTS: 'ویژگی‌ای با همین نام از قبل وجود دارد.',
  ATTRIBUTE_NOT_FOUND: 'Attribute not found',

  /**
   * PERSIAN, same reasoning. Note the scope stated in the sentence: the value
   * clashes WITHIN THIS ATTRIBUTE ("برای همین ویژگی"). The same word is
   * perfectly allowed under a different attribute — «قرمز» may belong to both
   * «رنگ» and «رنگ آستر» — and the message must not suggest otherwise.
   */
  ATTRIBUTE_SOME_VALUES_ALREADY_EXISTS:
    'یک یا چند مقدار از قبل برای همین ویژگی ثبت شده است.',

  ATTRIBUTE_USED_IN_VARIANTS:
    'Attribute is used in one or more product variants',

  ATTRIBUTE_VALUE_CREATED: 'Attribute value(s) created successfully',
  ATTRIBUTE_VALUE_UPDATED: 'Attribute value updated successfully',
  ATTRIBUTE_VALUE_DELETED: 'Attribute value deleted successfully',
  ATTRIBUTE_VALUE_NOT_FOUND: 'One or more attribute values not found',
  ATTRIBUTE_VALUE_USED_IN_VARIANTS:
    'This attribute value is used by one or more product variants',
} as const;

/**
 * Stable machine-readable codes for the attribute refusals.
 *
 * `GlobalExceptionFilter` promotes a payload's string `error` property to the
 * TOP level of the error envelope, so a client branches on `error` and never
 * on the human-readable `message`.
 */
export const AttributeErrorCodes = {
  /**
   * 409 — `product_attribute.name` is unique GLOBALLY, after normalisation.
   *
   * Two indexes can raise it: the baseline `UNIQUE ("name")` (exact bytes) and
   * `uq_product_attribute_name_norm` from migration 0025
   * (`catalogue_norm(name)`). Both map here, so the caller never has to know
   * which one PostgreSQL checked first.
   *
   * This is the code for the CREATE path too. It used to answer 400 there and
   * 409 from `renameAttribute` for the identical refusal; "this name is taken"
   * is a conflict wherever it is raised.
   */
  ATTRIBUTE_ALREADY_EXISTS: 'ATTRIBUTE_ALREADY_EXISTS',
  /**
   * 409 — the attribute (or the value) is still referenced by a variant.
   *
   * Refusal, not cascade: `variant_product_attribute_value` is `ON DELETE
   * CASCADE`, so an unguarded delete would silently strip the options off live
   * variants and leave SKUs that no longer say what they are.
   */
  ATTRIBUTE_IN_USE: 'ATTRIBUTE_IN_USE',
  /**
   * 409 — that value already exists on THIS attribute.
   *
   * WITHIN-ATTRIBUTE, never global: `uq_product_attribute_value_per_attribute_
   * norm` is a unique index on `("attributeId", catalogue_norm(value))`, so
   * «قرمز» can belong to «رنگ» and to «رنگ آستر» at the same time. The CREATE
   * path used to refuse a value that existed anywhere in the vocabulary; that
   * promise has been narrowed to this one (migration 0025 documents why).
   */
  ATTRIBUTE_VALUE_ALREADY_EXISTS: 'ATTRIBUTE_VALUE_ALREADY_EXISTS',
} as const;
