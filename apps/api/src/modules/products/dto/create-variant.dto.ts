import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  Max,
  Min,
  IsString,
  MaxLength,
  Allow,
} from 'class-validator';
import { MAX_RIAL, MAX_STOCK_UNITS } from 'src/common/money/rial';

export class CreateVariantDto {
  /**
   * «کد گونه» — this exact variant's business identifier.
   *
   * REQUIRED, and must begin with the parent product's `productCode` followed
   * by a hyphen (`assertVariantBelongsToProduct`). DISTINCT FROM `sku`, which
   * is the warehouse's own string and is left untouched by all of this.
   */
  @ApiProperty({ example: 'KZ-P-000001-V000001', maxLength: 64 })
  @IsNotEmpty()
  @IsString()
  @MaxLength(96)
  variantCode: string;

  /**
   * Integer Rial, per SINGLE UNIT. Same ceiling and same reason as
   * `CreateProductDto.basePrice`: this is the figure `OrdersService` multiplies
   * by a line quantity and sums into `orders.subtotal`, so bounding it is what
   * keeps that sum exact. See the arithmetic in src/common/money/rial.ts.
   */
  @ApiProperty({
    example: '12000000',
    description: `Variant price, integer Rial. 0..${MAX_RIAL}.`,
    required: false,
    minimum: 0,
    maximum: MAX_RIAL,
  })
  @IsOptional()
  @IsInt({ message: 'variant price field must be a number' })
  @Min(0, { message: 'variant price must be zero or more' })
  @Max(MAX_RIAL, {
    message: `variant price must not exceed ${MAX_RIAL} Rial`,
  })
  price?: number;

  /**
   * Units, not money — hence `MAX_STOCK_UNITS` (half the PostgreSQL int4
   * ceiling) rather than `MAX_RIAL`. The bound stops an int4 overflow inside
   * `stock = stock + $delta` from surfacing as a driver 500 instead of a 400.
   */
  @ApiProperty({
    example: 10,
    description: `Variant stock in units. 0..${MAX_STOCK_UNITS}.`,
    minimum: 0,
    maximum: MAX_STOCK_UNITS,
  })
  @IsInt({ message: 'variant stock field must be a number' })
  @Min(0, { message: 'variant stock must be zero or more' })
  @Max(MAX_STOCK_UNITS, {
    message: `variant stock must not exceed ${MAX_STOCK_UNITS} units`,
  })
  stock: number;

  @ApiProperty({
    example: 8_500_000,
    required: false,
    description:
      'PURCHASE COST («قیمت خرید هر واحد»), integer Rial, 0..MAX_RIAL, as a JSON integer or a base-10 integer string. super_admin ONLY — anyone else sending it gets 403 PURCHASE_COST_FORBIDDEN. REQUIRED when this variant has a positive opening quantity (400 INITIAL_STOCK_REQUIRES_PURCHASE_COST); with zero quantity it is only remembered as the default for the next receipt and creates no value and no movement. 0 is an explicit, legitimate cost; omitting the field is NOT zero. Validated by the service (stable codes PURCHASE_COST_INVALID / PURCHASE_COST_OUT_OF_RANGE), which is why the decorator is @Allow(). Never echoed in any product view — read it from /admin/costing.',
  })
  @Allow()
  purchasePrice?: unknown;

  @ApiProperty({
    example: 'IPH17-BLK-128',
    description: 'variant sku',
  })
  @IsNotEmpty({ message: 'sku in required' })
  sku: string;

  @ApiProperty({
    example: [1, 5],
    description: 'attribute value ids',
  })
  @IsArray()
  @IsNotEmpty({ message: 'attributeValueIds in required' })
  attributeValueIds: number[];
}
