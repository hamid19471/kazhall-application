import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
} from 'class-validator';

/**
 * A custom role's MACHINE NAME.
 *
 * Lower-case, underscore-separated, and bounded, because it is written into
 * rows and logs that outlive any UI and because a name containing a space or a
 * quote is a name that will eventually be concatenated into something. The
 * human-facing name is `titleFa`; this one exists to be stable.
 *
 * System role names are refused by the unique index AND explicitly, so the
 * caller gets a named 409 rather than a driver error.
 */
const ROLE_NAME = /^[a-z][a-z0-9_]{2,39}$/;

export class CreateRoleDto {
  @ApiProperty({
    example: 'order_manager',
    description:
      'Stable machine name: lower-case letters, digits and underscore, ' +
      '3–40 characters, starting with a letter.',
  })
  @IsString()
  @Matches(ROLE_NAME, {
    message:
      'name must be 3-40 characters of lower-case letters, digits or underscore, starting with a letter',
  })
  name: string;

  @ApiProperty({
    example: 'مدیر سفارش‌ها',
    description: 'Persian display name.',
  })
  @IsString()
  @Length(2, 80)
  titleFa: string;

  @ApiPropertyOptional({
    example: 'مشاهده و پیگیری سفارش‌ها بدون دسترسی به گزارش مالی.',
    description: 'What this role is for, in Persian. Shown in the role list.',
  })
  @IsOptional()
  @IsString()
  @Length(0, 400)
  description?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['admin.access', 'orders.read'],
    description:
      'Permission CODES to grant. Every code must exist in the catalogue and ' +
      'must be one the ACTOR already holds — a principal cannot mint ' +
      'authority it does not have.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  permissions?: string[];
}

export class UpdateRoleDto {
  @ApiPropertyOptional({ example: 'مدیر سفارش‌ها' })
  @IsOptional()
  @IsString()
  @Length(2, 80)
  titleFa?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 400)
  description?: string;
}

export class SetRolePermissionsDto {
  @ApiProperty({
    type: [String],
    example: ['admin.access', 'orders.read', 'orders.status.update'],
    description:
      'The COMPLETE desired set. Codes absent from this array are revoked. ' +
      'An empty array removes every grant, leaving a role that authorises ' +
      'nothing (which is legitimate — it is how a role is neutralised without ' +
      'losing its assignments).',
  })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  permissions: string[];
}

export class SetRoleActiveDto {
  @ApiProperty({
    example: false,
    description:
      'An inactive role contributes NOTHING to its holders’ effective ' +
      'permissions, while keeping every assignment so the change is reversible.',
  })
  @IsBoolean()
  isActive: boolean;
}

export class SetUserRolesDto {
  @ApiProperty({
    type: [Number],
    example: [2, 7],
    description:
      'The COMPLETE desired set of `roles.id`. Roles absent from this array ' +
      'are removed. Refused with 409 LAST_SUPER_ADMIN when it would leave the ' +
      'system without a usable administrator.',
  })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @IsInt({ each: true })
  @Min(1, { each: true })
  roleIds: number[];
}
