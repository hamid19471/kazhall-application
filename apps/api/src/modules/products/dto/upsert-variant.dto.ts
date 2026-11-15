import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  Allow,
} from 'class-validator';
import { MAX_RIAL, MAX_STOCK_UNITS } from 'src/common/money/rial';

/**
 * One entry of `UpdateProductDto.variants`.
 *
 * See the VARIANT LIFECYCLE CONTRACT block on `UpdateProductDto`.
 */
export class UpsertVariantDto {
  /**
   * «کد گونه». REQUIRED when creating (no `id`); omit on an update to leave
   * the existing code alone.
   *
   * It is editable, because `order_items` snapshots both codes at sale time —
   * so correcting a typo changes the catalogue and never a historical receipt.
   */
  @ApiPropertyOptional({ example: 'KZ-P-000001-V000002', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(96)
  variantCode?: string;

  @ApiPropertyOptional({
    example: 1,
    description:
      'Omit to CREATE a new variant. Provide to UPDATE an existing one. ' +
      'The id must belong to the product being updated, otherwise the ' +
      'request is rejected with 400.',
  })
  @IsOptional()
  @IsInt({ message: 'variant id must be a number' })
  @Min(1)
  id?: number;

  /**
   * Integer Rial, per SINGLE UNIT. `@Min(0)` was already here; the missing half
   * was the ceiling. A price just under 2^53 passes `@Min(0)` and `@IsInt`,
   * stores fine in a `bigint`, and then makes `unitPrice * quantity` in
   * `OrdersService` a rounded double — see the arithmetic in
   * src/common/money/rial.ts.
   */
  @ApiPropertyOptional({
    example: 12000000,
    description: `Integer Rial, per unit. 0..${MAX_RIAL}.`,
    minimum: 0,
    maximum: MAX_RIAL,
  })
  @IsOptional()
  @IsInt({ message: 'variant price field must be a number' })
  @Min(0)
  @Max(MAX_RIAL, {
    message: `variant price must not exceed ${MAX_RIAL} Rial`,
  })
  price?: number;

  @ApiPropertyOptional({
    example: 10,
    description:
      'Initial physical stock. ONLY honoured when CREATING a variant. On an ' +
      'update it is rejected: stock is moved exclusively through the ' +
      'inventory ledger (POST /products/variants/:variantId/stock/adjust), ' +
      'so that every change has a movement row and a balanceAfter.',
  })
  @IsOptional()
  @IsInt({ message: 'variant stock field must be a number' })
  @Min(0)
  // Units, bounded by int4 storage rather than by MAX_RIAL. See MAX_STOCK_UNITS.
  @Max(MAX_STOCK_UNITS, {
    message: `variant stock must not exceed ${MAX_STOCK_UNITS} units`,
  })
  stock?: number;

  @ApiPropertyOptional({
    example: 8_500_000,
    description:
      'Only honoured when CREATING a variant; see CreateVariantDto.purchasePrice. ' +
      'On an existing variant it is refused (400 PURCHASE_COST_NOT_UPDATABLE): cost ' +
      'changes only through /admin/costing, never through a product PATCH.',
  })
  @Allow()
  purchasePrice?: unknown;

  @ApiPropertyOptional({ example: 'IPH17-BLK-128' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  sku?: string;

  @ApiPropertyOptional({
    example: [1, 5],
    description:
      'Complete desired attribute-value set for this variant. Required when ' +
      'creating. When updating, omitting it leaves the set untouched.',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  attributeValueIds?: number[];

  @ApiPropertyOptional({
    example: false,
    description:
      'false = DEACTIVATE (retire) the variant, true = reactivate. Variants ' +
      'are never hard-deleted because order_items reference them.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
