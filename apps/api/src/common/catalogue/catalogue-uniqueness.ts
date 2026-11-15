import { ConflictException } from '@nestjs/common';
import {
  AttributeErrorCodes,
  AttributeMessages,
} from 'src/common/constants/attribute.message';
import {
  CategoryErrorCodes,
  CategoryMessages,
} from 'src/common/constants/categories.messages';

/**
 * ============================================================================
 * CATALOGUE UNIQUENESS — the single place the rules are written down.
 *
 * Migration 0025 (`1757000000025-CatalogueUniqueness.ts`) creates the database
 * objects named here. This file exists so the APPLICATION's duplicate
 * pre-check and the DATABASE's unique indexes cannot drift apart: both sides
 * compare through the SAME PostgreSQL function, `catalogue_norm()`.
 *
 * ---------------------------------------------------------------------------
 * SCOPE — what "the same" means, per thing
 * ---------------------------------------------------------------------------
 *   categories.title                 unique GLOBALLY.
 *       Categories are FLAT — `Category` has no parent column and no self
 *       relation — so there is no narrower scope available. Two categories
 *       reading the same to a shopper are two identical entries in the
 *       storefront nav.
 *
 *   product_attribute.name           unique GLOBALLY.
 *       An attribute is an AXIS ("رنگ", "سایز"). Two axes with the same name
 *       produce two pickers on the product form that nobody can tell apart.
 *
 *   product_attribute_value.value    unique WITHIN ONE ATTRIBUTE.
 *       NOT globally, deliberately: "قرمز" is a legitimate value of both
 *       "رنگ" and "رنگ آستر", and "کوچک" of both "سایز" and "ظرفیت". A global
 *       rule would make an existing axis unextendable for a reason the store
 *       manager can neither see nor fix.
 *
 * ---------------------------------------------------------------------------
 * NORMALISATION — decided, not defaulted (`catalogue_norm()`)
 * ---------------------------------------------------------------------------
 * Applied in this order: FOLD → TRIM → LOWER.
 *
 *   FOLD the Arabic/Persian look-alikes:
 *       ك U+0643 ARABIC KAF        →  ک U+06A9 PERSIAN KEHEH
 *       ي U+064A ARABIC YEH        →  ی U+06CC PERSIAN YEH
 *     YES, they are folded. A Persian store manager typing on an Arabic
 *     keyboard layout, or pasting from a supplier's price list, produces
 *     "كيف"; the same person on a Persian layout produces "کیف". The two
 *     strings are visually indistinguishable in every font the admin console
 *     uses. Letting both exist would put two identical-looking rows in the
 *     nav, and the manager would have no way to tell which one the products
 *     are in. So they COLLIDE: the second one is refused with a 409.
 *     («کیف» و «كيف» یک نام حساب می‌شوند.)
 *
 *   TRIM leading/trailing blanks (space, tab, CR, LF, FF, VT, NBSP U+00A0).
 *     NBSP is included because it is what a paste from Word or from a web page
 *     leaves behind, and it is invisible.
 *
 *   LOWER, so "Mobile" and "mobile" are one category. (A no-op for Persian
 *     letters, which have no case; it is there for the Latin titles the
 *     catalogue also carries.)
 *
 *   NOT folded, deliberately:
 *     • ZWNJ U+200C (نیم‌فاصله). "دسته‌بندی" and "دسته بندی" stay DIFFERENT.
 *       Folding it would require choosing between deleting it and turning it
 *       into a space, and the two choices disagree on real words. Half-space
 *       usage is an editorial decision, not an identity one.
 *     • Arabic-Indic vs Persian digits, alef hamza variants (أ إ آ), and
 *       ة/ه. None of them is the everyday keyboard accident that ک/ی is.
 *
 * ---------------------------------------------------------------------------
 * WHY BOTH A PRE-CHECK AND AN INDEX
 * ---------------------------------------------------------------------------
 * The pre-check (a SELECT through `catalogue_norm`) gives the manager a
 * sentence they can act on, and names the offending value. It CANNOT be the
 * guarantee: SELECT-then-INSERT is a TOCTOU race and two concurrent creates
 * both pass it. The unique index is what actually makes the duplicate
 * impossible — including across processes — and `translateCatalogueUnique
 * Violation` turns its 23505 into the SAME 409, with the same Persian
 * sentence, so the loser of the race is told what the slow path would have
 * told them.
 * ============================================================================
 */

/** The IMMUTABLE SQL function migration 0025 creates. Authoritative. */
export const CATALOGUE_NORM_FN = 'catalogue_norm';

/** Unique index on `lower(btrim(fold(categories.title)))`. */
export const UQ_CATEGORY_TITLE = 'uq_categories_title_norm';

/** Unique index on `lower(btrim(fold(product_attribute.name)))`. */
export const UQ_ATTRIBUTE_NAME = 'uq_product_attribute_name_norm';

/**
 * The BASELINE (migration 0001) `UNIQUE ("name")` on `product_attribute`.
 *
 * It is case- and variant-SENSITIVE, so it is strictly weaker than
 * `UQ_ATTRIBUTE_NAME` and is left in place (the entity still declares
 * `@Column({ unique: true })`). It is named here because PostgreSQL reports
 * whichever index it happened to check first: an exact-duplicate INSERT can
 * surface either constraint, and both must map to the same 409.
 */
