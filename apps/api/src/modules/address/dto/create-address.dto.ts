import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

export class CreateAddressDto {
  @ApiProperty({ example: 'tehran', description: 'province' })
  @IsNotEmpty({ message: 'province is required' })
  @IsString({ message: 'province field must be a string' })
  province: string;

  @ApiProperty({ example: 'tehran', description: 'city' })
  @IsNotEmpty({ message: 'city is required' })
  @IsString({ message: 'city field must be a string' })
  city: string;

  @ApiProperty({
    example:
      'Borj Aftab, 150 Vali Asr Street, Nabsh-e Koocheh Golha, Floor 3, Unit 7',
    description: 'address',
  })
  @IsNotEmpty({ message: 'address is required' })
  @IsString({ message: 'address field must be a string' })
  address: string;

  @ApiProperty({ example: '1373666161', description: 'postal code' })
  @IsString({ message: 'postal_code is required' })
  @Length(10, 10, { message: 'postal_code must be 10 characters' })
  postal_code: string;

  @ApiProperty({ example: '09902172024', description: 'reciver_mobile' })
  @IsString({ message: 'reciver_mobile is required' })
  @Matches(/^09\d{9}$/, {
    message: 'reciver_mobile be a valid phone number',
  })
  reciver_mobile: string;

  @ApiPropertyOptional({
    example: 'this is an address from home',
    description: 'description',
  })
  @IsOptional()
  @IsString({ message: 'description field must be a string' })
  description: string;
}
