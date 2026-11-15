import {
  IsOptional,
  IsString,
  MinLength,
  IsPhoneNumber,
} from 'class-validator';

export class CreateBranchDto {
  @IsString()
  @MinLength(2)
  name: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsPhoneNumber('IR')
  phone?: string;
}
