import { BadRequestException, ConflictException } from '@nestjs/common';

import {
  CK_PRODUCT_CODE_FORMAT,
  CK_VARIANT_CODE_FORMAT,
  CODE_SQL_PATTERN,
  PRODUCT_CODE_MAX_LENGTH,
  PRODUCT_CODE_PATTERN,
  UQ_PRODUCT_CODE,
  UQ_VARIANT_CODE,
  VARIANT_CODE_MAX_LENGTH,
  assertProductCode,
  assertVariantBelongsToProduct,
  assertVariantCode,
  formatProductCode,
  formatVariantCode,
  normaliseCode,
  translateProductCodeUniqueViolation,
} from './product-codes';
import { ProductCodeErrorCodes } from 'src/common/constants/product-code.messages';

/**
 * Pull the structured payload out of a Nest HttpException.
 *
 * THE PAYLOAD IS FLAT, and that is deliberate. `GlobalExceptionFilter`
 * promotes `error` and `message` to the top level of the response and collects
 * EVERY OTHER KEY into `details` — so a thrower that nests its own `details`
 * object ends up emitting `details.details.field`, which is what the HTTP
 * contract test caught. Throwing `{ error, message, field }` is what produces
 * the `details.field` the Admin form reads.
 */
function payload(error: unknown): {
  error: string;
  message: string;
  field?: string;
  [k: string]: unknown;
} {
  return (error as BadRequestException).getResponse() as ReturnType<
    typeof payload
  >;
}

