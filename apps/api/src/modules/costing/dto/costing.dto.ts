import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  Allow,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  NotEquals,
} from 'class-validator';

import { PaginationDto } from 'src/common/dto/pagination.dto';
import { MAX_STOCK_UNITS } from 'src/common/money/rial';

/**
 * Request bodies of `/admin/costing/*` (docs/PURCHASE-COST-ACCOUNTING.md §13).
 *
 * MONEY FIELDS ARE `@Allow()` AND NOTHING ELSE. `unitCost` and `totalValue`
 * are parsed by `parsePurchaseCost` / `parseCostTotal` in the service, not by
 * class-validator: the contract promises stable codes
 * (`PURCHASE_COST_INVALID`, `PURCHASE_COST_OUT_OF_RANGE`,
 * `PURCHASE_COST_REQUIRED`) that a generic validation 400 cannot carry, and
 * a decorator such as `@IsInt()` would also accept a JSON number above 2^53
 * that has already lost digits. The field is typed `unknown` so nothing
 * downstream can mistake the raw value for a parsed one.
 *
 * FREE TEXT IS TRIMMED BEFORE IT IS VALIDATED, so a string of spaces fails
 * the length bounds instead of becoming a permanent explanation on the ledger.
 */

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const MONEY_INPUT =
  'Integer Rial as a JSON integer or a base-10 integer string (e.g. 125000 or "125000"). ' +
  'No fractions, exponents, negatives or separators. 0 is a legitimate, explicit cost; ' +
  'omitting the field is NOT zero.';

export class RecordReceiptDto {
  @ApiProperty({ minimum: 1, maximum: MAX_STOCK_UNITS, example: 12 })
  @IsInt()
  @Min(1)
  @Max(MAX_STOCK_UNITS)
  quantity: number;

  @ApiProperty({
    oneOf: [{ type: 'integer' }, { type: 'string' }],
    example: '125000',
    description: `Unit purchase cost. ${MONEY_INPUT} 0..MAX_RIAL.`,
  })
  @Allow()
  unitCost?: unknown;

  @ApiPropertyOptional({
    maxLength: 120,
    example: 'INV-1405-0071',
    description:
      'The supplier invoice or delivery-note reference, stored on the ledger row.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  supplierReference?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class RecordCorrectionDto {
  @ApiProperty({
    example: -2,
    description:
      'Signed change to physical stock, never 0, |x| ≤ MAX_STOCK_UNITS. Positive: exactly one ' +
      'of `unitCost` / `costUnknown: true`. Negative: neither — the removed cost is the ' +
      'pool allocation (unknown-cost units first), reported as an inventory loss.',
  })
  @IsInt()
  @NotEquals(0)
  @Min(-MAX_STOCK_UNITS)
  @Max(MAX_STOCK_UNITS)
  quantityDelta: number;

  @ApiProperty({ minLength: 4, maxLength: 500, example: 'شمارش انبار، قفسه ۴' })
  @Transform(trim)
  @IsString()
  @MinLength(4)
  @MaxLength(500)
  reason: string;

  @ApiPropertyOptional({
    oneOf: [{ type: 'integer' }, { type: 'string' }],
    description: `Positive corrections only. ${MONEY_INPUT}`,
  })
  @Allow()
  unitCost?: unknown;

  @ApiPropertyOptional({
    description:
      'Positive corrections only: record the units as UNVALUED (their cost is unknown). ' +
      'Never the same as a cost of 0.',
  })
  @IsOptional()
  @IsBoolean()
  costUnknown?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  allowBelowReserved?: boolean;
}

export class InitialiseValuationDto {
  @ApiProperty({
    minimum: 0,
    maximum: MAX_STOCK_UNITS,
    example: 7,
    description:
      'The unvalued quantity the operator saw. A mismatch with the current count is ' +
      '409 INVENTORY_VALUATION_STALE.',
  })
  @IsInt()
  @Min(0)
  @Max(MAX_STOCK_UNITS)
  expectedUnvaluedQuantity: number;

  @ApiPropertyOptional({
    oneOf: [{ type: 'integer' }, { type: 'string' }],
    description: `Exactly one of unitCost / totalValue. ${MONEY_INPUT} 0..MAX_RIAL.`,
  })
  @Allow()
  unitCost?: unknown;

  @ApiPropertyOptional({
    oneOf: [{ type: 'integer' }, { type: 'string' }],
    description:
      `Exactly one of unitCost / totalValue. The value of ALL the unvalued units. ${MONEY_INPUT} ` +
      '0..9223372036854775807; above 2^53 send it as a string.',
  })
  @Allow()
  totalValue?: unknown;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class SetPurchasePriceDto {
  @ApiProperty({
    oneOf: [{ type: 'integer' }, { type: 'string' }],
    nullable: true,
    description: `The remembered purchase price, or null to clear it. ${MONEY_INPUT} 0..MAX_RIAL.`,
  })
  @Allow()
  unitCost?: unknown;
}

export class UnvaluedQueryDto extends PaginationDto {}
