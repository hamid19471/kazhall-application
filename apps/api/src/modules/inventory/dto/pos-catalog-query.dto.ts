import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

import { PaginationDto } from 'src/common/dto/pagination.dto';

/**
 * Query for the till's product catalogue.
 *
 * Extends `PaginationDto`, so `limit` is capped at 100 by the same validator
 * every other listing uses. The till asks for far less than that — a counter
 * grid shows a couple of dozen tiles — but the cap is what stops a client
 * asking for the whole catalogue in one request.
 */
export class PosCatalogQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    example: 'کوله',
    maxLength: 200,
    description:
      'Matches a product TITLE, a variant SKU, or a variant ATTRIBUTE VALUE ' +
      '(e.g. "سرمه‌ای"), case-insensitively. Surrounding whitespace is trimmed. ' +
      'Unlike `GET /products`, which searches titles only, the till needs SKU ' +
      'and attribute matching because a cashier looks for "the navy 50-litre ' +
      'one", not for a product id.',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined,
  )
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({
    example: 2,
    description:
      'Restrict to one category id, as returned by `GET /categories`. The ' +
      'category list is flat; there is no hierarchy to walk.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  categoryId?: number;
}
