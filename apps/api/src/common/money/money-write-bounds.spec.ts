import { plainToInstance } from 'class-transformer';
import { validateSync, ValidationError } from 'class-validator';

import {
  MAX_LINE_QUANTITY,
  MAX_ORDER_LINES,
  MAX_ORDER_RIAL,
  MAX_RIAL,
  MAX_STOCK_UNITS,
  lineTotalRial,
  sumLineTotalsRial,
} from './rial';
import { bigIntTransformer } from '../transformers/bigint.transformer';
import { CreateProductDto } from 'src/modules/products/dto/create-product.dto';
import { CreateVariantDto } from 'src/modules/products/dto/create-variant.dto';
import { UpsertVariantDto } from 'src/modules/products/dto/upsert-variant.dto';
import { QueryProductsDto } from 'src/modules/products/dto/query-products.dto';
import { AdjustVariantStockDto } from 'src/modules/products/dto/adjust-stock.dto';
import { CreateCartItemDto } from 'src/modules/cart/dto/create-cart-item.dto';
import { UpdateCartItemDto } from 'src/modules/cart/dto/update-cart-item.dto';
import { CreatePosOrderDto } from 'src/modules/orders/dto/create-pos-order.dto';
import { CreatePosOrderItemDto } from 'src/modules/orders/dto/create-pos-order-item.dto';
import { PaymentMethodEnum } from 'src/modules/orders/enums/payment-method.enum';
import {
  ConfirmExternalRefundDto,
  MarkRefundRequiredDto,
} from 'src/modules/payment/dto/reconciliation-action.dto';
import { verifyGatewayAmount } from 'src/modules/payment/amount-verification';
import { PaymentReconciliationReason } from 'src/modules/payment/enums/payment-status-enum';

/**
 * ============================================================================
 * SAFE-INTEGER BOUNDARIES ON THE MONEY WRITE PATHS
 * ============================================================================
 *
 * WHAT THIS FILE IS FOR. Everything here is a PURE function of a payload or a
 * pair of numbers — a `class-validator` decorator set, a `ValueTransformer`, a
 * multiply, a fold — so a unit test is the honest place for it and every case
 * can be enumerated without a database. What is NOT here, because it cannot be
 * asserted without one, is that the framework actually answers 400 and that the
 * guarded arithmetic actually refuses a sale end to end; that is
 * test/integration/money-boundaries.int-spec.ts.
 *
 * THE PATTERN EVERY BOUND IS TESTED WITH is three cases, not one:
 *
 *   - EXACTLY AT the bound   -> accepted. A bound that is one too tight
 *                               silently makes a legitimate price unsellable,
 *                               and an off-by-one there is invisible in
 *                               production until someone lists an expensive
 *                               thing.
 *   - ONE ABOVE the bound    -> rejected, and rejected on THAT FIELD by NAME.
 *                               Asserting only "there were errors" would pass
 *                               even if an unrelated decorator fired.
 *   - THE VALUE IS UNCHANGED -> nothing clamps. A validator that quietly
 *                               substituted MAX_RIAL for what was sent would
 *                               satisfy every "rejected?" assertion above while
 *                               putting a price on the shelf nobody chose.
 * ============================================================================
 */

/** Field names that failed validation, so a case can name the one it means. */
function failedFields(errors: ValidationError[]): string[] {
  return errors.map((e) => e.property);
}

