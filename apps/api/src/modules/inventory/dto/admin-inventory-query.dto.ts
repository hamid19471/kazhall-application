import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { PaginationDto } from 'src/common/dto/pagination.dto';
import { toBoolean } from 'src/modules/products/dto/query-products.dto';
import {
  DEFAULT_LOW_STOCK_THRESHOLD,
  MAX_LOW_STOCK_THRESHOLD,
} from '../views/admin-inventory.view';

/**
 * The three states PARTITION the filtered set — every variant is in exactly
 * one of them for a given threshold, so the three filter chips always sum to
 * the unfiltered total. `in_stock` therefore means "comfortably stocked"
 * (`availableForWeb > lowStockThreshold`), not merely "> 0": overlapping
 * states would make the counts in the header contradict the rows on screen.
 */
export enum StockStateFilter {
  IN_STOCK = 'in_stock',
  LOW_STOCK = 'low_stock',
  OUT_OF_STOCK = 'out_of_stock',
}

/**
 * The threshold on its own, for the single-variant read.
 *
 * A detail route must NOT accept `page`/`limit`: the global ValidationPipe is
 * `forbidNonWhitelisted`, so whatever a DTO declares becomes part of the
 * contract, and declaring pagination on a route that returns one row invites a
 * client to send it and believe it did something.
 */
export class AdminVariantStockQueryDto {
  @ApiPropertyOptional({
    minimum: 0,
    maximum: MAX_LOW_STOCK_THRESHOLD,
    default: DEFAULT_LOW_STOCK_THRESHOLD,
    example: DEFAULT_LOW_STOCK_THRESHOLD,
    description:
      'Boundary used to compute `lowStock` on the returned row. A display ' +
      'heuristic, not an owner-set reorder point.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_LOW_STOCK_THRESHOLD)
  lowStockThreshold: number = DEFAULT_LOW_STOCK_THRESHOLD;
}

export class AdminInventoryQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    example: 'IPH17',
    description:
      'Case-insensitive substring match on the PRODUCT TITLE or the VARIANT ' +
      'SKU. A stockroom search is as often a code as a name, which is why the ' +
      'SKU is included here and is not in `GET /products`.',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : undefined,
  )
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({
    example: 2,
    description: 'One category id from `GET /categories`. The list is flat.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  categoryId?: number;

  @ApiPropertyOptional({
    enum: StockStateFilter,
    example: StockStateFilter.LOW_STOCK,
    description:
      'Evaluated against `availableForWeb` (= physicalStock − basketReserved ' +
      '− orderAllocated), never against raw shelf stock: units another ' +
      'customer is already holding are not units this shop can sell.',
  })
  @IsOptional()
  @IsEnum(StockStateFilter)
  stockState?: StockStateFilter;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: MAX_LOW_STOCK_THRESHOLD,
    default: DEFAULT_LOW_STOCK_THRESHOLD,
    example: DEFAULT_LOW_STOCK_THRESHOLD,
    description:
      'Boundary for `low_stock`. A DISPLAY HEURISTIC, not an owner-set reorder ' +
      'point — nothing refuses a sale because of it. It is a request parameter ' +
      'so a view can disagree with the default.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_LOW_STOCK_THRESHOLD)
  lowStockThreshold: number = DEFAULT_LOW_STOCK_THRESHOLD;

  @ApiPropertyOptional({
    default: false,
    example: false,
    description:
      'Include RETIRED variants (`isActive = false`). They are hidden by ' +
      'default: a retired SKU still holds physical stock and would otherwise ' +
      'pad every count on a screen about what can be sold.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeInactive: boolean = false;
}
