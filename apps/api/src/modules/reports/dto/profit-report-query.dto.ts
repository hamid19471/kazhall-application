import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { OrderChannel } from 'src/modules/orders/enums/order-channel.enum';

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The dimensions `/reports/profit/breakdown` can group by. `category` is the
 * only one that can place one line in several rows (a product may sit in
 * several categories), which the response's `semantics` states.
 */
export const PROFIT_GROUP_BY = [
  'day',
  'branch',
  'channel',
  'cashier',
  'product',
  'variant',
  'category',
] as const;
export type ProfitGroupBy = (typeof PROFIT_GROUP_BY)[number];

/**
 * Filters shared by every `/reports/profit/*` route.
 *
 * `from` / `to` mean exactly what they mean on `/reports/sales/*`: INCLUSIVE
 * local calendar days in REPORT_TIMEZONE (default Asia/Tehran), converted to a
 * half-open UTC instant range by PostgreSQL.
 *
 * `branchId`, `channel` and `cashierUserId` describe the ORDER (who sold it,
 * where, through which channel); `productId`, `variantId` and `categoryId`
 * describe the LINE. Only the line filters can apply to inventory losses,
 * which are not sales and have no order.
 */
export class ProfitReportQueryDto {
  @ApiPropertyOptional({
    example: '2026-09-01',
    description:
      'Inclusive start, a local calendar day (YYYY-MM-DD) in the report timezone.',
  })
  @IsOptional()
  @Matches(LOCAL_DATE, { message: 'from must be a YYYY-MM-DD local date' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-09-30',
    description:
      'Inclusive end, a local calendar day (YYYY-MM-DD) in the report timezone.',
  })
  @IsOptional()
  @Matches(LOCAL_DATE, { message: 'to must be a YYYY-MM-DD local date' })
  to?: string;

  @ApiPropertyOptional({ enum: OrderChannel })
  @IsOptional()
  @IsEnum(OrderChannel)
  channel?: OrderChannel;

  @ApiPropertyOptional({ example: 2, description: 'orders."branchId".' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  branchId?: number;

  @ApiPropertyOptional({
    example: 4,
    description:
      'The SELLING cashier (orders."cashierUserId"), never the person who reversed the sale.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  cashierUserId?: number;

  @ApiPropertyOptional({ example: 12, description: 'order_items."productId".' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  productId?: number;

  @ApiPropertyOptional({ example: 31, description: 'order_items."variantId".' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  variantId?: number;

  @ApiPropertyOptional({
    example: 3,
    description:
      'Lines whose product is (currently) in this category, via product_category.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  categoryId?: number;

  @ApiPropertyOptional({ example: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ example: 20, default: 20, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 20;
}

/** `/reports/profit/breakdown` — the shared filters plus a required grouping. */
export class ProfitBreakdownQueryDto extends ProfitReportQueryDto {
  @ApiProperty({ enum: PROFIT_GROUP_BY, example: 'product' })
  @IsIn(PROFIT_GROUP_BY as unknown as string[], {
    message: `groupBy must be one of ${PROFIT_GROUP_BY.join(', ')}`,
  })
  groupBy: ProfitGroupBy;
}
