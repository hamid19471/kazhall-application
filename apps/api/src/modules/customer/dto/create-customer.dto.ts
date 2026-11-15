import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsPhoneNumber,
  IsString,
} from 'class-validator';

export class CreateCustomerDto {
  @ApiProperty({
    example: '09123456789',
    description: 'Customer mobile number',
  })
  @IsNotEmpty({ message: 'mobile is required' })
  @IsPhoneNumber('IR', {
    message: 'mobile number is invalid',
  })
  mobile: string;

  @ApiPropertyOptional({
    example: 'Ali Ahmadi',
    description: 'Customer name',
  })
  @IsOptional()
  @IsString({ message: 'name must be a string' })
  name?: string;
}
