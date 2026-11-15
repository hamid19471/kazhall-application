import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { PaginationDto } from 'src/common/dto/pagination.dto';
import { FulfillmentStateEnum } from '../enums/fulfillment-state.enum';
import { OrderChannel } from '../enums/order-channel.enum';
import { OrderStatusEnum } from '../enums/order-status.enum';
import { OrderReconciliationState } from '../enums/reconciliation-state.enum';
import { AdminOrderPaymentState } from '../views/admin-order.view';
import { ORDER_NUMBER_MAX_LENGTH } from '../order-number';

/** `?from=`/`?to=` are LOCAL CALENDAR DAYS, never instants. */
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * WHICH TIME AXIS `from`/`to` RANGE ON.
 *
 * Three different questions, and ranging all of them on `soldAt` (which is what
 * an order list normally does) answers only the first. `paid` is the axis money
 * is attributed to — an online order is stamped `soldAt` while it is still
 * PENDING, so a basket checked out on the 31st and paid on the 1st belongs to
 * the new month's revenue and to the old month's orders. `created` is row
 * bookkeeping and exists for support, not for accounting.
 */
export enum AdminOrderDateField {
  SOLD = 'sold',
  PAID = 'paid',
  CREATED = 'created',
}

/**
 * `orders.reconciliationState` plus the literal `none`.
 *
 * NULL is a real, distinct state — "this case has never been touched" — and it
 * is NOT the same as `open`, which records that the system or an operator
 * acknowledged it. A query string cannot express NULL, so the sentinel exists
 * for the one filter an operator actually wants most: "orders with no
 * reconciliation case at all".
 */
export const ADMIN_ORDER_RECONCILIATION_NONE = 'none';

export type AdminOrderReconciliationFilter =
  | OrderReconciliationState
  | typeof ADMIN_ORDER_RECONCILIATION_NONE;

const RECONCILIATION_FILTER_VALUES: readonly string[] = [
  ...Object.values(OrderReconciliationState),
  ADMIN_ORDER_RECONCILIATION_NONE,
];

/**
 * ===========================================================================
 * FILTERS FOR THE ADMIN ORDER LIST
 * ===========================================================================
 *
 * `GET /orders` used to take no query at all and answer with every order in the
 * table, fully hydrated. Every filter below exists so that an operator can ask
 * the database the question instead of downloading the answer and searching it
 * in the browser.
 *
 * The whitelisting `ValidationPipe` rejects any key not declared here, so a
 * misspelt filter is a 400 rather than a silently UNFILTERED list — which on
 * this endpoint means an operator acting on the wrong set of orders.
 */