function validateDto<T extends object>(
  cls: new () => T,
  payload: Record<string, unknown>,
): ValidationError[] {
  return validateSync(plainToInstance(cls, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

// ---------------------------------------------------------------------------
// The derivation itself
// ---------------------------------------------------------------------------

describe('MAX_RIAL — the derivation, not the literal', () => {
  /*
   * THE WHOLE POINT OF THE BOUND, ASSERTED ARITHMETICALLY.
   *
   * A per-field ceiling of `Number.MAX_SAFE_INTEGER` is what this replaced, and
   * it is not sufficient: every field can be individually representable while
   * the ORDER TOTAL computed from them is not. So the property that has to hold
   * is about the PRODUCT of all three bounds, not about any one of them.
   */
  it('leaves the worst accepted order inside the safe integer range', () => {
    const worstOrder = MAX_RIAL * MAX_ORDER_LINES * MAX_LINE_QUANTITY;
    expect(worstOrder).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    // Computed in BigInt too, because the `*` above is exactly the arithmetic
    // under suspicion and must not be its own witness.
    expect(
      BigInt(MAX_RIAL) * BigInt(MAX_ORDER_LINES) * BigInt(MAX_LINE_QUANTITY),
    ).toBeLessThanOrEqual(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it('is the LARGEST such bound — one Rial more overflows', () => {
    // If this fails the bound has been made needlessly tight, which costs real
    // prices for no safety.
    expect(
      BigInt(MAX_RIAL + 1) *
        BigInt(MAX_ORDER_LINES) *
        BigInt(MAX_LINE_QUANTITY),
    ).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it('is derived from Number.MAX_SAFE_INTEGER, not written as a literal', () => {
    expect(MAX_RIAL).toBe(
      Math.floor(
        Number.MAX_SAFE_INTEGER / (MAX_ORDER_LINES * MAX_LINE_QUANTITY),
      ),
    );
    expect(MAX_ORDER_RIAL).toBe(MAX_RIAL * MAX_ORDER_LINES * MAX_LINE_QUANTITY);
    expect(Number.isSafeInteger(MAX_ORDER_RIAL)).toBe(true);
  });

  it('keeps a stock figure inside int4 even after a delta is added to it', () => {
    // `stock = stock + $value` is evaluated by PostgreSQL in int4. Two values
    // that each fit can overflow when added; half the ceiling is what makes
    // that impossible rather than merely unlikely.
    expect(MAX_STOCK_UNITS * 2).toBeLessThanOrEqual(2 ** 31 - 1);
  });
});

// ---------------------------------------------------------------------------
// MULTIPLICATION — one line, price x quantity
// ---------------------------------------------------------------------------

describe('lineTotalRial — the multiplication case', () => {
  it('returns the exact product at the worst accepted line', () => {
    expect(lineTotalRial(MAX_RIAL, MAX_LINE_QUANTITY)).toBe(
      Number(BigInt(MAX_RIAL) * BigInt(MAX_LINE_QUANTITY)),
    );
  });

  it('throws rather than returning a rounded product', () => {
    /*
     * THE FAILURE MODE, DEMONSTRATED FIRST. Both operands are safe integers and
     * both would pass any per-field `Number.isSafeInteger` check, yet `*`
     * returns a number that is not the product:
     */
    const price = 4_503_599_627_370_497; // 2^52 + 1
    const quantity = 3;
    expect(Number.isSafeInteger(price)).toBe(true);
    // The true product is 13 510 798 882 111 491 — ODD, and above 2^53 doubles
    // step in twos, so it has no representation and `*` returns its neighbour,
    // 13 510 798 882 111 492.
    //
    // COMPARED IN BigInt, NOT VIA `Number(exact)`. Narrowing the exact product
    // back to a double rounds it to the SAME wrong value, so the comparison
    // would pass trivially and prove nothing — which is the whole reason this
    // class of bug survives code review.
    expect(BigInt(price * quantity)).not.toEqual(
      BigInt(price) * BigInt(quantity),
    );

    expect(() => lineTotalRial(price, quantity)).toThrow(RangeError);
  });

  it('rejects an operand that has already been rounded', () => {
    expect(() => lineTotalRial(Number.MAX_SAFE_INTEGER + 1, 1)).toThrow(
      TypeError,
    );
    expect(() => lineTotalRial(1_000.5, 2)).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// AGGREGATION — many lines summed into a subtotal
// ---------------------------------------------------------------------------

describe('sumLineTotalsRial — the aggregation case', () => {
  it('sums the worst accepted order exactly', () => {
    const line = lineTotalRial(MAX_RIAL, MAX_LINE_QUANTITY);
    const subtotal = sumLineTotalsRial(
      Array<number>(MAX_ORDER_LINES).fill(line),
    );
    expect(subtotal).toBe(MAX_ORDER_RIAL);
    expect(Number.isSafeInteger(subtotal)).toBe(true);
  });

  it('throws on a subtotal that `+=` would silently round', () => {
    /*
     * Three lines that are each perfectly representable and whose sum is not.
     * This is the case a per-field bound cannot see: no single value is
     * suspicious, and the old `purchasable.reduce((s, i) => s + ...)` would
     * have returned a plausible wrong total and stored it as `orders.subtotal`.
     */
    const line = 4_000_000_000_000_000;
    expect(Number.isSafeInteger(line)).toBe(true);
    expect(() => sumLineTotalsRial([line, line, line])).toThrow(RangeError);
  });

  it('is empty-safe and returns 0 rather than NaN', () => {
    expect(sumLineTotalsRial([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// THE WRITE DIRECTION OF THE TRANSFORMER
// ---------------------------------------------------------------------------

describe('bigIntTransformer.to — the write guard', () => {
  const to = bigIntTransformer.to.bind(bigIntTransformer) as (
    v?: number | null,
  ) => number | null;

  it('passes the largest exactly representable amount through unchanged', () => {
    // The bound here is MAX_SAFE_INTEGER and NOT MAX_RIAL, because these
    // columns also hold order totals, which are legitimately much larger than
    // any single unit price.
    expect(to(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(to(MAX_ORDER_RIAL)).toBe(MAX_ORDER_RIAL);
    expect(to(0)).toBe(0);
  });

  it('throws one above the bound instead of storing a rounded figure', () => {
    // 2^53 is representable as a double but `Number.isSafeInteger` is false:
    // it is the first value whose neighbours collapse onto it.
    expect(() => to(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      /Number\.MAX_SAFE_INTEGER/,
    );
  });

  it('refuses a fractional Rial rather than truncating it', () => {
    // The old implementation was `Math.trunc(value)`: 1234.56 became 1234 and
    // the 0.56 vanished with no record. A fraction means the producer was
    // working in a different unit; that has to be decided where it arose.
    expect(() => to(1_234.56)).toThrow();
    expect(() => to(Number.NaN)).toThrow();
    expect(() => to(Number.POSITIVE_INFINITY)).toThrow();
  });

  it('still maps null and undefined to null', () => {
    expect(to(null)).toBeNull();
    expect(to(undefined)).toBeNull();
  });

  it('reads back the value it wrote, unchanged', () => {
    const from = bigIntTransformer.from.bind(bigIntTransformer) as (
      v?: string | number | null,
    ) => number | null;
    expect(from(String(to(MAX_ORDER_RIAL)))).toBe(MAX_ORDER_RIAL);
  });
});

// ---------------------------------------------------------------------------
// DTO BOUNDS — one describe per write path
// ---------------------------------------------------------------------------

describe('CreateProductDto.basePrice', () => {
  // `productCode` is REQUIRED since migration 0031; these cases are about the
  // money bound, so the code is a fixed valid literal rather than the subject.
  const base = { title: 't', description: 'd', productCode: 'KZ-P-000001' };

  it('accepts exactly MAX_RIAL', () => {
    expect(
      validateDto(CreateProductDto, { ...base, basePrice: MAX_RIAL }),
    ).toHaveLength(0);
  });

  it('rejects MAX_RIAL + 1 and names the field', () => {
    const errors = validateDto(CreateProductDto, {
      ...base,
      basePrice: MAX_RIAL + 1,
    });
    expect(failedFields(errors)).toContain('basePrice');
  });

  it('does not clamp the rejected value', () => {
    const dto = plainToInstance(CreateProductDto, {
      ...base,
      basePrice: MAX_RIAL + 1,
    });
    // Still what the caller sent. A clamp here would be a silent price change.
    expect(dto.basePrice).toBe(MAX_RIAL + 1);
  });

  it('rejects a negative price', () => {
    const errors = validateDto(CreateProductDto, { ...base, basePrice: -1 });
    expect(failedFields(errors)).toContain('basePrice');
  });
});

describe('CreateVariantDto.price and .stock', () => {
  const base = {
    sku: 'SKU',
    variantCode: 'KZ-P-000001-V000001',
    attributeValueIds: [1],
    stock: 1,
  };

  it('accepts price exactly MAX_RIAL and stock exactly MAX_STOCK_UNITS', () => {
    expect(
      validateDto(CreateVariantDto, {
        ...base,
        price: MAX_RIAL,
        stock: MAX_STOCK_UNITS,
      }),
    ).toHaveLength(0);
  });

  it('rejects price MAX_RIAL + 1', () => {
    expect(
      failedFields(
        validateDto(CreateVariantDto, { ...base, price: MAX_RIAL + 1 }),
      ),
    ).toContain('price');
  });

  it('rejects stock MAX_STOCK_UNITS + 1', () => {
    expect(
      failedFields(
        validateDto(CreateVariantDto, { ...base, stock: MAX_STOCK_UNITS + 1 }),
      ),
    ).toContain('stock');
  });
});

describe('UpsertVariantDto.price', () => {
  it('accepts exactly MAX_RIAL', () => {
    expect(validateDto(UpsertVariantDto, { price: MAX_RIAL })).toHaveLength(0);
  });

  it('rejects MAX_RIAL + 1', () => {
    expect(
      failedFields(validateDto(UpsertVariantDto, { price: MAX_RIAL + 1 })),
    ).toContain('price');
  });
});

describe('QueryProductsDto.minPrice / .maxPrice', () => {
  /*
   * A READ path, bounded anyway. `@Type(() => Number)` turns the query STRING
   * into a number, so `?minPrice=1e30` arrives as a finite non-integer and
   * `?minPrice=99999999999999999999` as a rounded double — either way a value
   * the price columns can never hold would be sent into a `bigint` comparison.
   */
  it('accepts exactly MAX_RIAL on both ends', () => {
    expect(
      validateDto(QueryProductsDto, {
        minPrice: String(MAX_RIAL),
        maxPrice: String(MAX_RIAL),
      }),
    ).toHaveLength(0);
  });

  it('rejects MAX_RIAL + 1 on either end', () => {
    expect(
      failedFields(
        validateDto(QueryProductsDto, { minPrice: String(MAX_RIAL + 1) }),
      ),
    ).toContain('minPrice');
    expect(
      failedFields(
        validateDto(QueryProductsDto, { maxPrice: String(MAX_RIAL + 1) }),
      ),
    ).toContain('maxPrice');
  });
});

describe('quantity fields', () => {
  it('accepts exactly MAX_LINE_QUANTITY everywhere it appears', () => {
    expect(
      validateDto(CreatePosOrderItemDto, {
        productVariantId: 1,
        quantity: MAX_LINE_QUANTITY,
      }),
    ).toHaveLength(0);
    expect(
      validateDto(CreateCartItemDto, {
        productId: 1,
        variantId: 1,
        quantity: MAX_LINE_QUANTITY,
      }),
    ).toHaveLength(0);
    expect(
      validateDto(UpdateCartItemDto, { quantity: MAX_LINE_QUANTITY }),
    ).toHaveLength(0);
  });

  it('rejects MAX_LINE_QUANTITY + 1 everywhere it appears', () => {
    // All three must agree: an absolute PATCH that skipped the ceiling would
    // let a line added at the maximum be raised past it afterwards.
    expect(
      failedFields(
        validateDto(CreatePosOrderItemDto, {
          productVariantId: 1,
          quantity: MAX_LINE_QUANTITY + 1,
        }),
      ),
    ).toContain('quantity');
    expect(
      failedFields(
        validateDto(CreateCartItemDto, {
          productId: 1,
          variantId: 1,
          quantity: MAX_LINE_QUANTITY + 1,
        }),
      ),
    ).toContain('quantity');
    expect(
      failedFields(
        validateDto(UpdateCartItemDto, { quantity: MAX_LINE_QUANTITY + 1 }),
      ),
    ).toContain('quantity');
  });
});

describe('CreatePosOrderDto.items — the line-count half of the bound', () => {
  const item = { productVariantId: 1, quantity: 1 };
  const body = (n: number) => ({
    paymentMethod: PaymentMethodEnum.CASH,
    items: Array.from({ length: n }, () => ({ ...item })),
  });

  it('accepts exactly MAX_ORDER_LINES entries', () => {
    expect(validateDto(CreatePosOrderDto, body(MAX_ORDER_LINES))).toHaveLength(
      0,
    );
  });

  it('rejects MAX_ORDER_LINES + 1 entries', () => {
    // Without this, MAX_RIAL is unsound: its divisor assumed this cap.
    expect(
      failedFields(validateDto(CreatePosOrderDto, body(MAX_ORDER_LINES + 1))),
    ).toContain('items');
  });
});

describe('reconciliation amounts', () => {
  const reason = { reason: 'operator confirmed by phone' };

  it('accepts exactly MAX_ORDER_RIAL', () => {
    // An AGGREGATE figure, so bounded by the order ceiling rather than the
    // unit-price one — a refund on a large order is legitimate.
    expect(
      validateDto(MarkRefundRequiredDto, {
        ...reason,
        expectedAmount: MAX_ORDER_RIAL,
      }),
    ).toHaveLength(0);
    expect(
      validateDto(ConfirmExternalRefundDto, {
        ...reason,
        paymentId: 1,
        amount: MAX_ORDER_RIAL,
        externalReference: 'ZBL-1',
      }),
    ).toHaveLength(0);
  });

  it('rejects MAX_ORDER_RIAL + 1', () => {
    expect(
      failedFields(
        validateDto(MarkRefundRequiredDto, {
          ...reason,
          expectedAmount: MAX_ORDER_RIAL + 1,
        }),
      ),
    ).toContain('expectedAmount');
    expect(
      failedFields(
        validateDto(ConfirmExternalRefundDto, {
          ...reason,
          paymentId: 1,
          amount: MAX_ORDER_RIAL + 1,
          externalReference: 'ZBL-1',
        }),
      ),
    ).toContain('amount');
  });
});

describe('AdjustVariantStockDto.value', () => {
  it('accepts the bound in both directions', () => {
    expect(
      validateDto(AdjustVariantStockDto, {
        mode: 'delta',
        value: MAX_STOCK_UNITS,
      }),
    ).toHaveLength(0);
    expect(
      validateDto(AdjustVariantStockDto, {
        mode: 'delta',
        value: -MAX_STOCK_UNITS,
      }),
    ).toHaveLength(0);
  });

  it('rejects one beyond it in both directions', () => {
    expect(
      failedFields(
        validateDto(AdjustVariantStockDto, {
          mode: 'delta',
          value: MAX_STOCK_UNITS + 1,
        }),
      ),
    ).toContain('value');
    expect(
      failedFields(
        validateDto(AdjustVariantStockDto, {
          mode: 'delta',
          value: -MAX_STOCK_UNITS - 1,
        }),
      ),
    ).toContain('value');
  });
});

// ---------------------------------------------------------------------------
// THE GATEWAY SIDE — a receipt amount is a write path too
// ---------------------------------------------------------------------------

describe('verifyGatewayAmount — safe-integer discipline', () => {
  it('verifies an ordinary matching amount', () => {
    expect(verifyGatewayAmount('1000000', 1_000_000)).toMatchObject({
      verified: true,
      reason: null,
      gatewayAmount: 1_000_000,
    });
  });

  it('treats an unsafe gateway figure as UNUSABLE, not as a mismatch', () => {
    /*
     * The old check was `isFinite && isInteger`, which passes 2^53 + 2. That
     * number is not what the gateway said — it is what the JSON parser rounded
     * the gateway's figure TO — and it was being written verbatim into
     * `payment.gateway_amount` as the permanent record.
     */
    const unsafe = Number.MAX_SAFE_INTEGER + 3;
    expect(Number.isInteger(unsafe)).toBe(true);
    expect(Number.isSafeInteger(unsafe)).toBe(false);

    const result = verifyGatewayAmount(String(unsafe), unsafe);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe(PaymentReconciliationReason.AMOUNT_INVALID);
    // Nothing rounded is stored; the verbatim text is kept as the evidence.
    expect(result.gatewayAmount).toBeNull();
    expect(result.gatewayAmountRaw).toBe(String(unsafe));
  });

  it('no longer VERIFIES a one-Rial underpayment above 2^53', () => {
    /*
     * THE EXACT INPUT THE OLD CODE ANSWERED `verified: true` ON.
     *
     * We asked for 9 007 199 254 740 993 Rial. The gateway reported
     * 9 007 199 254 740 992 — one Rial less. The old implementation did
     * `Number(expected)`, which is itself 9 007 199 254 740 992, and
     * `isFinite && isInteger` accepted the reported figure, so the two compared
     * EQUAL and the receipt settled: stock consumed, goods shipped, one Rial
     * short and no reconciliation row to say so.
     *
     * It is now refused as AMOUNT_INVALID rather than AMOUNT_MISMATCH, and that
     * is the honest classification: 2^53 is the first magnitude at which the
     * gateway's figure can no longer be stated as a `number` at all, so we do
     * not actually know it differed — only that it is unusable. Either way it
     * does not settle.
     */
    const ours = '9007199254740993';
    const theirs = 9_007_199_254_740_992;
    expect(Number(ours)).toBe(theirs); // the lost digit, demonstrated
    expect(Number.isSafeInteger(theirs)).toBe(false);

    const result = verifyGatewayAmount(ours, theirs);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe(PaymentReconciliationReason.AMOUNT_INVALID);
    expect(result.gatewayAmount).toBeNull();
  });

  it('compares OUR figure exactly, never through Number()', () => {
    /*
     * Same oversized `expected`, but a gateway figure that IS safe, so step 2
     * passes and the comparison in step 4 is what decides. `toRialBigInt` keeps
     * all seventeen digits; `Number(expected)` would have dropped the last one
     * before the comparison ever happened.
     */
    const result = verifyGatewayAmount('9007199254740993', 1_000_000);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe(PaymentReconciliationReason.AMOUNT_MISMATCH);
    expect(result.gatewayAmount).toBe(1_000_000);
  });

  it('still reports a missing amount as missing, not as equal', () => {
    expect(verifyGatewayAmount('100', null)).toMatchObject({
      verified: false,
      reason: PaymentReconciliationReason.AMOUNT_MISSING,
    });
  });
});
