import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaginationDto } from 'src/common/dto/pagination.dto';
import { AUDIT_ACTION_CODES, AuditTarget } from '../audit.actions';

const TARGET_TYPES = Object.values(AuditTarget);

export class AuditQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    description:
      'Restrict to one action code, e.g. `role.permissions.changed`. Unknown ' +
      'codes are rejected rather than silently returning nothing.',
    enum: AUDIT_ACTION_CODES,
  })
  @IsOptional()
  @IsIn(AUDIT_ACTION_CODES as string[])
  action?: string;

  @ApiPropertyOptional({ enum: TARGET_TYPES, description: 'Kind of subject.' })
  @IsOptional()
  @IsIn(TARGET_TYPES)
  targetType?: string;

  @ApiPropertyOptional({
    description: 'Subject id. Only meaningful together with `targetType`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  targetId?: string;

  @ApiPropertyOptional({ description: 'Only acts by this administrator.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  actorUserId?: number;

  @ApiPropertyOptional({ description: 'Inclusive lower bound, ISO-8601.' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Inclusive upper bound, ISO-8601.' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}
