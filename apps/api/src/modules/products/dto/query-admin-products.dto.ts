import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationDto } from 'src/common/dto/pagination.dto';
import { toBoolean } from './query-products.dto';

/**
 * WHERE "RUNNING LOW" COMES FROM — A DISPLAY HEURISTIC, NOT A BUSINESS RULE.
 *
 * Nobody has told us what low stock means for this shop, and it plainly differs
 * per product: five phones is a healthy shelf, five SIM cards is nearly out.
 * The real model is a per-variant reorder point, which needs a column and a
 * migration and, before either, an owner decision. Until then this one number
 * exists so the admin list can sort "probably needs attention" to the top, and
 * NOTHING may branch on it: no order is refused, no purchase is triggered, and
 * no customer is shown it.
 */
export const LOW_STOCK_THRESHOLD = 5;

/**
 * Stock bands for the admin list. Mutually exclusive and exhaustive over the
 * ACTIVE-variant stock total, so a product is in exactly one band:
 *
 *   out_of_stock  total = 0                          (includes "no active variant")
 *   low_stock     0 < total <= LOW_STOCK_THRESHOLD
 *   in_stock      total > LOW_STOCK_THRESHOLD
 *
 * `in_stock` deliberately EXCLUDES the low band. An admin filtering for
 * "in stock" is asking which products they need not think about; returning the
 * ones that are one sale from empty answers a different question.
 */
export enum AdminStockState {
  IN_STOCK = 'in_stock',
  LOW_STOCK = 'low_stock',
  OUT_OF_STOCK = 'out_of_stock',
}

export class QueryAdminProductsDto extends PaginationDto {
  @ApiPropertyOptional({
    example: 'galaxy',
    description:
      'Case-insensitive substring match on the product TITLE or on any of its ' +
      "variants' SKUs — an admin looking a product up from a barcode or a " +
      'picking list has the SKU, not the title.',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : undefined,
  )
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ example: 1, description: 'Filter by category id.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  categoryId?: number;

  @ApiPropertyOptional({
    example: true,
    description:
      'Tri-state. `true` = has at least one ACTIVE variant (so it can be ' +
      'offered on the web and at the till); `false` = every variant is ' +
      'inactive, which also covers the pathological product with no variants ' +
      'at all. Omit for both.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  sellable?: boolean;

  @ApiPropertyOptional({
    enum: AdminStockState,
    example: AdminStockState.LOW_STOCK,
    description:
      'Band of the ACTIVE-variant stock total. `low_stock` is ' +
      `0 < total <= ${LOW_STOCK_THRESHOLD} and \`in_stock\` is strictly ` +
      'above it — the bands do not overlap. The threshold is a display ' +
      'heuristic, not a rule the shop owner has set.',
  })
  @IsOptional()
  @IsEnum(AdminStockState)
  stockState?: AdminStockState;
}
