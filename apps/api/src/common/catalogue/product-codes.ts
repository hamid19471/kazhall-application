import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  ProductCodeErrorCodes,
  ProductCodeMessages,
} from 'src/common/constants/product-code.messages';

/**
 * ============================================================================
 * PRODUCT AND VARIANT BUSINESS CODES — «کد محصول» and «کد گونه».
 *
 * Migration 0031 (`1757000000031-ProductVariantCodes.ts`) creates the database
 * objects named here. This file is the single place the RULES are written
 * down, for exactly the reason `catalogue-uniqueness.ts` exists: the
 * application's normalisation and the database's CHECK/UNIQUE constraints must
 * not be able to drift. Anything the regexes below accept, the database
 * accepts; anything they reject, the database would reject too.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE ARE, AND WHAT THEY ARE NOT
 * ---------------------------------------------------------------------------
 * A code is a BUSINESS IDENTIFIER. It is printed on a receipt, read down a
 * telephone, typed into the POS search box and quoted in a supplier e-mail.
 * It is NOT the database id, and nothing may infer one from the other.
 *
 *   productCode   identifies a product FAMILY        e.g. KZ-P-000001
 *   variantCode   identifies ONE EXACT variant       e.g. KZ-P-000001-V000001
 *
 * `product_variants.sku` is UNTOUCHED by all of this. SKU is the warehouse's
 * own string, frequently supplied by a vendor, and the store already depends
 * on it; a code is the store's own identifier. Two separate things, two
 * columns, neither renamed into the other.
 *
 * CODES ARE STABLE AFTER ORDERS EXIST. `order_items` keeps its own SNAPSHOT of
 * both codes (migration 0032), so editing a catalogue row can never rewrite
 * what a historical receipt says. Changing a code is therefore permitted and
 * safe — it changes the catalogue, never the history.
 *
 * ---------------------------------------------------------------------------
 * THE RELATIONSHIP RULE — a variant code CONTAINS its parent
 * ---------------------------------------------------------------------------
 * `variantCode` must begin with `productCode` followed by a hyphen, and that is
 * enforced in TWO places that do different jobs.
 *
 *   APPLICATION — `assertVariantBelongsToProduct` refuses a mismatch with a
 *     field-specific 400 (`VARIANT_CODE_UNRELATED`) naming `variantCode`, so
 *     the Admin form can put the sentence beside the input that caused it.
 *     This is what makes the refusal actionable; it is NOT the guarantee.
 *
 *   DATABASE — migration 0033 installs a DEFERRABLE constraint trigger
 *     (`trg_variant_code_belongs_to_product`) on both `products` and
 *     `product_variants`. A variant code cannot be COMMITTED under an
 *     unrelated product code from any path at all: a direct `psql` UPDATE, a
 *     bulk import, or a future service method that forgets to validate.
 *
 * NOT A CHECK CONSTRAINT, because the rule spans two tables. Expressing it as
 * a CHECK would mean denormalising the parent's code onto every variant row,
 * and then the two copies could disagree — a worse failure than the one being
 * prevented.
 *
 * DEFERRABLE, because a rename is necessarily two statements — update the
 * parent, update the children — and whichever order you choose, the
 * intermediate state violates the rule. The check runs at COMMIT, so every
 * DURABLE state obeys it while the invisible middle of a transaction is
 * exempt. An IMMEDIATE trigger would make the correct operation impossible to
 * perform, which is how constraints end up dropped rather than obeyed.
 *
 * RENAMING A PRODUCT CODE CASCADES TO ITS VARIANTS, atomically.
 *
 * An earlier version of this file said the opposite — that a rename left the
 * children alone — and that was wrong: it left `KZ-P-000010-V000025` hanging
 * off a product now called `KZ-P-000020`, so the invariant this whole module
 * exists to state was false for every renamed product. The fear behind it
 * (rewriting rows orders reference) does not apply, because `order_items`
 * snapshots BOTH codes at sale time: history is already immune.
 *
 * The parent row and EVERY variant row are updated in ONE transaction, so the
 * pair is never observably inconsistent and a single conflict rolls the whole
 * rename back — the deferred trigger above is what makes that two-statement
 * update legal in the first place.
 *
 * The cascade replaces ONLY the parent prefix and preserves the
 * variant-specific suffix byte for byte — see {@link reprefixVariantCode}. No
 * suffix is regenerated and no sequence value is consumed for a variant that
 * already exists.
 *
 * HISTORICAL ORDER SNAPSHOTS ARE NOT TOUCHED. `order_items.productCodeSnapshot`
 * and `order_items.variantCodeSnapshot` (migration 0032) were frozen at sale
 * time, and nothing in the cascade reads or writes them. A renamed product
 * therefore moves in the catalogue while every past receipt and report keeps
 * saying exactly what it said before — which is the property that makes a code
 * safe to edit at all.
 *
 * ---------------------------------------------------------------------------
 * NORMALISATION — decided, not defaulted
 * ---------------------------------------------------------------------------
 * Applied in this order: TRIM → PERSIAN/ARABIC DIGITS → UPPERCASE.
 *
 *   TRIM the same character set `catalogue_norm()` trims (space, tab, CR, LF,
 *     FF, VT, NBSP U+00A0). NBSP is included because it is what a paste out of
 *     Word or a web page leaves behind, and it is invisible on screen.
 *
 *   PERSIAN ۰۱۲۳۴۵۶۷۸۹ (U+06F0..U+06F9) and ARABIC-INDIC ٠١٢٣٤٥٦٧٨٩
 *     (U+0660..U+0669) are NORMALISED TO ASCII, deliberately.
 *     The requirement permits rejecting them; normalising is the better
 *     answer for the same reason `catalogue_norm` folds ک/ك. A Persian
 *     keyboard layout produces «۱۲۳» for the digits the manager believes they
 *     typed, the glyphs are unmistakably digits to the person reading the
 *     screen, and refusing them teaches nothing actionable. They are converted
 *     once, here, and every comparison downstream is pure ASCII.
 *     A code is therefore stored ONLY in ASCII; «KZ-P-۰۰۰۰۰۱» and
 *     «KZ-P-000001» are the SAME code and the second one is a 409.
 *
 *   UPPERCASE Latin letters, so `kz-p-1` and `KZ-P-1` are one code.
 *
 * REJECTED, never repaired:
 *   • internal whitespace — «KZ P 1» is two tokens, and silently deleting the
 *     gap would invent a code the manager did not type;
 *   • any character outside A-Z 0-9 and hyphen, which includes every Persian
 *     LETTER. A code is scanned, spoken and typed on mixed keyboards; keeping
 *     it to unambiguous ASCII is what makes that work;
 *   • a leading or trailing hyphen, and a doubled hyphen — they make the
 *     product/variant boundary unreadable;
 *   • the empty string.
 *
 * ---------------------------------------------------------------------------
 * WHY BOTH APPLICATION VALIDATION AND DATABASE CONSTRAINTS
 * ---------------------------------------------------------------------------
 * Identical to the catalogue-uniqueness reasoning: the pre-check produces a
 * sentence naming the offending field, but SELECT-then-INSERT is a TOCTOU race
 * and two concurrent creates both pass it. `uq_products_product_code` and
 * `uq_product_variants_variant_code` are what make the duplicate impossible,
 * including across API instances, and `translateProductCodeUniqueViolation`
 * turns their 23505 into the SAME 409 so the loser of a race is told exactly
 * what the slow path would have told them.
 * ============================================================================
 */

