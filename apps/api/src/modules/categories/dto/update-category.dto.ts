import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Rename only.
 *
 * A category's membership (which products are in it) is owned by the product
 * endpoints — `categoryIds` on product create/update is the complete desired
 * set. Accepting product ids here as well would give two writers to one
 * junction table with no defined precedence.
 */
export class UpdateCategoryDto {
  @ApiProperty({
    example: 'Mobile phones',
    description:
      'New category title. TRIMMED before validation, so a whitespace-only ' +
      'rename is a 400 and never reaches the row. Unique GLOBALLY after ' +
      'normalisation (ک/ك and ی/ي folded, ends trimmed, case ignored).',
  })
  // Same trim-then-require as `CreateCategoryDto`: renaming a category to
  // "   " is exactly as destructive as creating one that way, and the rename
  // path is the one an admin uses most.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: 'title field must be a string' })
  @IsNotEmpty({ message: 'title is required' })
  @MaxLength(200)
  title: string;
}
