import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber } from 'class-validator';

export class CreatePaymentDto {
  @ApiProperty({ example: 1, description: 'order id' })
  @IsNotEmpty({ message: 'orderId is required' })
  @IsNumber({}, { message: 'orderId field must be a number' })
  orderId: number;
}
