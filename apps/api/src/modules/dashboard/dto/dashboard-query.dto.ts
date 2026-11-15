import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class DashboardQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 1000,
    default: 5,
    description:
      'Variants with available stock at or below this (but above zero) are ' +
      'counted as low. A DISPLAY HEURISTIC — per-variant reorder points are ' +
      'not modelled, so the dashboard reports "down to N or fewer" rather ' +
      'than claiming anything needs reordering.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  lowStockThreshold?: number;
}
