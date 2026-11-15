import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from 'src/common/dto/pagination.dto';

/**
 * Query for the ADMIN category list.
 *
 * The public `GET /categories` takes no parameters at all and returns the
 * whole (small, cached) navigation. This one exists because the admin screen
 * needs to search, and because an unpaginated admin table is a page that gets
 * slower every week without anyone noticing.
 */
export class QueryCategoriesDto extends PaginationDto {
  @ApiPropertyOptional({
    example: 'mobile',
    description: 'Case-insensitive substring match on the category title.',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : undefined,
  )
  @IsString()
  @MaxLength(200)
  search?: string;
}
