import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { PaginationDto } from 'src/common/dto/pagination.dto';

/**
 * Query for the ADMIN attribute list.
 *
 * ATTRIBUTES are paginated, their VALUES are inlined in full. That asymmetry is
 * deliberate: the vocabulary axes (colour, size, capacity) are few and an admin
 * reads them as a list, while the values of one axis are useless split across
 * pages — you cannot review "which colours exist" from half of them. The number
 * of values per attribute is bounded by what a human typed, unlike the number
 * of attributes, which grows with the catalogue.
 *
 * `limit` defaults to 50 rather than `PaginationDto`'s 10 because this screen is
 * a single scrollable vocabulary, not a table an admin pages through. The
 * inherited cap of 100 still applies.
 */
export class QueryAttributesDto extends PaginationDto {
  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    maximum: 100,
    default: 50,
    example: 50,
    description: 'Attributes per page. Capped at 100.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;
}
