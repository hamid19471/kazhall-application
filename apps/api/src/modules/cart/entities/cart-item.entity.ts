import {
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  JoinColumn,
} from 'typeorm';

import { User } from 'src/modules/user/entities/user.entity';
import { Product } from 'src/modules/products/entities/product.entity';
import { ProductVariant } from 'src/modules/products/entities/product-variant.entity';
import { ReservationReleaseReason } from 'src/modules/inventory/entities/stock-reservation.entity';

export enum CartItemStatus {
  ACTIVE = 'active',
  /**
   * Soft-removed because the customer's hold went away underneath them
   * (a POS sale took the last units, or the 4h reservation expired).
   * The row is kept so the next basket read can explain what happened.
   */
  REMOVED = 'removed',
}

/**
 * Reasons a basket line changed that are NOT the release of a reservation.
 *
 * `lastChangeReason` is a plain `character varying` (migration 0005), so it can
 * carry these alongside a `ReservationReleaseReason` without touching the
 * `stock_reservations.releaseReason` PostgreSQL enum — which is the point:
 * writing one of these into a reservation row would be a lie, because no
 * reservation was involved.
 */
export enum CartLineChangeReason {
  /**
   * Set by migration 0013 on a line that predates the uniform sellable-SKU
   * model. The line named no variant, so it never had a reservation; its
   * product's new default variant starts at stock 0 (migration 0012 refuses to
   * invent a count), so no honest reservation could be created for it either.
   * The line is soft-removed and the customer is told once.
   */
  STOCK_NOT_COUNTED = 'stock_not_counted',

  /**
   * The line's SKU has been DEACTIVATED, so it cannot be ordered.
   *
   * ## It is DERIVED, and never written to this column
   *
   * Every other value here and in `ReservationReleaseReason` records an EVENT
   * that happened to the line, which is why it can be persisted: units were
   * taken, a hold lapsed, a migration could not carry the row forward.
   * Deactivation is not an event on the line at all — it releases no
   * reservation, moves no quantity and moves no price — so there is nothing to
   * write and nothing that would stay true if it were written. An administrator
   * reactivating the SKU would leave a stale `lastChangeReason` behind.
   *
   * So `CartService.buildView` computes it per read from the variant's current
   * `isActive`, and nothing in the application ever stores it. If this value is
   * ever found in `cart_items."lastChangeReason"`, that is a bug.
   *
   * ## Same value as `CheckoutChangeKind.NOT_SELLABLE`
   *
   * Deliberately the same string, so the basket screen and the checkout diff
   * name one condition one way. It is not a second, overlapping reason.
   */
  NOT_SELLABLE = 'not_sellable',

  /**
   * The product was withdrawn from the WEBSITE (migration 0030).
   *
   * DERIVED per read, exactly like `NOT_SELLABLE`, and NEVER STORED — if this
   * value is ever found in `cart_items."lastChangeReason"`, that is a bug.
   * Unpublishing writes nothing to a basket line: no reservation is released,
   * no quantity moves, so the fact is read from `products."visibleOnSite"` on
   * every `GET /cart`.
   *
   * SEPARATE FROM `NOT_SELLABLE` on purpose. That one means the SKU is
   * deactivated and sellable through no channel at all; this one means the
   * site channel is closed while the shops may still be selling it. One
   * condition, one name — and two conditions must not share a name.
   */
  CHANNEL_UNAVAILABLE = 'channel_unavailable',
}

/** Anything that can appear in `cart_items."lastChangeReason"`. */
export type CartLineChangeCause =
  | ReservationReleaseReason
  | CartLineChangeReason;

/**
 * A basket line.
 *
 * INVARIANT (enforced by InventoryService): for an ACTIVE line, `quantity`
 * equals the sum of that line's ACTIVE basket reservations. Nothing else is
 * allowed to write `quantity`.
 *
 * Every line names a variant (`variantId` is NOT NULL since migration 0013).
 * There is no such thing as a stock-untracked basket line any more: a line
 * that named no SKU used to skip the variant lock, the availability check and
 * the four-hour hold entirely, which meant unlimited quantities of a
 * variant-less product could sit in baskets and be checked out with nothing
 * allocated. The constraint is in the schema rather than only in the service
 * precisely because the service-level rule is what failed.
 *
 * The unique constraint is PARTIAL -- it only covers active rows -- because a
 * soft-removed line must not stop the customer re-adding the same product.
 * Since 0013 it is also TOTAL: NULL `variantId`s used to compare as distinct,
 * so two active lines for the same variant-less product did not conflict.
 */
@Entity('cart_items')
// Index names match migration 0005 (CartItemSoftRemoval) exactly, so entity
// metadata and the migrated schema cannot drift apart.
@Index('uq_cart_items_active_line', ['userId', 'productId', 'variantId'], {
  unique: true,
  where: `status = 'active'`,
})
@Index('idx_cart_items_active_user', ['userId'], {
  where: `status = 'active'`,
})
export class CartItem {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, (user) => user.cartItems, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'userId' })
  user: User;

  // `nullable: true` mirrors migration 0001, where these are plain relation
  // columns. The application always sets them; see the workstream D report for
  // the suggested NOT NULL tightening.
  @Column({ type: 'int', nullable: true })
  userId: number;

  @ManyToOne(() => Product, (product) => product.cartItems, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'productId' })
  product: Product;

  @Column({ type: 'int', nullable: true })
  productId: number;

  /**
   * The sellable SKU. NOT NULL since migration 0013 -- see the class comment.
   * A simple (option-less) product resolves to its DEFAULT variant.
   */
  @ManyToOne(() => ProductVariant, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'variantId' })
  variant: ProductVariant;

  @Column({ type: 'int' })
  variantId: number;

  @Column({
    default: 1,
  })
  quantity: number;

  @Column({
    type: 'enum',
    enum: CartItemStatus,
    default: CartItemStatus.ACTIVE,
  })
  status: CartItemStatus;

  /**
   * Why this line last changed WITHOUT the customer asking for it.
   *
   * PRIVACY: this is the entire customer-visible explanation. It says *what*
   * happened (`sold_in_store`, `reservation_expired`) and never *who* -- no
   * staff identity, no branch, no other customer's basket.
   *
   * NULL for customer-initiated changes, and cleared once a soft-removed line
   * has been shown to the customer.
   */
  @Column({ type: 'varchar', nullable: true })
  lastChangeReason: CartLineChangeCause | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastChangeAt: Date | null;

  /** Negative when units were taken away. */
  @Column({ type: 'int', nullable: true })
  lastChangeQtyDelta: number | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
