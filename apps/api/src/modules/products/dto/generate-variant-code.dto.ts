import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * `POST /products/admin/codes/variant` — allocate a «کد گونه» under a parent.
 *
 * The parent code is sent rather than a product ID on purpose: the Admin form
 * generates variant codes while the product is still being TYPED and may not
 * exist yet. Taking the code means the create screen works identically to the
 * edit screen, with no "save the product first" step in between.
 *
 * It is NORMALISED server-side and echoed back, so a caller that sent a
 * half-typed, lower-case or Persian-digit code learns the canonical form it
 * must store alongside the child it just received.
 */
export class GenerateVariantCodeDto {
  @ApiProperty({ example: 'KZ-P-000001', maxLength: 32 })
  @IsNotEmpty()
  @IsString()
  @MaxLength(64)
  productCode: string;
}
