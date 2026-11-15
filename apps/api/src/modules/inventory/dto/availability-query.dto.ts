import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt } from 'class-validator';

/**
 * Query for a batch availability read.
 *
 * Accepts `?variantIds=1,2,3` (one comma-separated value) or the repeated form
 * `?variantIds=1&variantIds=2`, because both are what HTTP clients produce and
 * a POS till has no reason to care which its library emits.
 */
export class AvailabilityQueryDto {
  @ApiProperty({
    example: '12,34,56',
    description:
      'Sellable variant ids. Comma-separated, or repeat the parameter. ' +
      'At most 100 per request.',
  })
  @Transform(({ value }): number[] => {
    /**
     * Query values arrive as `string | string[]`, never as an object — Express
     * gives a repeated parameter as an array and a single one as a string. The
     * narrowing is explicit rather than `String(unknown)` so a nested-object
     * query (`?variantIds[a]=1`, which Express *can* produce) is discarded
     * here instead of being stringified to `[object Object]` and then failing
     * the `@IsInt` check with a confusing message.
     */
    const raw: unknown[] = Array.isArray(value) ? value : [value];
    return raw
      .filter(
        (entry): entry is string | number =>
          typeof entry === 'string' || typeof entry === 'number',
      )
      .flatMap((entry) => String(entry).split(','))
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => Number(entry));
  })
  @IsArray()
  // Bounded on purpose: this is a read a till may call on every keystroke, and
  // an unbounded id list is an unbounded query.
  @ArrayMinSize(1, { message: 'variantIds must contain at least one id' })
  @ArrayMaxSize(100, { message: 'variantIds accepts at most 100 ids' })
  @IsInt({ each: true, message: 'each variantId must be an integer' })
  variantIds: number[];
}
