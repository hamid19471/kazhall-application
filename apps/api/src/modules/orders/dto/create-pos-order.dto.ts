import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsPhoneNumber,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { CreatePosOrderItemDto } from './create-pos-order-item.dto';
import { PaymentMethodEnum } from '../enums/payment-method.enum';
import { MAX_ORDER_LINES } from 'src/common/money/rial';

/**
 * Body of `POST /orders/pos`.
 *
 * THE KEY IS NOT IN HERE, ON PURPOSE. Retry protection travels in the REQUIRED
 * `Idempotency-Key` HTTP header, not in this DTO: the header is metadata about
 * the *attempt*, while everything below describes the *sale*, and the two must
 * hash separately or a retry would look like a different request. Putting it in
 * the body would also make it a field a form can render, and it must never be
 * one — the POS application generates the key itself (one UUIDv4 per sale
 * attempt, resent verbatim on every retry of that attempt) and no cashier ever
 * sees or types it.
 *
 * A request without a valid header is rejected with 400 before any sale work
 * starts; see `OrdersController.createPosOrder` and
 * `requirePosIdempotencyKey`.
 */
export class CreatePosOrderDto {
  /**
   * WALK-IN SALES. Optional on purpose: a shop cannot refuse to sell to someone
   * who will not give a phone number. When supplied the sale is linked to (or
   * creates) a customer record; when omitted the sale simply has no customer.
   */
  @ApiPropertyOptional({
    example: '09123456789',
    description:
      'Customer phone number. Optional - omit it for an anonymous walk-in sale.',
  })
  @IsOptional()
  @IsPhoneNumber('IR', {
    message: 'phone number is invalid',
  })
  mobile?: string;

  @ApiPropertyOptional({
    example: 'Ali Ahmadi',
    description: 'Customer name. Only stored when a mobile number is supplied.',
  })
  @IsOptional()
  @IsString({ message: 'name must be a string' })
  @MaxLength(120)
  name?: string;

  @ApiProperty({
    enum: PaymentMethodEnum,
    example: PaymentMethodEnum.CASH,
    description:
      'How the money was taken. `card_terminal` is a manual record of a payment ' +
      'taken on an external terminal - there is no hardware integration.',
  })
  @IsEnum(PaymentMethodEnum, {
    message: `paymentMethod must be one of: ${Object.values(PaymentMethodEnum).join(', ')}`,
  })
  paymentMethod: PaymentMethodEnum;

  /**
   * Duplicate `productVariantId` rows are AGGREGATED, not rejected -- see
   * `OrdersService.aggregatePosItems`.
   */
  @ApiProperty({
    type: [CreatePosOrderItemDto],
    description:
      'Order items. Must not be empty. Repeated productVariantId entries are ' +
      'summed into a single line before the stock check runs.',
  })
  @IsArray({ message: 'items must be an array' })
  @ArrayNotEmpty({ message: 'items must contain at least one item' })
  /*
   * THE UPPER BOUND IS HALF OF THE MONEY SAFETY ARGUMENT, not request hygiene.
   *
   * `recordPosSale` prices this array in JavaScript: `subtotal += unitPrice *
   * quantity` per line. `MAX_RIAL` is computed as
   * `Number.MAX_SAFE_INTEGER / (MAX_ORDER_LINES * MAX_LINE_QUANTITY)`, so the
   * unit-price ceiling is only sound while the LINE COUNT is capped at the
   * `MAX_ORDER_LINES` that divisor assumed. Without this decorator a caller
   * sends 10 000 lines at the maximum accepted price and the subtotal exceeds
   * 2^53 with every individual field having validated cleanly.
   *
   * Counted BEFORE aggregation, which is the conservative order: duplicate
   * `productVariantId` rows are summed into one line later, so 200 accepted
   * entries can only ever produce 200 or fewer priced lines.
   */
  @ArrayMaxSize(MAX_ORDER_LINES, {
    message: `items must not contain more than ${MAX_ORDER_LINES} entries`,
  })
  @ValidateNested({ each: true })
  @Type(() => CreatePosOrderItemDto)
  items: CreatePosOrderItemDto[];

  /**
   * IGNORED FOR AUTHORIZATION. Accepted only so that an existing client that
   * still sends it does not get a 400 from `forbidNonWhitelisted`. The cashier
   * is always `req.user.sub` and the branch is always the token's branch claim.
   */
  @ApiPropertyOptional({
    description:
      'IGNORED. The cashier is taken from the access token, never from the body.',
    deprecated: true,
  })
  @IsOptional()
  @IsInt()
  cashierId?: number;

  /** IGNORED FOR AUTHORIZATION. See `cashierId`. */
  @ApiPropertyOptional({
    description:
      'IGNORED. The branch is taken from the access token, never from the body.',
    deprecated: true,
  })
  @IsOptional()
  @IsInt()
  branchId?: number;
}
