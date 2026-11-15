import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from 'src/common/dto/pagination.dto';

/**
 * `true`/`1`/`yes`/`on` and `false`/`0`/`no`/`off`, matching the coercion
 * `QueryProductsDto` already uses. Anything else is left untouched so
 * `@IsBoolean()` produces the 400 rather than a silent `false`.
 */
function toOptionalBoolean({ value }: { value: unknown }): unknown {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return value;
}

export class BranchQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    description: 'Case-insensitive contains, over branch name and address.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : (value as unknown),
  )
  search?: string;

  @ApiPropertyOptional({
    description:
      'Omit for every branch. This is deliberately TRISTATE — coercing an ' +
      'absent filter to `false` would hide every active branch by default.',
  })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}
