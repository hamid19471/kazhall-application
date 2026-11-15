import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { PaginationDto } from 'src/common/dto/pagination.dto';
import UserRoleEnum from '../enums/user-role.enum';

export class FindAllUsersDto extends PaginationDto {
  @ApiPropertyOptional({
    enum: UserRoleEnum,
    example: UserRoleEnum.superAdmin,
    description:
      'Return only users holding this role. Omit for every staff user.',
  })
  @IsOptional()
  @IsEnum(UserRoleEnum)
  role?: UserRoleEnum;
}
