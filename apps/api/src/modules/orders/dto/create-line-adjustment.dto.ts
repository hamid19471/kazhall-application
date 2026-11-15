import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { MAX_LINE_QUANTITY, MAX_ORDER_LINES } from 'src/common/money/rial';

/**
 * What a line adjustment does to the units (docs/PURCHASE-COST-ACCOUNTING.md
 * §2.1, the three "(new)" rows):
 *
 *   return_refund  the goods came back AND the money went back
 *   refund_only    the money went back, the goods did not (a visible loss)
 *   return_only    the goods came back, the money did not (an exchange credit
 *                  handled outside the system, a replacement, …)
 *
 * `void` is deliberately NOT accepted: it is a whole-order event and only
 * `POST /orders/:id/void` writes it.
 */
export const LINE_ADJUSTMENT_KINDS = [
  'return_refund',
  'refund_only',
  'return_only',
] as const;
export type LineAdjustmentKind = (typeof LINE_ADJUSTMENT_KINDS)[number];

/** Kinds that give money back, i.e. reverse revenue. */
export const REFUNDING_KINDS: readonly LineAdjustmentKind[] = [
  'return_refund',
  'refund_only',
];
/** Kinds that put goods back on the shelf, i.e. restock with the line's COGS. */
export const RETURNING_KINDS: readonly LineAdjustmentKind[] = [
  'return_refund',
  'return_only',
];

export const LINE_ADJUSTMENT_REASON_MIN = 4;
export const LINE_ADJUSTMENT_REASON_MAX = 500;

export class LineAdjustmentLineDto {
  @ApiProperty({ example: 812, description: 'Numeric `order_items.id`.' })
  @IsInt({ message: 'orderItemId must be an integer' })
  @Min(1, { message: 'orderItemId must be a positive integer' })
  orderItemId: number;

  /**
   * Bounded by the same `MAX_LINE_QUANTITY` a sale is, so a quantity that
   * could never have been sold is a 400 rather than a 409 against the line.
   */
  @ApiProperty({
    example: 1,
    minimum: 1,
    maximum: MAX_LINE_QUANTITY,
    description:
      'Units of this line to adjust. Must not exceed what remains on the line ' +
      '(409 ADJUSTMENT_EXCEEDS_LINE).',
  })
  @IsInt({ message: 'quantity must be an integer' })
  @Min(1, { message: 'quantity must be at least 1' })
  @Max(MAX_LINE_QUANTITY, {
    message: `quantity must not exceed ${MAX_LINE_QUANTITY}`,
  })
  quantity: number;
}

/**
 * Body of `POST /admin/orders/:orderId/line-adjustments` (contract §13).
 *
 * The `Idempotency-Key` travels in the header, never here, for the reason the
 * POS sale DTO gives: it describes the attempt, not the adjustment.
 */
export class CreateLineAdjustmentDto {
  @ApiProperty({ enum: LINE_ADJUSTMENT_KINDS, example: 'return_refund' })
  @IsIn(LINE_ADJUSTMENT_KINDS, {
    message: `kind must be one of: ${LINE_ADJUSTMENT_KINDS.join(', ')}`,
  })
  kind: LineAdjustmentKind;

  /**
   * TRIMMED BEFORE IT IS MEASURED, so four spaces are not a reason. It is
   * stored on every adjustment row and as the restore movement's `reasonText`.
   */
  @ApiProperty({
    example: 'مشتری یک عدد را به دلیل ایراد برگرداند',
    minLength: LINE_ADJUSTMENT_REASON_MIN,
    maxLength: LINE_ADJUSTMENT_REASON_MAX,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: 'reason must be a string' })
  @MinLength(LINE_ADJUSTMENT_REASON_MIN, {
    message: `reason must be at least ${LINE_ADJUSTMENT_REASON_MIN} characters`,
  })
  @MaxLength(LINE_ADJUSTMENT_REASON_MAX, {
    message: `reason must not exceed ${LINE_ADJUSTMENT_REASON_MAX} characters`,
  })
  reason: string;

  /**
   * Unique by `orderItemId`: two entries for one line would each be checked
   * against the SAME remaining quantity and could together exceed it before
   * the database's bounds trigger refused the second row.
   */
  @ApiProperty({ type: [LineAdjustmentLineDto] })
  @IsArray({ message: 'lines must be an array' })
  @ArrayMinSize(1, { message: 'lines must contain at least one line' })
  @ArrayMaxSize(MAX_ORDER_LINES, {
    message: `lines must not contain more than ${MAX_ORDER_LINES} entries`,
  })
  @ArrayUnique((line: LineAdjustmentLineDto) => line?.orderItemId, {
    message: 'lines must not name the same orderItemId twice',
  })
  @ValidateNested({ each: true })
  @Type(() => LineAdjustmentLineDto)
  lines: LineAdjustmentLineDto[];
}
