import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * The attribute write contract is three NARROW DTOs, not one `PartialType` of
 * the create DTO.
 *
 * `PartialType(CreateAttributeDto)` would have accepted `{ values: [...] }` on
 * a PATCH, and the only sane reading of that is "these are now the attribute's
 * values" — a wholesale replacement that deletes every value the payload omits
 * (`ProductAttribute.values` is `orphanedRowAction: 'delete'`). Those rows are
 * referenced by live variants and frozen into `order_items.attributesSnapshot`,
 * so a screen that forgot to send one would retire options nobody asked to
 * retire. Adding and renaming are therefore separate, explicit acts.
 */
export class RenameAttributeDto {
  @ApiProperty({ example: 'colour', description: 'New attribute name.' })
  @IsString({ message: 'attribute name field must be a string' })
  @IsNotEmpty({ message: 'attribute name is required' })
  @MaxLength(200)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  name: string;
}

export class AddAttributeValuesDto {
  @ApiProperty({
    example: ['green', 'yellow'],
    description:
      'Values to ADD to this attribute. Existing values are left alone; a ' +
      'value the attribute already carries is a 409.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(200, { each: true })
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? (value as unknown[]).map((v) => (typeof v === 'string' ? v.trim() : v))
      : value,
  )
  values: string[];
}

export class RenameAttributeValueDto {
  @ApiProperty({ example: 'midnight blue', description: 'New value text.' })
  @IsString({ message: 'value field must be a string' })
  @IsNotEmpty({ message: 'value is required' })
  @MaxLength(200)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  value: string;
}
