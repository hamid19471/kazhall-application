import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, Max, Min } from 'class-validator';
import { MAX_LINE_QUANTITY } from 'src/common/money/rial';

export class UpdateCartItemDto {
  /**
   * ABSOLUTE quantity, not a delta.
   *
   * An increase creates a new reservation tranche with its own 4h TTL; a
   * decrease releases the NEWEST tranche first; an identical value is a no-op
   * that must not move any timer (R4).
   *
   * 0 removes the line.
   *
   * Upper bound: `MAX_LINE_QUANTITY`, the same one `CreateCartItemDto` carries.
   * An absolute setter has to repeat it — otherwise a line added at the
   * accepted maximum could be raised past it by a PATCH, and checkout's
   * `unitPrice * quantity` would lose the exactness the add-path bound bought.
   */
  @ApiProperty({
    example: 3,
    description: `Absolute quantity; 0 removes the line. 0..${MAX_LINE_QUANTITY}.`,
    minimum: 0,
    maximum: MAX_LINE_QUANTITY,
  })
  @IsNotEmpty({ message: 'quantity is required' })
  @IsInt({ message: 'quantity field must be a number' })
  @Min(0, { message: 'quantity must be zero or more' })
  @Max(MAX_LINE_QUANTITY, {
    message: `quantity must not exceed ${MAX_LINE_QUANTITY}`,
  })
  quantity: number;
}
