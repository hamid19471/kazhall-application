import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty } from 'class-validator';

export class AddRoleToUserDto {
  @ApiProperty({
    example: 1,
    description: 'The ID of the user to which we want to add role',
  })
  @IsInt({ message: 'userId field must be a number' })
  @IsNotEmpty({ message: 'userId is required' })
  userId: number;

  @ApiProperty({
    example: 1,
    description: 'The ID of the role that you want to add to the user.',
  })
  @IsInt({ message: 'roleId field must be a number' })
  @IsNotEmpty({ message: 'roleId is required' })
  roleId: number;
}
