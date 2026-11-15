import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Deliberately a BODY field rather than two separate routes.
 *
 * `PATCH .../active {isActive}` keeps "what state should this be in" as the
 * request's subject, so a client that has a toggle does not have to branch on
 * which URL to call — and the two capabilities it can require
 * (`x.activate` / `x.deactivate`) are still checked separately, server-side.
 */
export class SetActiveDto {
  @ApiProperty({ example: false })
  @IsBoolean()
  isActive: boolean;
}
