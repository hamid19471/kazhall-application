import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetBranchActiveDto {
  @ApiProperty({
    example: false,
    description:
      'Deactivating stops NEW sales from this branch. It does not move staff, ' +
      'does not touch past orders, and is fully reversible.',
  })
  @IsBoolean()
  isActive: boolean;
}
