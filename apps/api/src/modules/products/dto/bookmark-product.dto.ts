import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, Min } from 'class-validator';

/**
 * The bookmarked user is ALWAYS the authenticated caller (`req.user.sub`).
 *
 * `userId` used to be accepted from the request body, which let any
 * authenticated user create or delete bookmarks on behalf of anyone else
 * (IDOR). It is deliberately absent, and `forbidNonWhitelisted` on the global
 * ValidationPipe means sending it now fails the request outright rather than
 * being silently ignored.
 */
export class BookmarkProductDto {
  @ApiProperty({ example: 1, description: 'product id' })
  @IsNotEmpty({ message: 'productId is required' })
  @IsInt({ message: 'productId field must be a number' })
  @Min(1)
  productId: number;
}
