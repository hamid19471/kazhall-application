import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationDto } from 'src/common/dto/pagination.dto';

export enum AdminUserStatusFilter {
  ACTIVE = 'active',
  DEACTIVATED = 'deactivated',
}

/**
 * STAFF vs CUSTOMER, decided by the only thing that actually distinguishes
 * them in this schema: a staff account has a `username` and a password, a
 * customer account has a `mobile` and signs in with an OTP. There is no
 * `kind` column and inventing one here would be a claim the schema cannot
 * back — see the delivery report.
 */
export enum AdminUserKindFilter {
  STAFF = 'staff',
  CUSTOMER = 'customer',
}

export class AdminUserQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    description: 'Case-insensitive contains, over username and mobile.',
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
      'Only users holding this `roles.id`. Takes an ID rather than a name so ' +
      'CUSTOM roles are filterable too.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  roleId?: number;

  @ApiPropertyOptional({ description: 'Only users assigned to this branch.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  branchId?: number;

  @ApiPropertyOptional({ enum: AdminUserStatusFilter })
  @IsOptional()
  @IsEnum(AdminUserStatusFilter)
  status?: AdminUserStatusFilter;

  @ApiPropertyOptional({ enum: AdminUserKindFilter })
  @IsOptional()
  @IsEnum(AdminUserKindFilter)
  kind?: AdminUserKindFilter;
}
