import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsISO8601, IsInt, IsOptional, Min } from 'class-validator';

import { PaginationDto } from 'src/common/dto/pagination.dto';
import { StockMovementReason } from '../entities/stock-movement.entity';

/**
 * Filters for the physical-stock ledger.
 *
 * Every filter is an equality or a range on an indexed or narrow column.
 *
 * THERE IS DELIBERATELY NO FREE-TEXT SEARCH, even though `stock_movements`
 * does now carry free text (`reasonText`, migration 0024). The column is
 * unindexed, nullable on the overwhelming majority of rows, and populated only
 * by manual adjustments — a `LIKE '%…%'` over it would be a sequential scan of
 * the whole ledger to search a field that is empty almost everywhere. The
 * machine `reason` below is what narrows the set; the sentence is read off the
 * rows that come back.
 */
export class AdminMovementsQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    example: 7,
    description: 'One `product_variants.id` — the VARIANT, not the product.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  variantId?: number;

  @ApiPropertyOptional({
    example: 12,
    description: 'Every movement of every variant of this product.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  productId?: number;

  @ApiPropertyOptional({
    enum: StockMovementReason,
    example: StockMovementReason.MANUAL_ADJUSTMENT,
    description:
      'The machine reason recorded on the ledger row. Unknown values are ' +
      'rejected rather than silently returning nothing.',
  })
  @IsOptional()
  @IsEnum(StockMovementReason)
  reason?: StockMovementReason;

  @ApiPropertyOptional({
    example: 4,
    description:
      'Only movements caused by this user. `null` actors (system fulfilment) ' +
      'are excluded by any value here.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  actorUserId?: number;

  @ApiPropertyOptional({
    example: 31,
    description: 'Everything one order took out of, or gave back to, stock.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  orderId?: number;

  @ApiPropertyOptional({
    example: '2026-09-01T00:00:00.000Z',
    description: 'Inclusive lower bound on `createdAt`, ISO-8601.',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-09-30T23:59:59.999Z',
    description: 'Inclusive upper bound on `createdAt`, ISO-8601.',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;
}
