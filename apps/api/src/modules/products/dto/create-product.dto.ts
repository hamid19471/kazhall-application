import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  IsOptional,
  IsArray,
  Max,
  Min,
  ValidateNested,
  IsBoolean,
  IsIn,
  MaxLength,
  Allow,
} from 'class-validator';
import { MAX_RIAL, MAX_STOCK_UNITS } from 'src/common/money/rial';
import { CreateVariantDto } from './create-variant.dto';
import { Type } from 'class-transformer';

export class CreateProductDto {
  /**
   * «کد محصول» — the business identifier for this product family.
   *
   * REQUIRED. There is no "generate one for me if absent" fallback on this
   * path deliberately: a silently generated code is one nobody chose and
   * nobody can predict, and the Admin form already has an explicit
   * «تولید خودکار کد» button that allocates one through
   * `POST /products/admin/codes/product`.
   *
   * Normalised and validated server-side (`assertProductCode`): trimmed,
   * upper-cased, Persian/Arabic digits folded to ASCII, internal whitespace
   * and unsupported punctuation refused. A duplicate is a 409 naming
   * `productCode`.
   */
  @ApiProperty({ example: 'KZ-P-000001', maxLength: 32 })
  @IsNotEmpty()
  @IsString()
  @MaxLength(64)
  productCode: string;

  /**
   * WHERE THE PRODUCT IS OFFERED — `super_admin` only, enforced in the service
   * and not merely by a route decorator.
   *
   * Omit all three and the product is created HIDDEN/DRAFT (offered nowhere).
   * That is what a delegated catalogue editor gets whether they ask for it or
   * not: they may create and edit products, and only a super_admin may publish
   * one.
   *
   * ⚠ NOT INVENTORY. Branch selection decides WHERE the product may be sold,
   * never how much stock each branch has — stock stays global.
   */
  @ApiPropertyOptional({ description: 'Website channel. super_admin only.' })
  @IsOptional()
  @IsBoolean()
  visibleOnSite?: boolean;

  @ApiPropertyOptional({ enum: ['none', 'all', 'selected'] })
  @IsOptional()
  @IsIn(['none', 'all', 'selected'])
  branchVisibility?: 'none' | 'all' | 'selected';

  /** Required when `branchVisibility` is `selected`; refused otherwise. */
  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(1, { each: true })
  branchIds?: number[];

  @ApiProperty({ example: 'samsung glaxy a55', description: 'product title' })
  @IsNotEmpty({ message: 'title is required' })
  @IsString({ message: 'title field must be a string' })
  title: string;

  @ApiProperty({
    example:
      'This phone is one of the flagships of the Samsung brand, which will be released in late 2024.',
    description: 'product description',
  })
  @IsNotEmpty({ message: 'description is required' })
  @IsString({ message: 'description field must be a string' })
  description: string;

  /**
   * Integer Rial, per SINGLE UNIT. `MAX_RIAL` is not a business ceiling — it is
   * the largest unit price for which `price x quantity` summed over a full
   * `MAX_ORDER_LINES`-line order still lands inside `Number.MAX_SAFE_INTEGER`
   * (the arithmetic is worked out in src/common/money/rial.ts). Without it a
   * basePrice near 2^53 is individually storable and turns the ORDER TOTAL
   * computed from it into a rounded double.
   *
   * Rejected with 400, never clamped: a price the shop cannot charge is not a
   * price to quietly substitute one for.
   */
  @ApiProperty({
    example: '10000',
    description: `Product base price, integer Rial. 0..${MAX_RIAL}.`,
    minimum: 0,
    maximum: MAX_RIAL,
  })
  @IsOptional()
  @IsInt({ message: 'price field must be a number' })
  @Min(0, { message: 'basePrice must be zero or more' })
  @Max(MAX_RIAL, {
    message: `basePrice must not exceed ${MAX_RIAL} Rial`,
  })
  basePrice?: number;

