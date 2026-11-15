import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  Min,
} from 'class-validator';

import { PaginationDto } from 'src/common/dto/pagination.dto';
import { FulfillmentStateEnum } from 'src/modules/orders/enums/fulfillment-state.enum';
import { OrderStatusEnum } from 'src/modules/orders/enums/order-status.enum';
import {
  RECONCILIATION_STAGES,
  ReconciliationStage,
} from '../reconciliation.types';
import { PaymentStatusEnum } from '../enums/payment-status-enum';
import { ReconciliationCaseType } from '../reconciliation.types';

/**
 * Filters for `GET /payment/admin/reconciliation`.
 *
 * THE DEFAULT IS "EVERYTHING", INCLUDING RESOLVED CASES. That is deliberate:
 * the one property this queue has to have is that an unresolved discrepancy
 * cannot silently disappear from it, and a default filter is the easiest way to
 * lose one. An operator narrows explicitly.
 *
 * The whitelisting `ValidationPipe` rejects any query key not declared here, so
 * a typo in a filter name is a 400 rather than a silently unfiltered list —
 * which on this endpoint would be an operator acting on the wrong set of money.
 */
export class ReconciliationQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    enum: ReconciliationCaseType,
    description:
      'Keep only cases carrying this reason. A case can carry several; this ' +
      'matches "has this type", it does not mean "has only this type".',
  })
  @IsOptional()
  @IsEnum(ReconciliationCaseType)
  caseType?: ReconciliationCaseType;

  @ApiPropertyOptional({
    enum: PaymentStatusEnum,
    description:
      'Keep only cases with at least one payment attempt in this status.',
  })
  @IsOptional()
  @IsEnum(PaymentStatusEnum)
  paymentStatus?: PaymentStatusEnum;

  @ApiPropertyOptional({ enum: OrderStatusEnum })
  @IsOptional()
  @IsEnum(OrderStatusEnum)
  orderStatus?: OrderStatusEnum;

  @ApiPropertyOptional({ enum: FulfillmentStateEnum })
  @IsOptional()
  @IsEnum(FulfillmentStateEnum)
  fulfillmentState?: FulfillmentStateEnum;

  @ApiPropertyOptional({
    type: Number,
    description:
      'Numeric `orders.branchId`. Online orders have none, so this filter ' +
      'excludes them by construction — it is only meaningful for in-store ' +
      'sales that reached the queue.',
    example: 3,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  branchId?: number;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description:
      'Keep only orders created at or after this instant (ISO-8601). ' +
      'Compared in PostgreSQL against `orders.created_at`.',
  })
  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Keep only orders created at or before this instant.',
  })
  @IsOptional()
  @IsISO8601()
  createdTo?: string;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      '`true` = only cases an operator has closed ' +
      '(`reconciliationResolvedAt IS NOT NULL`); `false` = only open ones. ' +
      'OMIT IT to see both, which is the default and the safe default.',
  })
  @IsOptional()
  // Query strings carry `?resolved=false`, which is a truthy STRING. Without
  // this transform `false` would filter to resolved-only — the exact opposite
  // of what the operator asked for.
  @Transform(({ value }: { value: unknown }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return value;
  })
  @IsBoolean()
  resolved?: boolean;

  @ApiPropertyOptional({
    enum: RECONCILIATION_STAGES,
    description:
      'THE SIMPLE VIEW. `needs_action` = nobody has decided anything yet ' +
      '(the page defaults to this); `tracking` = a decision is taken and is ' +
      'waiting on something outside this system (a refund to perform in the ' +
      'provider’s panel, or stock to arrive); `closed` = finished.\n\n' +
      'The three PARTITION the queue, so working all three is working ' +
      'everything.\n\n' +
      'ANDed with `resolved` rather than overriding it: a contradictory pair ' +
      'returns nothing, which is honest, instead of silently ignoring one.',
  })
  @IsOptional()
  @IsIn(RECONCILIATION_STAGES as unknown as string[])
  stage?: ReconciliationStage;
}
