import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Matches, Min, Max } from 'class-validator';
import { OrderChannel } from 'src/modules/orders/enums/order-channel.enum';
import { OrderStatusEnum } from 'src/modules/orders/enums/order-status.enum';

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class SalesReportQueryDto {
  /**
   * INCLUSIVE local calendar day in REPORT_TIMEZONE, not an instant.
   * `from=2026-09-01&to=2026-09-01` selects
   * `[2026-09-01T00:00+03:30, 2026-09-02T00:00+03:30)`.
   */
  @ApiPropertyOptional({
    example: '2026-09-01',
    description:
      'Inclusive start of the range, as a local calendar day (YYYY-MM-DD) in the report timezone.',
  })
  @IsOptional()
  @Matches(LOCAL_DATE, { message: 'from must be a YYYY-MM-DD local date' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-09-30',
    description:
      'Inclusive end of the range, as a local calendar day (YYYY-MM-DD) in the report timezone.',
  })
  @IsOptional()
  @Matches(LOCAL_DATE, { message: 'to must be a YYYY-MM-DD local date' })
  to?: string;

  /**
   * The SELLER's user id (`orders.cashierUserId`), written once at sale time and
   * never overwritten. Filtering by it therefore selects what this person SOLD,
   * including sales that somebody else later refunded or voided. It is NOT the
   * reversal actor -- that lives in `order_actions.actorUserId` and is reported
   * separately as `reversalsByActor` on /reports/sales/by-cashier.
   */
  @ApiPropertyOptional({
    example: 4,
    description:
      'Filter by the SELLING cashier (orders.cashierUserId). Not the person who processed a later refund or void.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  cashierUserId?: number;

  /**
   * Only a `super_admin` may set this. A `sale` user is always pinned to the
   * branch on their access token; sending a different branch is a 403 rather
   * than a silently ignored filter.
   */
  @ApiPropertyOptional({
    example: 2,
    description:
      'super_admin only. Sale users are pinned to their token branch.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  branchId?: number;

  @ApiPropertyOptional({ enum: OrderChannel })
  @IsOptional()
  @IsEnum(OrderChannel)
  channel?: OrderChannel;

  @ApiPropertyOptional({ enum: OrderStatusEnum })
  @IsOptional()
  @IsEnum(OrderStatusEnum)
  status?: OrderStatusEnum;

  @ApiPropertyOptional({ example: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ example: 20, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 20;
}
