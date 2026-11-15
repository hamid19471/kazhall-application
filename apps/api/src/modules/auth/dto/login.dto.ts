import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length, Matches } from 'class-validator';

export class LoginDto {
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
}
