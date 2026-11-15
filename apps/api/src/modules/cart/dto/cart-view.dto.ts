import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ReservationReleaseReason } from 'src/modules/inventory/entities/stock-reservation.entity';
import {
  CartItemStatus,
  CartLineChangeCause,
  CartLineChangeReason,
} from '../entities/cart-item.entity';

export class CartTrancheView {
  @ApiProperty({ example: 2 })
  quantity: number;

  @ApiProperty({ example: '2026-09-09T14:00:00.000Z' })
  expiresAt: Date;
}

/**
 * What the customer is told about a line that changed without them asking.
 *
 * PRIVACY (acceptance test 21): `reason` and `message` say WHAT happened, never
 * WHO. There is deliberately no field here for a staff member, a branch, or
 * another customer -- adding one would leak store operations to the public API.
 */
export class CartLineChangeView {
  @ApiProperty({
    enum: [
      ReservationReleaseReason.SOLD_IN_STORE,
      ReservationReleaseReason.RESERVATION_EXPIRED,
      // Not a reservation release: no reservation ever existed on a line that
      // predates the uniform sellable-SKU model (migration 0013).
      CartLineChangeReason.STOCK_NOT_COUNTED,
      /*
       * Not a reservation release either, and not stored anywhere: DERIVED per
       * read from the variant's current `isActive`. The units are still held
       * and the line is still in `data` — it simply cannot be ordered, and
       * `POST /orders` refuses it with `409 VARIANT_INACTIVE`.
       *
       * It OUTRANKS a recorded reason on the same line: a customer told "your
       * hold expired" would add the item again, and that is refused too.
       * `at` and `quantityDelta` are null for this reason alone, because
       * nothing was taken away at any particular moment.
       */
      CartLineChangeReason.NOT_SELLABLE,
    ],
    example: ReservationReleaseReason.SOLD_IN_STORE,
  })
  reason: CartLineChangeCause;

  @ApiProperty({
    example:
      'Some of these units were sold in one of our stores before you checked out',
  })
  message: string;

  @ApiPropertyOptional({ nullable: true })
  at: Date | null;

  @ApiPropertyOptional({
    example: -2,
    description: 'Negative when units were taken away',
    nullable: true,
  })
  quantityDelta: number | null;
}

export class CartAttributeRefView {
  @ApiProperty({ example: 3 })
  id: number;

  @ApiProperty({ example: 'رنگ' })
  name: string;
}

export class CartAttributeValueView {
  @ApiProperty({ example: 12 })
  id: number;

  @ApiProperty({ example: 'مشکی' })
  value: string;

  @ApiPropertyOptional({ type: CartAttributeRefView })
  attribute?: CartAttributeRefView;
}

export class CartVariantView {
  @ApiProperty({ example: 6 })
  id: number;

  @ApiProperty({ example: 'KZ-BKP-010-50L-BLK' })
  sku: string;

  /**
   * The EFFECTIVE unit price: `product_variants.price` when the variant sets
   * one, otherwise the product's `basePrice`, which is the same inheritance
   * `OrdersService` charges at checkout. `null` only when neither exists, so a
   * client must render "price not announced" rather than a number.
   */
  @ApiPropertyOptional({
    example: 4500000,
    description:
      'Integer Rial. Effective price: variant price, else the product base price.',
    nullable: true,
  })
  price: number | null;

  /** What the customer chose, named — e.g. `رنگ: مشکی`, `ظرفیت: ۵۰ لیتر`. */
  @ApiProperty({ type: [CartAttributeValueView] })
  attributeValues: CartAttributeValueView[];
}

/** Server-authoritative projection of one basket line. */
export class CartLineView {
  @ApiProperty({ example: 12 })
  id: number;

  @ApiProperty({ enum: CartItemStatus })
  status: CartItemStatus;

  @ApiProperty({ example: 9 })
  productId: number;

  @ApiPropertyOptional({ nullable: true })
  productTitle: string | null;

  @ApiProperty({ type: [String] })
  productImages: Array<string | null>;

  @ApiPropertyOptional({ type: CartVariantView, nullable: true })
  variant: CartVariantView | null;

  @ApiProperty({ example: 3, description: 'Units currently on the line' })
  quantity: number;

  @ApiProperty({
    example: 3,
    description:
      'Units actually held by ACTIVE reservations. Server-authoritative.',
  })
  reservedQuantity: number;

  @ApiPropertyOptional({
    example: 5,
    nullable: true,
    description:
      'How many more units this customer could still add. This is the ' +
      'SELLABILITY figure, so it is 0 for a variant that has been ' +
      'deactivated — however many units are physically in stock.',
  })
  availableForBasket: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Earliest active tranche expiry -- when the line first starts losing units. Immutable per tranche (R4).',
  })
  expiresAt: Date | null;

  @ApiProperty({ type: [CartTrancheView] })
  tranches: CartTrancheView[];

  @ApiPropertyOptional({ type: CartLineChangeView, nullable: true })
  change: CartLineChangeView | null;
}
