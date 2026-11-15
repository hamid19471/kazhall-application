import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, Max, Min } from 'class-validator';
import { MAX_LINE_QUANTITY } from 'src/common/money/rial';

export class CreateCartItemDto {
  @ApiProperty({ example: 9, description: 'product id' })
  @IsNotEmpty({ message: 'productId is required' })
  @IsInt({ message: 'productId field must be a number' })
  productId: number;

  @ApiPropertyOptional({
    example: 6,
    description: 'selected product variant id',
  })
  @IsInt({ message: 'variantId field must be a number' })
  variantId?: number;

  /**
   * Same ceiling as the POS line, and for the same arithmetic: checkout prices
   * the basket with `sum + item.unitPrice * item.quantity` in JavaScript
   * (`OrdersService.priceBasket`), and that product is only guaranteed exact
   * while BOTH operands are bounded. See src/common/money/rial.ts.
   */
  @ApiProperty({
    example: 1,
    description: `Number of units to add. 1..${MAX_LINE_QUANTITY}.`,
    minimum: 1,
    maximum: MAX_LINE_QUANTITY,
  })
  @IsNotEmpty({ message: 'quantity is required' })
  @IsInt({ message: 'quantity field must be a number' })
  @Min(1, { message: 'quantity must be a least 1' })
  @Max(MAX_LINE_QUANTITY, {
    message: `quantity must not exceed ${MAX_LINE_QUANTITY}`,
  })
  quantity: number;
}
