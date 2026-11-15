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
import { MAX_RIAL } from 'src/common/money/rial';

export enum ProductSort {
  NEWEST = 'newest',
  PRICE_ASC = 'price_asc',
  PRICE_DESC = 'price_desc',
}

/**
 * `?inStockOnly=true|1|yes` -> true. Anything else falsy.
 *
 * Exported so the admin query DTO shares ONE definition: a second copy that
 * accepted a slightly different set of truthy spellings would make the same
 * query string mean different things on two endpoints.
 */
export const toBoolean = ({
  value,
}: {
  value: unknown;
}): boolean | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const v = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return undefined;
};

export class QueryProductsDto extends PaginationDto {
  @ApiPropertyOptional({
    example: 'galaxy',
    description: 'Case-insensitive substring match on product title.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : undefined,
  )
  search?: string;

  @ApiPropertyOptional({ example: 1, description: 'Filter by category id.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  categoryId?: number;

  @ApiPropertyOptional({
    example: 1000000,
    description:
      'Minimum effective price in integer Rial. Effective price = cheapest ACTIVE variant price, falling back to basePrice.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  /*
   * A READ path that is nonetheless bounded by the same constant as the WRITE
   * paths, and deliberately so: the filter is compared against `EFFECTIVE_PRICE`
   * in SQL, so a bound looser than the one prices are STORED under would let a
   * caller ask a question no row can answer, and — because `@Type(() => Number)`
   * happily produces `1e30` from the query string — would put a value that is
   * not a safe integer into a parameterised `bigint` comparison.
   */
  @Max(MAX_RIAL, { message: `minPrice must not exceed ${MAX_RIAL} Rial` })
  minPrice?: number;

  @ApiPropertyOptional({
    example: 50000000,
    description: 'Maximum effective price in integer Rial (inclusive).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_RIAL, { message: `maxPrice must not exceed ${MAX_RIAL} Rial` })
  maxPrice?: number;

  @ApiPropertyOptional({
    example: true,
    description:
      'Only products with at least one ACTIVE variant whose physical stock > 0. Indicative: stock is not reservation-adjusted at list level.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  inStockOnly?: boolean;

  @ApiPropertyOptional({
    enum: ProductSort,
    example: ProductSort.NEWEST,
    description: 'newest (default) | price_asc | price_desc',
  })
  @IsOptional()
  @IsEnum(ProductSort)
  sort?: ProductSort = ProductSort.NEWEST;
}
