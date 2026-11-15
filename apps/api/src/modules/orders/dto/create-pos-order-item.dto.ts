import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, Max, Min } from 'class-validator';
import { MAX_LINE_QUANTITY } from 'src/common/money/rial';

export class CreatePosOrderItemDto {
  @ApiProperty({
    example: 15,
    description: 'Product variant id',
  })
  @IsNotEmpty({ message: 'productVariantId is required' })
  @IsInt({ message: 'productVariantId must be an integer' })
  productVariantId: number;

  /**
   * The OTHER divisor behind `MAX_RIAL`. A line total is `unitPrice *
   * quantity`, computed as a JavaScript `number` in `recordPosSale`, so an
   * unbounded quantity makes the unit-price ceiling meaningless: 45 035 996 273
   * Rial times 10^9 units overflows 2^53 on a single line, before any
   * aggregation happens at all.
   *
   * Rejected, never clamped — a till that meant to sell 1 001 units must be
   * told so, not quietly sold 1 000.
   */
  @ApiProperty({
    example: 2,
    description: `Quantity, in units. 1..${MAX_LINE_QUANTITY}.`,
    minimum: 1,
    maximum: MAX_LINE_QUANTITY,
  })
  @IsNotEmpty({ message: 'quantity is required' })
  @IsInt({ message: 'quantity must be an integer' })
  @Min(1, { message: 'quantity must be greater than 0' })
  @Max(MAX_LINE_QUANTITY, {
    message: `quantity must not exceed ${MAX_LINE_QUANTITY}`,
  })
  quantity: number;
}
