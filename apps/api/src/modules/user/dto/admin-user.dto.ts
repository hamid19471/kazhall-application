import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * The username charset matches `LoginDto` EXACTLY (`^[a-zA-Z0-9_]+$`, 3..30).
 * A creation form that accepts a username the login form rejects is how an
 * account is created that can never sign in — the dot in `first.last` was the
 * concrete instance.
 */
const USERNAME = /^[a-zA-Z0-9_]+$/;

/** `09XXXXXXXXX`, the normalised form the OTP flow stores. */
const IRAN_MOBILE = /^09\d{9}$/;

export class CreateStaffUserDto {
  @ApiProperty({ example: 'kazhal_cashier3' })
  @IsString()
  @Length(3, 30)
  @Matches(USERNAME, {
    message: 'username can only contain letters, numbers and underscore',
  })
  username: string;

  @ApiProperty({
    example: 'Temp!Passw0rd',
    description:
      'The INITIAL password, typed by the administrator and handed over out ' +
      'of band. It is hashed immediately and is never readable again. Bounded ' +
      '8–64 to match the login form.',
  })
  @IsString()
  @Length(8, 64)
  password: string;

  @ApiPropertyOptional({
    example: '09120000000',
    description: 'Optional. Unique across all users when present.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Matches(IRAN_MOBILE, { message: 'mobile must be in the form 09XXXXXXXXX' })
  mobile?: string | null;

  @ApiPropertyOptional({
    example: 1,
    description:
      'Branch assignment. Required in practice for a cashier: ' +
      '`POST /orders/pos` refuses a branchless seller.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  branchId?: number | null;

  @ApiProperty({
    type: [Number],
    example: [2],
    description:
      '`roles.id` values. At least one — an account with no role authorises ' +
      'nothing and cannot open a session on any surface.',
  })
  @IsArray()
  @ArrayUnique()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsInt({ each: true })
  @Min(1, { each: true })
  roleIds: number[];

  @ApiPropertyOptional({
    description:
      'When true the user must replace the password at first sign-in. ' +
      'Defaults to true, which is the safe default for a password somebody ' +
      'else chose.',
  })
  @IsOptional()
  mustChangePassword?: boolean;
}

export class UpdateStaffUserDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(3, 30)
  @Matches(USERNAME, {
    message: 'username can only contain letters, numbers and underscore',
  })
  username?: string;

  @ApiPropertyOptional({ description: 'Send null to clear.' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Matches(IRAN_MOBILE, { message: 'mobile must be in the form 09XXXXXXXXX' })
  mobile?: string | null;

  @ApiPropertyOptional({
    description:
      'Send null to unassign. Changing this takes effect on the user’s NEXT ' +
      'request — the branch is read from the database, never from their token.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  branchId?: number | null;
}

export class ResetUserPasswordDto {
  @ApiProperty({
    example: 'Temp!Passw0rd',
    description:
      'A TEMPORARY password the administrator types and hands over out of ' +
      'band. The system never generates and displays one: a generated ' +
      'credential rendered in a browser tab ends up in screenshots, in ' +
      'scrollback and in whatever it is pasted into.\n\n' +
      'Setting it revokes every session the user holds, in every audience, ' +
      'and flags the account so the next sign-in must replace it.',
  })
  @IsString()
  @Length(8, 64)
  temporaryPassword: string;
}
