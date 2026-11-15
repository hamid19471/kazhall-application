import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { MAX_STOCK_UNITS } from 'src/common/money/rial';

export enum StockAdjustModeDto {
  /** `value` becomes the new absolute physical stock. */
  SET = 'set',
  /** `value` is added to the current physical stock (may be negative). */
  DELTA = 'delta',
}

/**
 * POST /products/variants/:variantId/stock/adjust   (superAdmin)
 *
 * Delegates to `IInventoryService.adjustStock`, which performs the change
 * under a row lock inside the caller's transaction and writes a
 * `stock_movements` row, carrying `reason` as `reasonText` on that row.
 *
 * RESERVATION AWARENESS. Physical stock is not the same thing as sellable
 * stock: part of it may be held by baskets (`basketReserved`) or by created
 * orders awaiting payment (`orderAllocated`). An adjustment that would drop
 * physical stock below `basketReserved + orderAllocated` is REJECTED with 409,
 * and the error body reports both numbers so the admin can see what they would
 * have broken. Passing `allowBelowReserved: true` performs it anyway -- which
 * is a legitimate operation after e.g. discovering shrinkage, and is why the
 * escape hatch exists rather than the rule being absolute.
 *
 * The response always reports `basketReserved` and `orderAllocated`.
 */
export class AdjustVariantStockDto {
  @ApiProperty({ enum: StockAdjustModeDto, example: StockAdjustModeDto.DELTA })
  @IsEnum(StockAdjustModeDto)
  mode: StockAdjustModeDto;

  /**
   * SYMMETRIC BOUNDS because `mode=delta` is legitimately negative (shrinkage,
   * a correction after a count). `MAX_STOCK_UNITS` is half the PostgreSQL int4
   * ceiling precisely so that `stock = stock + $value` — evaluated by
   * PostgreSQL, not by JavaScript — cannot overflow int4 whatever the current
   * stock is. An int4 overflow there arrives as an unactionable driver error;
   * this is the same refusal, stated as a 400 with the field named.
   */
  @ApiProperty({
    example: -3,
    description:
      'For mode=set: the new absolute stock (must be >= 0). For mode=delta: ' +
      `the signed change. Magnitude at most ${MAX_STOCK_UNITS}.`,
    minimum: -MAX_STOCK_UNITS,
    maximum: MAX_STOCK_UNITS,
  })
  @IsInt({ message: 'value must be an integer' })
  @Min(-MAX_STOCK_UNITS, {
    message: `value must not be below ${-MAX_STOCK_UNITS} units`,
  })
  @Max(MAX_STOCK_UNITS, {
    message: `value must not exceed ${MAX_STOCK_UNITS} units`,
  })
  value: number;

  @ApiPropertyOptional({
    example: 'stock count correction 2026-09-09',
    description:
      'Free-text reason, PERSISTED on the movement as ' +
      '`stock_movements.reasonText` (migration 0024) beside the machine ' +
      '`reason` enum. OPTIONAL here — unlike on the admin console route, ' +
      'where it is mandatory — but if present it must contain something: ' +
      'the value is trimmed first, so a string of spaces is refused rather ' +
      'than stored as a blank explanation. Omit the field entirely to record ' +
      'no explanation.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({
    example: false,
    default: false,
    description:
      'Allow the result to fall below the currently reserved quantity. ' +
      'Default false => such an adjustment is rejected with 409.',
  })
  @IsOptional()
  @IsBoolean()
  allowBelowReserved?: boolean;
}
