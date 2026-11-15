import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { MAX_ORDER_RIAL } from 'src/common/money/rial';

import { ReconciliationResolutionType } from '../reconciliation.types';

/**
 * THE REASON IS MANDATORY ON EVERY RECONCILIATION MUTATION.
 *
 * It is not decoration. A manual reconciliation decision is, by construction,
 * one the system could not make — so the only record of WHY it was the right
 * one is the sentence the operator wrote. It goes into the append-only
 * `payment_actions` row and can never be edited afterwards.
 *
 * The 4-character floor rules out "ok" / "x" / "-" without demanding an essay.
 */
export class ReconciliationReasonDto {
  @ApiProperty({
    minLength: 4,
    maxLength: 2000,
    example: 'Customer confirmed by phone; gateway shows one capture only.',
    description:
      'Why this decision was taken. Written verbatim to the append-only audit ' +
      'trail and never shown to the customer.',
  })
  @IsString()
  @Length(4, 2000)
  reason: string;
}

/** `POST /payment/admin/reconciliation/:orderId/retry-fulfilment` */
export class RetryFulfilmentDto extends ReconciliationReasonDto {}

/** `POST /payment/admin/reconciliation/:orderId/mark-refund-required` */
export class MarkRefundRequiredDto extends ReconciliationReasonDto {
  /**
   * Bounded by `MAX_ORDER_RIAL`, not `MAX_RIAL`: this is an AGGREGATE figure
   * (what a whole order is worth), so the unit-price ceiling would reject
   * legitimate refunds on large orders. `MAX_ORDER_RIAL` is the largest total
   * the DTO bounds can produce and is still exactly representable, so a figure
   * above it could not have come from any order this API accepted.
   *
   * It lands in `payment_actions.amount`, a `bigint` behind `bigIntTransformer`
   * — which now throws on an unsafe write. Validating here turns that 500 into
   * the stable 400 the operator can actually act on.
   */
  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    maximum: MAX_ORDER_RIAL,
    example: 1_000_000,
    description:
      'The amount the operator expects to refund, INTEGER RIAL. Recorded on ' +
      'the audit row so the obligation carries a figure; it is NOT a promise ' +
      'and nothing is refunded by this call. Omit it when the amount is still ' +
      'being established.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ORDER_RIAL, {
    message: `expectedAmount must not exceed ${MAX_ORDER_RIAL} Rial`,
  })
  expectedAmount?: number;
}

/** `POST /payment/admin/reconciliation/:orderId/confirm-refund` */
export class ConfirmExternalRefundDto extends ReconciliationReasonDto {
  @ApiProperty({
    type: Number,
    example: 12,
    description:
      'Numeric `payment.id` of the RECEIPT that was refunded. Mandatory: an ' +
      'order can carry several confirmed receipts and only the operator knows ' +
      'which one they gave back. Nothing is inferred.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  paymentId: number;

  /**
   * The AUTHORITATIVE check on this figure stays in PostgreSQL (`$3::bigint <=
   * GREATEST(amount, COALESCE(gateway_amount, amount))`), because only the
   * receipt knows what may be given back. `@Max` here is the representability
   * check that has to happen BEFORE the value reaches that query: the parameter
   * is interpolated as `String(dto.amount)`, and `String(1e21)` is `"1e+21"`,
   * which a `bigint` cast rejects with a 500 rather than a 400.
   */
  @ApiProperty({
    type: Number,
    minimum: 1,
    maximum: MAX_ORDER_RIAL,
    example: 1_000_000,
    description:
      'The amount actually refunded, INTEGER RIAL. Validated in PostgreSQL ' +
      'against the receipt: it must be positive and no larger than the biggest ' +
      'figure recorded for it (`amount`, or `gateway_amount` when the gateway ' +
      'reported more). Neither recorded figure is overwritten.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ORDER_RIAL, {
    message: `amount must not exceed ${MAX_ORDER_RIAL} Rial`,
  })
  amount: number;

  @ApiProperty({
    minLength: 1,
    maxLength: 128,
    example: 'ZBL-REFUND-99213',
    description:
      'The PROVIDER’S reference for the refund — the number quoted back to the ' +
      'customer or to the bank. Mandatory: a refund nobody can look up is not ' +
      'evidence that a refund happened.',
  })
  @IsString()
  @Length(1, 128)
  @Matches(/^[A-Za-z0-9._:/-]+$/, {
    message:
      'externalReference must contain only letters, digits and . _ : / -',
  })
  externalReference: string;
}

/** `POST /payment/admin/reconciliation/:orderId/mark-backorder` */
export class MarkBackorderDto extends ReconciliationReasonDto {}

/** `POST /payment/admin/reconciliation/:orderId/resolve` */
export class ResolveReconciliationDto extends ReconciliationReasonDto {
  @ApiProperty({
    enum: ReconciliationResolutionType,
    example: ReconciliationResolutionType.NO_DISCREPANCY,
    description:
      'WHICH kind of "nothing needed to happen" is being asserted. Mandatory ' +
      'and explicit — "resolved" on its own records that somebody clicked ' +
      'something, not what they decided.',
  })
  @IsEnum(ReconciliationResolutionType)
  resolutionType: ReconciliationResolutionType;
}
