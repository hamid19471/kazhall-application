import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Till lookup: the cashier scans or types a SKU. */
export class SkuLookupDto {
  @ApiProperty({
    example: 'IPH17-BLK-128',
    description:
      'Exact SKU of a sellable variant. `product_variants.sku` is globally ' +
      'unique, so this identifies one unit precisely — it is a scan target, ' +
      'not a search box.',
  })
  @IsNotEmpty({ message: 'sku is required' })
  @IsString({ message: 'sku must be a string' })
  @MaxLength(120, { message: 'sku is too long' })
  sku: string;
}