export const UQ_ATTRIBUTE_NAME_EXACT = 'UQ_05d080e931ec850c1e0219ee111';

/** Unique index on `("attributeId", lower(btrim(fold(value))))`. */
export const UQ_ATTRIBUTE_VALUE =
  'uq_product_attribute_value_per_attribute_norm';

/** CHECK constraints that make a blank name unrepresentable. */
export const CK_CATEGORY_TITLE_NOT_BLANK = 'ck_categories_title_not_blank';
export const CK_ATTRIBUTE_NAME_NOT_BLANK =
  'ck_product_attribute_name_not_blank';
export const CK_ATTRIBUTE_VALUE_NOT_BLANK =
  'ck_product_attribute_value_not_blank';

const ARABIC_KAF = 'ك';
const PERSIAN_KEHEH = 'ک';
const ARABIC_YEH = 'ي';
const PERSIAN_YEH = 'ی';

/** Exactly the characters `catalogue_norm()` passes to `btrim`. */
const TRIMMED = '[ \\t\\n\\r\\f\\v\\u00a0]';
const TRIM_PATTERN = new RegExp(`^${TRIMMED}+|${TRIMMED}+$`, 'g');

/**
 * TypeScript MIRROR of `catalogue_norm()`.
 *
 * Used ONLY where there is no database round trip to lean on: de-duplicating
 * the values inside a single request payload, and answering "is this blank".
 * Every cross-ROW comparison goes through the SQL function instead
 * (`catalogueNormExpr`), because a mirror that drifts is worse than no mirror:
 * the app would refuse what the index allows, or allow what the index refuses
 * and answer 500.
 */
export function normaliseCatalogueTerm(input: string): string {
  return input
    .split(ARABIC_KAF)
    .join(PERSIAN_KEHEH)
    .split(ARABIC_YEH)
    .join(PERSIAN_YEH)
    .replace(TRIM_PATTERN, '')
    .toLowerCase();
}

/** True when the text carries no content the catalogue can show. */
export function isBlankCatalogueTerm(
  input: string | null | undefined,
): boolean {
  return !input || normaliseCatalogueTerm(input) === '';
}

/**
 * `catalogue_norm("alias"."column")` — the expression a pre-check must use on
 * BOTH sides of its comparison, so the app and the index agree by construction.
 */
export function catalogueNormExpr(column: string): string {
  return `${CATALOGUE_NORM_FN}(${column})`;
}

const PG_UNIQUE_VIOLATION = '23505';

interface PgIntegrityError {
  code?: string;
  constraint?: string;
  driverError?: { code?: string; constraint?: string };
}

/** Extra facts to attach to `details` so the client can name what clashed. */
export interface CatalogueConflictContext {
  title?: string;
  name?: string;
  attributeId?: number;
  values?: string[];
}

/**
 * Map a PostgreSQL unique violation raised by one of the catalogue indexes
 * onto the SAME stable 409 the application-level pre-check throws.
 *
 * Returns `null` for anything else — the caller rethrows the original, so a
 * genuinely unexpected integrity error is never disguised as a duplicate name.
 */
export function translateCatalogueUniqueViolation(
  error: unknown,
  context: CatalogueConflictContext = {},
): ConflictException | null {
  const err = error as PgIntegrityError | undefined;
  const code = err?.driverError?.code ?? err?.code;
  if (code !== PG_UNIQUE_VIOLATION) return null;

  const constraint = err?.driverError?.constraint ?? err?.constraint;

  switch (constraint) {
    case UQ_CATEGORY_TITLE:
      return new ConflictException({
        error: CategoryErrorCodes.CATEGORY_TITLE_TAKEN,
        message: CategoryMessages.CATEGORY_TITLE_TAKEN,
        ...(context.title !== undefined ? { title: context.title } : {}),
      });

    case UQ_ATTRIBUTE_NAME:
    case UQ_ATTRIBUTE_NAME_EXACT:
      return new ConflictException({
        error: AttributeErrorCodes.ATTRIBUTE_ALREADY_EXISTS,
        message: AttributeMessages.ATTRIBUTE_ALREADY_EXISTS,
        ...(context.name !== undefined ? { name: context.name } : {}),
      });

    case UQ_ATTRIBUTE_VALUE:
      return new ConflictException({
        error: AttributeErrorCodes.ATTRIBUTE_VALUE_ALREADY_EXISTS,
        message: AttributeMessages.ATTRIBUTE_SOME_VALUES_ALREADY_EXISTS,
        ...(context.attributeId !== undefined
          ? { attributeId: context.attributeId }
          : {}),
        ...(context.values !== undefined ? { values: context.values } : {}),
      });

    default:
      return null;
  }
}

/**
 * `throw catalogueConflictOr(error, ctx)` — the translated 409 when the error
 * is one of ours, the untouched original otherwise.
 */
export function catalogueConflictOr(
  error: unknown,
  context: CatalogueConflictContext = {},
): unknown {
  return translateCatalogueUniqueViolation(error, context) ?? error;
}