/** Unique index on `products."productCode"`. */
export const UQ_PRODUCT_CODE = 'uq_products_product_code';

/** Unique index on `product_variants."variantCode"`. */
export const UQ_VARIANT_CODE = 'uq_product_variants_variant_code';

/** CHECK constraints mirroring {@link PRODUCT_CODE_PATTERN} in the database. */
export const CK_PRODUCT_CODE_FORMAT = 'ck_products_product_code_format';
export const CK_VARIANT_CODE_FORMAT = 'ck_product_variants_variant_code_format';

/** Sequences migration 0031 creates; see `ProductCodeAllocator`. */
export const PRODUCT_CODE_SEQUENCE = 'product_code_seq';
export const VARIANT_CODE_SEQUENCE = 'variant_code_seq';

/**
 * MAXIMUM LENGTHS, documented and enforced on both sides.
 *
 * Generated codes are 12 and 20 characters (`KZ-P-000001`,
 * `KZ-P-000001-V000001`). The limits are set well above that so a store can
 * adopt its own manual scheme, and low enough that a code still fits on a
 * receipt line and in the POS search box.
 */
export const PRODUCT_CODE_MAX_LENGTH = 32;
export const VARIANT_CODE_MAX_LENGTH = 64;

/**
 * The shape of a code, identical here and in the database CHECK constraints.
 *
 * Reads as: starts alphanumeric, ends alphanumeric, hyphens only ever appear
 * BETWEEN alphanumeric runs. That single expression rejects the empty string,
 * a leading hyphen, a trailing hyphen and `--` without four separate tests.
 */
