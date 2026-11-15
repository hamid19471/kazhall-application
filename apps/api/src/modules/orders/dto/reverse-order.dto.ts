import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Body for `POST /orders/:id/void` and `POST /orders/:id/return`. */
export class ReverseOrderDto {
  @ApiPropertyOptional({
    example: 'Customer changed their mind before leaving the shop',
    description:
      'Free-text reason, stored on the append-only order_actions row together ' +
      'with the acting user. The original cashier is never overwritten.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