/** Run `fn`, return the thrown error. Fails the test if nothing is thrown. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw, but it returned normally');
}

describe('normaliseCode', () => {
  it('trims the same characters catalogue_norm trims, including NBSP', () => {
    expect(normaliseCode('  KZ-P-1  ')).toBe('KZ-P-1');
    expect(normaliseCode(' KZ-P-1 ')).toBe('KZ-P-1');
    expect(normaliseCode('\t\r\n\fKZ-P-1\f\n\r\t')).toBe('KZ-P-1');
  });

  it('uppercases Latin letters', () => {
    expect(normaliseCode('kz-p-000001')).toBe('KZ-P-000001');
  });

  it('normalises Persian digits to ASCII', () => {
    expect(normaliseCode('KZ-P-۰۰۰۰۰۱')).toBe('KZ-P-000001');
  });

  it('normalises Arabic-Indic digits to ASCII', () => {
    expect(normaliseCode('KZ-P-٠٠٠٠٠١')).toBe('KZ-P-000001');
  });

  it('makes a Persian-digit code and its ASCII twin the SAME code', () => {
    // This is what turns the second one into a 409 rather than a second row.
    expect(normaliseCode('KZ-P-۱۲۳')).toBe(normaliseCode('kz-p-123'));
  });

  it('is total — it never throws, even on input it would later reject', () => {
    expect(() => normaliseCode('')).not.toThrow();
    expect(() => normaliseCode('  ')).not.toThrow();
    expect(() => normaliseCode('سلام')).not.toThrow();
  });
});

describe('assertProductCode', () => {
  it('returns the canonical form', () => {
    expect(assertProductCode('  kz-p-000001 ')).toBe('KZ-P-000001');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['NBSP only', ' '],
  ])('rejects %s as CODE_REQUIRED', (_label, input) => {
    const error = thrown(() => assertProductCode(input as string | null));
    expect(error).toBeInstanceOf(BadRequestException);
    expect(payload(error).error).toBe(ProductCodeErrorCodes.CODE_REQUIRED);
    expect(payload(error).field).toBe('productCode');
  });

  it('rejects internal whitespace distinctly from invalid characters', () => {
    const error = thrown(() => assertProductCode('KZ P 1'));
    expect(payload(error).error).toBe(
      ProductCodeErrorCodes.CODE_HAS_WHITESPACE,
    );
  });

  it.each([
    ['Persian letters', 'کد-۱'],
    ['underscore', 'KZ_P_1'],
    ['dot', 'KZ.P.1'],
    ['slash', 'KZ/P/1'],
    ['leading hyphen', '-KZ-P-1'],
    ['trailing hyphen', 'KZ-P-1-'],
    ['doubled hyphen', 'KZ--P-1'],
    ['only a hyphen', '-'],
  ])('rejects %s as CODE_INVALID', (_label, input) => {
    const error = thrown(() => assertProductCode(input));
    expect(payload(error).error).toBe(ProductCodeErrorCodes.CODE_INVALID);
    expect(payload(error).field).toBe('productCode');
  });

  it('rejects a code longer than the documented maximum, naming the limit', () => {
    const tooLong = 'A'.repeat(PRODUCT_CODE_MAX_LENGTH + 1);
    const error = thrown(() => assertProductCode(tooLong));
    expect(payload(error).error).toBe(ProductCodeErrorCodes.CODE_TOO_LONG);
    expect(payload(error).maxLength).toBe(PRODUCT_CODE_MAX_LENGTH);
    expect(payload(error).length).toBe(PRODUCT_CODE_MAX_LENGTH + 1);
  });

  it('accepts a code exactly at the maximum length', () => {
    const atLimit = 'A'.repeat(PRODUCT_CODE_MAX_LENGTH);
    expect(assertProductCode(atLimit)).toBe(atLimit);
  });

  it('accepts a plain manual code with no hyphens at all', () => {
    expect(assertProductCode('ABC123')).toBe('ABC123');
  });
});

describe('assertVariantCode', () => {
  it('returns the canonical form and names variantCode on refusal', () => {
    expect(assertVariantCode(' kz-p-1-v1 ')).toBe('KZ-P-1-V1');
    const error = thrown(() => assertVariantCode('KZ P 1'));
    expect(payload(error).field).toBe('variantCode');
  });

  it('allows a longer maximum than a product code', () => {
    const atLimit = 'A'.repeat(VARIANT_CODE_MAX_LENGTH);
    expect(VARIANT_CODE_MAX_LENGTH).toBeGreaterThan(PRODUCT_CODE_MAX_LENGTH);
    expect(assertVariantCode(atLimit)).toBe(atLimit);
  });
});

describe('assertVariantBelongsToProduct', () => {
  it('accepts a variant code prefixed by its parent product code', () => {
    expect(() =>
      assertVariantBelongsToProduct('KZ-P-000001-V000001', 'KZ-P-000001'),
    ).not.toThrow();
  });

  it('rejects an unrelated variant code', () => {
    const error = thrown(() =>
      assertVariantBelongsToProduct('KZ-P-000002-V000001', 'KZ-P-000001'),
    );
    expect(payload(error).error).toBe(
      ProductCodeErrorCodes.VARIANT_CODE_UNRELATED,
    );
    expect(payload(error).field).toBe('variantCode');
  });

  it('rejects a variant code EQUAL to the product code', () => {
    const error = thrown(() =>
      assertVariantBelongsToProduct('KZ-P-000001', 'KZ-P-000001'),
    );
    expect(payload(error).error).toBe(
      ProductCodeErrorCodes.VARIANT_CODE_UNRELATED,
    );
  });

  it('rejects the parent code followed by nothing but a hyphen', () => {
    // `KZ-P-1-` never survives assertVariantCode, but the relationship check
    // must not depend on that having run first.
    const error = thrown(() =>
      assertVariantBelongsToProduct('KZ-P-000001-', 'KZ-P-000001'),
    );
    expect(payload(error).error).toBe(
      ProductCodeErrorCodes.VARIANT_CODE_UNRELATED,
    );
  });

  it('rejects a PREFIX collision that is not a real parent', () => {
    // `KZ-P-1` is a string-prefix of `KZ-P-10-V1`, but it is not its parent.
    // The required hyphen boundary is what makes this a rejection.
    const error = thrown(() =>
      assertVariantBelongsToProduct('KZ-P-10-V1', 'KZ-P-1'),
    );
    expect(payload(error).error).toBe(
      ProductCodeErrorCodes.VARIANT_CODE_UNRELATED,
    );
  });
});

describe('generated formats', () => {
  it('pads product codes to six digits', () => {
    expect(formatProductCode(1)).toBe('KZ-P-000001');
    expect(formatProductCode(123456)).toBe('KZ-P-123456');
  });

  it('does not truncate once the sequence passes six digits', () => {
    expect(formatProductCode(1234567)).toBe('KZ-P-1234567');
  });

  it('builds variant codes from the parent code', () => {
    expect(formatVariantCode('KZ-P-000001', 1)).toBe('KZ-P-000001-V000001');
  });

  it('produces codes that pass their own validators', () => {
    const product = formatProductCode(42);
    const variant = formatVariantCode(product, 7);
    expect(assertProductCode(product)).toBe(product);
    expect(assertVariantCode(variant)).toBe(variant);
    expect(() => assertVariantBelongsToProduct(variant, product)).not.toThrow();
  });

  it('produces codes inside the documented length limits', () => {
    const product = formatProductCode(999999);
    const variant = formatVariantCode(product, 999999);
    expect(product.length).toBeLessThanOrEqual(PRODUCT_CODE_MAX_LENGTH);
    expect(variant.length).toBeLessThanOrEqual(VARIANT_CODE_MAX_LENGTH);
  });
});

describe('the TypeScript pattern and the SQL CHECK pattern agree', () => {
  // The database constraint is written from CODE_SQL_PATTERN. If these two
  // ever diverge the app would accept what the database refuses (a 500) or
  // refuse what it accepts (an unreachable row).
  const sql = new RegExp(CODE_SQL_PATTERN);

  it.each(['KZ-P-000001', 'KZ-P-000001-V000001', 'ABC123', 'A', 'A-B'])(
    'both accept %s',
    (value) => {
      expect(PRODUCT_CODE_PATTERN.test(value)).toBe(true);
      expect(sql.test(value)).toBe(true);
    },
  );

  it.each(['', '-A', 'A-', 'A--B', 'a', 'A B', 'A_B', 'کد'])(
    'both reject %s',
    (value) => {
      expect(PRODUCT_CODE_PATTERN.test(value)).toBe(false);
      expect(sql.test(value)).toBe(false);
    },
  );
});

describe('translateProductCodeUniqueViolation', () => {
  const uniqueViolation = (constraint: string) => ({
    driverError: { code: '23505', constraint },
  });
  const checkViolation = (constraint: string) => ({
    driverError: { code: '23514', constraint },
  });

  it('maps the product-code unique index to a 409 naming the field', () => {
    const result = translateProductCodeUniqueViolation(
      uniqueViolation(UQ_PRODUCT_CODE),
      { productCode: 'KZ-P-000001' },
    );
    expect(result).toBeInstanceOf(ConflictException);
    expect(payload(result).error).toBe(
      ProductCodeErrorCodes.PRODUCT_CODE_TAKEN,
    );
    expect(payload(result).field).toBe('productCode');
    expect(payload(result).productCode).toBe('KZ-P-000001');
  });

  it('maps the variant-code unique index to a 409 naming the field', () => {
    const result = translateProductCodeUniqueViolation(
      uniqueViolation(UQ_VARIANT_CODE),
      { variantCode: 'KZ-P-000001-V000001' },
    );
    expect(result).toBeInstanceOf(ConflictException);
    expect(payload(result).error).toBe(
      ProductCodeErrorCodes.VARIANT_CODE_TAKEN,
    );
  });

  it('leaks nothing beyond the field and the value that was typed', () => {
    const result = translateProductCodeUniqueViolation(
      uniqueViolation(UQ_PRODUCT_CODE),
      { productCode: 'KZ-P-000001' },
    );
    // Exactly two safe keys beside `error` and `message`, which the filter
    // promotes. Nothing about the product that already holds the code.
    expect(
      Object.keys(payload(result))
        .filter((k) => k !== 'error' && k !== 'message')
        .sort(),
    ).toEqual(['field', 'productCode']);
  });

  it('maps a CHECK violation to the same 400 the validator would have given', () => {
    const result = translateProductCodeUniqueViolation(
      checkViolation(CK_PRODUCT_CODE_FORMAT),
    );
    expect(result).toBeInstanceOf(BadRequestException);
    expect(payload(result).error).toBe(ProductCodeErrorCodes.CODE_INVALID);

    const variant = translateProductCodeUniqueViolation(
      checkViolation(CK_VARIANT_CODE_FORMAT),
    );
    expect(payload(variant).field).toBe('variantCode');
  });

  it('reads the error code off a bare pg error as well as a driverError', () => {
    const result = translateProductCodeUniqueViolation({
      code: '23505',
      constraint: UQ_PRODUCT_CODE,
    });
    expect(result).toBeInstanceOf(ConflictException);
  });

  it('returns null for an unrelated constraint, so the caller rethrows', () => {
    expect(
      translateProductCodeUniqueViolation(uniqueViolation('uq_something_else')),
    ).toBeNull();
  });

  it('returns null for a non-integrity error', () => {
    expect(translateProductCodeUniqueViolation(new Error('boom'))).toBeNull();
    expect(translateProductCodeUniqueViolation(undefined)).toBeNull();
  });
});