const CODE_BODY = '[A-Z0-9]+(?:-[A-Z0-9]+)*';

export const PRODUCT_CODE_PATTERN = new RegExp(`^${CODE_BODY}$`);
export const VARIANT_CODE_PATTERN = new RegExp(`^${CODE_BODY}$`);

/** The SQL fragment migration 0031 uses, kept beside the regex it mirrors. */
export const CODE_SQL_PATTERN = '^[A-Z0-9]+(-[A-Z0-9]+)*$';

/** Exactly the characters `catalogue_norm()` passes to `btrim`. */
const TRIMMED = '[ \\t\\n\\r\\f\\v\\u00a0]';
const TRIM_PATTERN = new RegExp(`^${TRIMMED}+|${TRIMMED}+$`, 'g');

/** Any whitespace surviving the trim is INTERNAL, and is a rejection. */
const INTERNAL_WHITESPACE = /[\s\u00a0]/;

const PERSIAN_ZERO = 0x06f0;
const ARABIC_INDIC_ZERO = 0x0660;

/** ۰-۹ and ٠-٩ → 0-9. Every other codepoint is returned unchanged. */
function asciifyDigits(input: string): string {
  let out = '';
  for (const char of input) {
    const cp = char.codePointAt(0)!;
    if (cp >= PERSIAN_ZERO && cp <= PERSIAN_ZERO + 9) {
      out += String.fromCharCode(48 + (cp - PERSIAN_ZERO));
    } else if (cp >= ARABIC_INDIC_ZERO && cp <= ARABIC_INDIC_ZERO + 9) {
      out += String.fromCharCode(48 + (cp - ARABIC_INDIC_ZERO));
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * TRIM → ASCII digits → UPPERCASE.
 *
 * Pure and total: it never throws and never rejects. Deciding whether the
 * RESULT is acceptable is {@link assertProductCode} /
 * {@link assertVariantCode}, so a caller can normalise first and compare
 * without having to guard every call in a try/catch.
 */
export function normaliseCode(input: string): string {
  return asciifyDigits(input.replace(TRIM_PATTERN, '')).toUpperCase();
}

/** Which field a refusal is about, so the client can put it beside the input. */
export type CodeField = 'productCode' | 'variantCode';

function reject(
  field: CodeField,
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
): never {
  throw new BadRequestException({
    error,
    message,
    field,
    ...extra,
  });
}

/**
 * Normalise and validate one code, returning the CANONICAL form to store.
 *
 * Every rejection names the field, so the Admin form can render the sentence
 * next to the input the manager actually typed into rather than at the top of
 * the page.
 */
function normaliseAndAssert(
  raw: string | null | undefined,
  field: CodeField,
  maxLength: number,
  pattern: RegExp,
): string {
  if (raw === null || raw === undefined || raw === '') {
    reject(
      field,
      ProductCodeErrorCodes.CODE_REQUIRED,
      ProductCodeMessages[field].REQUIRED,
    );
  }

  if (typeof raw !== 'string') {
    reject(
      field,
      ProductCodeErrorCodes.CODE_INVALID,
      ProductCodeMessages[field].INVALID,
    );
  }

  const trimmed = raw.replace(TRIM_PATTERN, '');
  if (trimmed === '') {
    reject(
      field,
      ProductCodeErrorCodes.CODE_REQUIRED,
      ProductCodeMessages[field].REQUIRED,
    );
  }

  /*
   * Checked BEFORE uppercasing and BEFORE the pattern test, so «KZ P 1» is
   * told it contains a space rather than the vaguer "invalid characters".
   * The distinction matters: one is a typo the manager can see, the other
   * sends them hunting.
   */
  if (INTERNAL_WHITESPACE.test(trimmed)) {
    reject(
      field,
      ProductCodeErrorCodes.CODE_HAS_WHITESPACE,
      ProductCodeMessages[field].HAS_WHITESPACE,
    );
  }

  const normalised = asciifyDigits(trimmed).toUpperCase();

  if (normalised.length > maxLength) {
    reject(
      field,
      ProductCodeErrorCodes.CODE_TOO_LONG,
      ProductCodeMessages[field].TOO_LONG,
      { maxLength, length: normalised.length },
    );
  }

  if (!pattern.test(normalised)) {
    reject(
      field,
      ProductCodeErrorCodes.CODE_INVALID,
      ProductCodeMessages[field].INVALID,
    );
  }

  return normalised;
}

/** Canonical «کد محصول», or a 400 naming `productCode`. */
export function assertProductCode(raw: string | null | undefined): string {
  return normaliseAndAssert(
    raw,
    'productCode',
    PRODUCT_CODE_MAX_LENGTH,
    PRODUCT_CODE_PATTERN,
  );
}

/** Canonical «کد گونه», or a 400 naming `variantCode`. */
export function assertVariantCode(raw: string | null | undefined): string {
  return normaliseAndAssert(
    raw,
    'variantCode',
    VARIANT_CODE_MAX_LENGTH,
    VARIANT_CODE_PATTERN,
  );
}

/**
 * The relationship rule: `variantCode` must be `productCode` + '-' + something.
 *
 * Both arguments must ALREADY be canonical (run them through
 * `assertProductCode` / `assertVariantCode` first). Comparing raw input here
 * would let «kz-p-1» and «KZ-P-1-V1» look unrelated.
 */
export function assertVariantBelongsToProduct(
  variantCode: string,
  productCode: string,
): void {
  const prefix = `${productCode}-`;
  if (!variantCode.startsWith(prefix) || variantCode.length === prefix.length) {
    throw new BadRequestException({
      error: ProductCodeErrorCodes.VARIANT_CODE_UNRELATED,
      message: ProductCodeMessages.variantCode.UNRELATED,
      field: 'variantCode',
      productCode,
      variantCode,
    });
  }
}

/**
 * Rewrite one variant code onto a NEW parent, keeping its suffix exactly.
 *
 *   reprefixVariantCode('KZ-P-000010-V000025', 'KZ-P-000010', 'KZ-P-000020')
 *     -> 'KZ-P-000020-V000025'
 *
 * Both parents must already be canonical. The suffix is taken by OFFSET rather
 * than by splitting on a separator: a manual code may legitimately contain more
 * hyphens (`KZ-P-10-RED-XL`), and splitting would silently truncate it.
 *
 * THROWS when the variant does not currently belong to `oldProductCode`. That
 * is a refusal, not a repair: a variant carrying some unrelated string has no
 * derivable new code, and inventing one would put a business identifier on a
 * row that nobody chose. The caller surfaces it as a 409 naming the variant, so
 * an operator can fix the drifted row by hand and retry.
 */
export function reprefixVariantCode(
  variantCode: string,
  oldProductCode: string,
  newProductCode: string,
): string {
  const prefix = `${oldProductCode}-`;
  if (!variantCode.startsWith(prefix) || variantCode.length === prefix.length) {
    throw new ConflictException({
      error: ProductCodeErrorCodes.VARIANT_CODE_UNRELATED,
      message: ProductCodeMessages.variantCode.UNRELATED,
      field: 'variantCode',
      variantCode,
      productCode: oldProductCode,
    });
  }
  return `${newProductCode}-${variantCode.slice(prefix.length)}`;
}

/** `KZ-P-000001` — the generated product-code format. */
export function formatProductCode(sequenceValue: number | string): string {
  return `KZ-P-${String(sequenceValue).padStart(6, '0')}`;
}

/** `<productCode>-V000001` — the generated variant-code format. */
export function formatVariantCode(
  productCode: string,
  sequenceValue: number | string,
): string {
  return `${productCode}-V${String(sequenceValue).padStart(6, '0')}`;
}

const PG_UNIQUE_VIOLATION = '23505';
const PG_CHECK_VIOLATION = '23514';

interface PgIntegrityError {
  code?: string;
  constraint?: string;
  driverError?: { code?: string; constraint?: string };
}

/** Facts safe to echo back so the form can name what clashed. */
export interface ProductCodeConflictContext {
  productCode?: string;
  variantCode?: string;
}

/**
 * Map a PostgreSQL unique violation on one of the code indexes onto the SAME
 * stable 409 the service's pre-check throws.
 *
 * Returns `null` for anything else, so the caller rethrows the original and a
 * genuinely unexpected integrity error is never disguised as a duplicate code.
 *
 * NOTE what the payload does NOT carry: no id, no title, no branch
 * configuration, nothing about the product that already owns the code. The
 * person being refused learns that the value they typed is taken — which is
 * all they need in order to type a different one — and learns nothing about a
 * catalogue row they may not be allowed to see.
 */
export function translateProductCodeUniqueViolation(
  error: unknown,
  context: ProductCodeConflictContext = {},
): ConflictException | BadRequestException | null {
  const err = error as PgIntegrityError | undefined;
  const code = err?.driverError?.code ?? err?.code;
  const constraint = err?.driverError?.constraint ?? err?.constraint;

  if (code === PG_UNIQUE_VIOLATION) {
    switch (constraint) {
      case UQ_PRODUCT_CODE:
        return new ConflictException({
          error: ProductCodeErrorCodes.PRODUCT_CODE_TAKEN,
          message: ProductCodeMessages.productCode.TAKEN,
          field: 'productCode',
          ...(context.productCode !== undefined
            ? { productCode: context.productCode }
            : {}),
        });

      case UQ_VARIANT_CODE:
        return new ConflictException({
          error: ProductCodeErrorCodes.VARIANT_CODE_TAKEN,
          message: ProductCodeMessages.variantCode.TAKEN,
          field: 'variantCode',
          ...(context.variantCode !== undefined
            ? { variantCode: context.variantCode }
            : {}),
        });

      default:
        return null;
    }
  }

  /*
   * A CHECK violation here means application validation was bypassed — a
   * direct repository write, or a code path that forgot to normalise. Answer
   * the same 400 the validator would have, rather than a 500 that tells the
   * manager nothing.
   */
  if (code === PG_CHECK_VIOLATION) {
    if (constraint === CK_PRODUCT_CODE_FORMAT) {
      return new BadRequestException({
        error: ProductCodeErrorCodes.CODE_INVALID,
        message: ProductCodeMessages.productCode.INVALID,
        field: 'productCode',
      });
    }
    if (constraint === CK_VARIANT_CODE_FORMAT) {
      return new BadRequestException({
        error: ProductCodeErrorCodes.CODE_INVALID,
        message: ProductCodeMessages.variantCode.INVALID,
        field: 'variantCode',
      });
    }
  }

  return null;
}

/** `throw productCodeConflictOr(error, ctx)` — translated when ours, original otherwise. */
export function productCodeConflictOr(
  error: unknown,
  context: ProductCodeConflictContext = {},
): unknown {
  return translateProductCodeUniqueViolation(error, context) ?? error;
}