export class AdminOrderQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    example: 'POS-20260910',
    description:
      'Matches `orders.orderNumber`, case-insensitively, anywhere in the ' +
      'string. A BARE NUMBER additionally matches `orders.id` exactly, because ' +
      'that is what an operator has in front of them when they are reading a ' +
      'log line or a support ticket rather than a receipt.',
  })
  @IsOptional()
  @IsString()
  /*
   * BOUNDED BY THE COLUMN IT SEARCHES.
   *
   * `orders."orderNumber"` is `varchar(40)` (the entity's declaration, which
   * migration 0026 finally gave the database too), and the only other thing
   * this term can match is `orders.id`, a bare number of at most 9 digits. A
   * term longer than the column can therefore never match anything — the old
   * bound of 64 admitted 24 characters of guaranteed-empty ILIKE scan. This
   * reads the same constant the generator and the entity do, so the three
   * cannot drift.
   */
  @MaxLength(ORDER_NUMBER_MAX_LENGTH)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  search?: string;

  @ApiPropertyOptional({ enum: OrderChannel })
  @IsOptional()
  @IsEnum(OrderChannel)
  channel?: OrderChannel;

  @ApiPropertyOptional({
    enum: OrderStatusEnum,
    description: 'The MONEY / commercial state stored on the order.',
  })
  @IsOptional()
  @IsEnum(OrderStatusEnum)
  status?: OrderStatusEnum;

  @ApiPropertyOptional({
    enum: FulfillmentStateEnum,
    description: 'The state of the GOODS, tracked independently of the money.',
  })
  @IsOptional()
  @IsEnum(FulfillmentStateEnum)
  fulfillmentState?: FulfillmentStateEnum;

  @ApiPropertyOptional({
    enum: AdminOrderPaymentState,
    description:
      'DERIVED from the order’s `payment` rows, not stored. Precedence: ' +
      'success > refunded > pending > failed > none. Note that an order whose ' +
      'only receipt is `confirmed_unapplied` matches `none`; see ' +
      '`AdminOrderPaymentState`.',
  })
  @IsOptional()
  @IsEnum(AdminOrderPaymentState)
  paymentState?: AdminOrderPaymentState;

  @ApiPropertyOptional({
    type: Number,
    example: 3,
    description:
      'Numeric `orders.branchId`. Online orders have none, so this filter ' +
      'excludes them by construction.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  branchId?: number;

  @ApiPropertyOptional({
    type: Number,
    example: 7,
    description:
      'The SELLING cashier (`orders.cashierUserId`), written once at sale time ' +
      'and never overwritten — not the person who later voided or returned it. ' +
      'That actor is in `GET /orders/{id}/actions`.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  cashierUserId?: number;

  @ApiPropertyOptional({
    type: Number,
    example: 12,
    description:
      'Numeric `orders.customerId` (the in-store customer directory).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  customerId?: number;

  @ApiPropertyOptional({
    type: Number,
    example: 88,
    description: 'Numeric `orders.userId` (the storefront account).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId?: number;

  @ApiPropertyOptional({
    enum: RECONCILIATION_FILTER_VALUES,
    description:
      'One of the reconciliation states, or the literal `none` for orders ' +
      'whose `reconciliationState` IS NULL — never touched, which is NOT the ' +
      'same as `open`.',
  })
  @IsOptional()
  @IsIn(RECONCILIATION_FILTER_VALUES)
  reconciliationState?: AdminOrderReconciliationFilter;

  @ApiPropertyOptional({
    example: '2026-09-01',
    description:
      'INCLUSIVE start of the range, as a LOCAL CALENDAR DAY (YYYY-MM-DD) in ' +
      'the report timezone (`REPORT_TIMEZONE`, default Asia/Tehran) — not an ' +
      'instant and not UTC. Sending only one of `from`/`to` selects that single ' +
      'day. The conversion to UTC instants happens in PostgreSQL with the ' +
      'zone’s own rules for that date.',
  })
  @IsOptional()
  @Matches(LOCAL_DATE, { message: 'from must be a YYYY-MM-DD local date' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-09-30',
    description:
      'INCLUSIVE end of the range, as a local calendar day in the report ' +
      'timezone. The day itself is fully included.',
  })
  @IsOptional()
  @Matches(LOCAL_DATE, { message: 'to must be a YYYY-MM-DD local date' })
  to?: string;

  @ApiPropertyOptional({
    enum: AdminOrderDateField,
    default: AdminOrderDateField.SOLD,
    description:
      'Which timestamp `from`/`to` range on. `sold` = when the sale was rung ' +
      'up (the default and the order list’s natural axis), `paid` = when the ' +
      'money actually arrived (`orders."paidAt"`, the revenue axis; NULL for an ' +
      'unpaid order, which such a range therefore excludes), `created` = the ' +
      'row’s own timestamp, for support.',
  })
  @IsOptional()
  @IsEnum(AdminOrderDateField)
  dateField: AdminOrderDateField = AdminOrderDateField.SOLD;
}

/**
 * Pagination for `GET /orders/{id}/actions`.
 *
 * The route was unbounded: it returned every `order_actions` row for an order.
 * The default is 50 rather than `PaginationDto`'s 10 because this list is an
 * order's whole administrative history and is normally read in one go — a
 * ten-row default would make the ordinary case paginate for no reason.
 */
export class AdminOrderActionsQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    maximum: 100,
    default: 50,
    example: 50,
    description: 'Rows per page. Capped at 100.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;
}
