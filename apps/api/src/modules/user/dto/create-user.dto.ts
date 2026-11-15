import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import UserRoleEnum from 'src/modules/user/enums/user-role.enum';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateUserDto {
  @ApiProperty({
    example: 'behnam_dev',
    description: 'Username',
  })
  @IsNotEmpty({ message: 'username is required' })
  @IsString({ message: 'username must be a string' })
  @Length(3, 30, {
    message: 'username must be between 3 and 30 characters',
  })
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: 'username can only contain letters, numbers and underscore',
  })
  username: string;

  @ApiProperty({
    example: 'StrongPassword123!',
    description: 'User password',
  })
  @IsNotEmpty({ message: 'password is required' })
  @IsString({ message: 'password must be a string' })
  @Length(8, 64, {
    message: 'password must be between 8 and 64 characters',
  })
  password: string;

  @ApiPropertyOptional({
    example: [UserRoleEnum.superAdmin, UserRoleEnum.sale, UserRoleEnum.site],
    description: 'list of user roles',
    enum: UserRoleEnum,
    isArray: true,
  })
  @IsEnum(UserRoleEnum, {
    each: true,
    message: 'one or more of the roles are invalid',
  })
  @IsOptional()
  role?: UserRoleEnum[];

  @ApiProperty({
    example: '1',
    description: 'branch id',
  })
  @IsOptional()
  @IsInt()
  branchId?: number | null;
}
