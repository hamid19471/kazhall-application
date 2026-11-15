import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { StockAdjustModeDto } from 'src/modules/products/dto/adjust-stock.dto';

/**
 * POST /admin/inventory/variants/:variantId/adjust
 *
 * WHY THIS EXISTS RATHER THAN REUSING `AdjustVariantStockDto`. The two differ
 * in exactly one place, and it is the place that matters: here `reason` is
 * MANDATORY. An administrative correction of physical stock is the one write
 * in this system that reconciles the database to the real world, so "who
 * changed 40 to 12, and why" has to be answerable afterwards. The POS route's
 * DTO leaves `reason` optional and that is left alone — it is a different
 * contract with a different caller.
 *
 * It deliberately does NOT extend `AdjustVariantStockDto`: class-validator
 * INHERITS a parent's metadata, so the parent's `@IsOptional()` on `reason`
 * would survive the override and the requirement would silently not hold.
 *
 * WHERE THE REASON IS STORED. Since migration 0024, in BOTH places that need
 * it: on the ledger row as `stock_movements.reasonText` (written inside the
 * adjustment's transaction, beside the machine `reason` enum) and in
 * `admin_audit_log` alongside the rest of the administrative record. See the
 * handler for why both exist.
 *
 * IT IS TRIMMED BEFORE IT IS VALIDATED. Without that, `'    '` satisfies
 * `@MinLength(4)` and a row of spaces becomes the permanent explanation for a
 * stock correction — the exact outcome mandating the field was meant to
 * prevent. The transform runs before every validator, so the 4–500 bound below
 * is a bound on REAL characters, and the trimmed value is what reaches the
 * service and the ledger.
 */
export class AdminAdjustStockDto {
  @ApiProperty({
    enum: StockAdjustModeDto,
    example: StockAdjustModeDto.SET,
    description:
      '`set` makes `value` the new absolute physical stock (the shape a stock ' +
      'count produces); `delta` adds the signed `value` to it.',
  })
  @IsEnum(StockAdjustModeDto)
  mode: StockAdjustModeDto;

  @ApiProperty({
    example: 12,
    description:
      'For `set`: the new absolute stock (must be >= 0). For `delta`: the ' +
      'signed change. Physical stock may never end up negative either way.',
  })
  @IsInt({ message: 'value must be an integer' })
  value: number;

  @ApiProperty({
    example: 'annual stock count 2026-09-11, shelf 4B',
    minLength: 4,
    maxLength: 500,
    description:
      'MANDATORY here, and measured AFTER TRIMMING — a string of spaces is ' +
      'refused. Stored on the stock ledger row itself as ' +
      '`stock_movements.reasonText` AND in the administrative audit trail.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(4)
  @MaxLength(500)
  reason: string;

  @ApiPropertyOptional({
    default: false,
    example: false,
    description:
      'Allow the result to fall below `basketReserved + orderAllocated`. ' +
      'Default false => such an adjustment is refused. The override is not a ' +
      'loophole: discovering shrinkage is exactly the case where stock ' +
      'legitimately has to drop below what is currently held.',
  })
  @IsOptional()
  @IsBoolean()
  allowBelowReserved?: boolean;
}
