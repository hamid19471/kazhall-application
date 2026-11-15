import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateCategoryDto {
  @ApiProperty({
    example: 'کیف',
    description:
      'Category title. TRIMMED before validation, so a whitespace-only ' +
      'title is a 400 rather than a blank row. Unique GLOBALLY after ' +
      'normalisation: ک/ك and ی/ي are folded together, ends are trimmed and ' +
      'case is ignored.',
  })
  // Trim FIRST, then require non-empty: `@IsNotEmpty` alone accepts "   ",
  // which would create a category nobody can see or search for. Mirrors the
  // transform already used by the attribute rename DTOs. The database says the
  // same thing independently (`ck_categories_title_not_blank`).
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsNotEmpty({ message: 'title is required' })
  @IsString({ message: 'title field must be a string' })
  title: string;
}
