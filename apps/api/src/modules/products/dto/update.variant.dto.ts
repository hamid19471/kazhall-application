import { PartialType } from '@nestjs/swagger';
import { CreateVariantDto } from './create-variant.dto';
import { IsInt } from 'class-validator';

export class UpdateVariantDto extends PartialType(CreateVariantDto) {
  @IsInt()
  id: number;
}
