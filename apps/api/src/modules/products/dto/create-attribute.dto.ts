import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsNotEmpty, IsString } from 'class-validator';

export class CreateAttributeDto {
  @ApiProperty({
    example: 'رنگ',
    description:
      'Attribute name. TRIMMED before validation, so a whitespace-only name ' +
      'is a 400. Unique GLOBALLY after normalisation (ک/ك and ی/ي folded, ' +
      'ends trimmed, case ignored).',
  })
  // Trim first, then require non-empty — `@IsNotEmpty` on its own accepts
  // "   ". Matches `RenameAttributeDto`, which already did this, so the create
  // and rename paths cannot disagree about what an empty name is.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: 'attribute name field must be a string' })
  @IsNotEmpty({ message: 'attribute name in required' })
  name: string;

  @ApiProperty({
    example: ['آبی', 'قرمز'],
    description:
      'Initial values. Each is TRIMMED; a blank one is a 400. Values are ' +
      'unique WITHIN THIS ATTRIBUTE only — the same word may also belong to ' +
      'another attribute.',
  })
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? (value as unknown[]).map((v) => (typeof v === 'string' ? v.trim() : v))
      : value,
  )
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @ArrayNotEmpty()
  values: string[];
}
