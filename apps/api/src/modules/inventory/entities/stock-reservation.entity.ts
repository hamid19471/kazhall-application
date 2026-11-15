import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ProductVariant } from 'src/modules/products/entities/product-variant.entity';
import { User } from 'src/modules/user/entities/user.entity';

export enum ReservationKind {
  /** Held by an ecommerce basket line. May be displaced by a POS sale. */
  BASKET = 'basket',
  /** Held by a created order awaiting payment. MUST NOT be displaced by POS. */
  ORDER = 'order',
}

export enum ReservationStatus {
  ACTIVE = 'active',
  /** Returned to free stock without a sale (expiry, basket edit, order cancel). */
  RELEASED = 'released',
  /** Turned into a physical stock decrement by a completed sale. */
  CONSUMED = 'consumed',
  /** Taken away by a higher-priority POS sale. */
  REVOKED = 'revoked',
}

export enum ReservationReleaseReason {
  SOLD_IN_STORE = 'sold_in_store',
  RESERVATION_EXPIRED = 'reservation_expired',
  BASKET_ITEM_REMOVED = 'basket_item_removed',
  QUANTITY_REDUCED = 'quantity_reduced',
  CONVERTED_TO_ORDER = 'converted_to_order',
  ORDER_CANCELLED = 'order_cancelled',
  PAYMENT_FAILED = 'payment_failed',
  FULFILLED = 'fulfilled',
}

/**
 * A soft hold on physical stock.
 *
 * INVARIANT: a reservation row is only ever moved OUT of ACTIVE by a
 * conditional UPDATE `WHERE id = :id AND status = 'active'` whose affected-row
 * count is asserted to be exactly 1. That is what makes "the same reserved
 * quantity is never released twice" structurally true rather than a convention.
 *
 * INVARIANT: `expires_at` is immutable after INSERT. Reads never touch it, and
 * quantity increases create NEW rows rather than extending existing ones.
 */
@Entity('stock_reservations')
@Index('idx_res_active_variant', ['variantId'], {
  where: `status = 'active'`,
})
@Index('idx_res_active_expiry', ['expiresAt'], {
  where: `status = 'active'`,
})
@Index('idx_res_active_cart_item', ['cartItemId'], {
  where: `status = 'active'`,
})
@Index('idx_res_active_order', ['orderId'], {
  where: `status = 'active'`,
})
export class StockReservation {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  variantId: number;

  @ManyToOne(() => ProductVariant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'variantId' })
  variant: ProductVariant;

  @Column({ type: 'enum', enum: ReservationKind })
  kind: ReservationKind;

  @Column({
    type: 'enum',
    enum: ReservationStatus,
    default: ReservationStatus.ACTIVE,
  })
  status: ReservationStatus;

  @Column({ type: 'int' })
  quantity: number;

  @Column({ type: 'int', nullable: true })
  userId: number | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'userId' })
  user: User | null;

  /** Set for kind=BASKET. */
  @Column({ type: 'int', nullable: true })
  cartItemId: number | null;

  /** Set for kind=ORDER. */
  @Column({ type: 'int', nullable: true })
  orderId: number | null;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  releasedAt: Date | null;

  @Column({
    type: 'enum',
    enum: ReservationReleaseReason,
    nullable: true,
  })
  releaseReason: ReservationReleaseReason | null;
}
