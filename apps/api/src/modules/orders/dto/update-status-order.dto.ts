import { IsEnum, IsNotEmpty } from 'class-validator';
import { OrderStatusEnum } from '../enums/order-status.enum';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateStatusOrderDto {
  @ApiProperty({
    example: OrderStatusEnum.PENDING,
    description: 'order status',
  })
  @IsNotEmpty({ message: 'status is required' })
  @IsEnum(OrderStatusEnum, {
    message: 'status must be one of the valid values',
  })
  status: OrderStatusEnum;
}