  @ApiProperty({
    example: [
      {
        price: 12000000,
        stock: 10,
        sku: 'IPH17-BLK-128',
        attributeValueIds: [1],
      },
    ],
    description: 'attribute value ids',
    type: () => [CreateVariantDto],
  })
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CreateVariantDto)
  variants?: CreateVariantDto[];

  /**
   * ==========================================================================
   * OPENING QUANTITY FOR A SIMPLE PRODUCT
   * ==========================================================================
   * A SIMPLE product is one created with no `variants`: the API builds a single
   * hidden default variant for it, carrying the product's own price. Until now
   * that variant was always born at zero, so stocking a new simple product took
   * five steps — create, save, reopen, find the default variant, adjust stock —
   * for a shop whose product has no options at all.
   *
   * `initialStock` collapses that to one save.
   *
   * ONLY FOR A SIMPLE PRODUCT. Sending it together with `variants` is refused
   * (400 `INITIAL_STOCK_WITH_VARIANTS`) rather than applied to one of them or
   * silently ignored: with explicit variants there is no single quantity to
   * mean, each variant already carries its own `stock`, and guessing which one
   * the caller meant would put units on the wrong SKU.
   *
   * THE QUANTITY IS GLOBAL. It is not per branch and not per channel. The same
   * units are what the website sells and what every eligible till sells; two
   * branches carrying the product draw down one number. Branch visibility
   * decides WHERE a product may be sold, never HOW MANY each place has.
   *
   * IT IS NOT A SHORTCUT PAST THE LEDGER. A positive value writes a real
   * `initial_stock` stock movement, in the same transaction, attributed to the
   * caller. `stock` is never assigned directly, because units with no ledger
   * row leave every later reconciliation off by the opening balance.
   *
   * AUTHORISATION. A positive value additionally requires `inventory.adjust` —
   * putting units into the system is an inventory act whoever performs it. A
   * delegated catalogue editor holding only `products.create` may still create
   * the product, with `initialStock` of 0.
   *
   * NOT ACCEPTED ON PATCH. `UpdateProductDto` omits it, so sending it to
   * `PATCH /products/:id` is a 400. Stock changes after creation go through
   * `POST /products/variants/:variantId/stock/adjust`, which is the only path
   * that reconciles against reservations.
   */
  @ApiPropertyOptional({
    example: 10,
    minimum: 0,
    maximum: MAX_STOCK_UNITS,
    description:
      'Opening quantity for a SIMPLE product (one created without `variants`). ' +
      'Rejected alongside `variants`. A positive value requires ' +
      '`inventory.adjust` and writes an `initial_stock` movement. The quantity ' +
      'is GLOBAL across the website and every eligible branch — it is not a ' +
      'per-branch figure.',
  })
  @IsOptional()
  @IsInt({ message: 'initialStock must be an integer number of units' })
  @Min(0, { message: 'initialStock must not be negative' })
  @Max(MAX_STOCK_UNITS, {
    message: `initialStock must not exceed ${MAX_STOCK_UNITS}`,
  })
  initialStock?: number;

  @ApiPropertyOptional({
    example: 8_500_000,
    description:
      'PURCHASE COST («قیمت خرید هر واحد»), integer Rial, 0..MAX_RIAL, as a JSON integer or a base-10 integer string. super_admin ONLY — anyone else sending it gets 403 PURCHASE_COST_FORBIDDEN. REQUIRED when this simple product has a positive opening quantity (400 INITIAL_STOCK_REQUIRES_PURCHASE_COST); with zero quantity it is only remembered as the default for the next receipt and creates no value and no movement. 0 is an explicit, legitimate cost; omitting the field is NOT zero. Validated by the service (stable codes PURCHASE_COST_INVALID / PURCHASE_COST_OUT_OF_RANGE), which is why the decorator is @Allow(). Never echoed in any product view — read it from /admin/costing.',
  })
  @Allow()
  purchasePrice?: unknown;

  @ApiPropertyOptional({ example: [1], description: 'product category ids' })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  categoryIds?: number[];

  /**
   * IMAGE CONTRACT (create) -- the update-time contract is documented on
   * `UpdateProductDto`.
   *
   * Ids of images previously uploaded via `POST /products/uploadImage`, which
   * returns a detached `ProductImage`. They are re-parented to the new product
   * and their `sortOrder` is PERSISTED as the 0-based array index, so the
   * order the admin supplied round-trips through a reload.
   *
   * Unknown id                 -> 404 PRODUCT_IMAGES_NOT_FOUND
   * Duplicate id               -> 400 PRODUCT_IMAGES_DUPLICATED
   * Id already owned by another product
   *                            -> 400 PRODUCT_IMAGE_OWNED_BY_OTHER_PRODUCT
   */
  @ApiPropertyOptional({
    example: [9, 4, 7],
    description:
      'Ordered ids of pre-uploaded images. Array index is persisted as sortOrder.',
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  images?: number[];
}
