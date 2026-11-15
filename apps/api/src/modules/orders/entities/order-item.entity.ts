import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Order } from './order.entity';
import { Product } from 'src/modules/products/entities/product.entity';
import { ProductVariant } from 'src/modules/products/entities/product-variant.entity';
import { bigIntTransformer } from 'src/common/transformers/bigint.transformer';
import { rialStringTransformer } from 'src/common/transformers/rial-string.transformer';

/** docs/PURCHASE-COST-ACCOUNTING.md §4. */
export type OrderItemCostStatus = 'pending' | 'known' | 'unknown';

/**
 * One sold line.
 *
 * The `*Snapshot` columns are IMMUTABLE historical facts, written once at sale
 * time and never rewritten. They exist because the product/variant FKs are
 * `ON DELETE SET NULL`: without the snapshots, deleting a product would erase
 * what was actually sold, and renaming or re-pricing a product would silently
 * rewrite history. Reports read the snapshots, never the live catalog.
 */
@Entity('order_items')
@Index('idx_order_item_order', ['orderId'])
@Index('idx_order_item_variant', ['variantId'])
export class OrderItems {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', nullable: true })
  orderId: number;

  @ManyToOne(() => Order, (order) => order.items, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'orderId' })
  order: Order;

  @Column({ type: 'int', nullable: true })
  productId: number | null;

  @ManyToOne(() => Product, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'productId' })
  product?: Product | null;

  @Column({ type: 'int', nullable: true })
  variantId: number | null;

  @ManyToOne(() => ProductVariant, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'variantId' })
  variant?: ProductVariant | null;

  /**
   * What the receipt said. NOT NULL: a sold line always knows what it sold,
   * even after the catalog row is gone.
   */
  @Column({ type: 'varchar' })
  productTitleSnapshot: string;

  /** SKU as it was at sale time. Nullable only for legacy rows. */
  @Column({ type: 'varchar', nullable: true })
  variantSkuSnapshot: string | null;

  /** e.g. `{ "Colour": "Black", "Size": "42" }` as it was at sale time. */
  @Column({ type: 'jsonb', nullable: true })
  attributesSnapshot: Record<string, string> | null;

  /**
   * «کد محصول» as it was at sale time (0032).
   *
   * Unlike the SKU, a code is EDITABLE by a super_admin. Without this column,
   * fixing a typo in a product code would silently rewrite what every past
   * receipt and report says was sold. Nullable only for legacy rows whose
   * catalogue row was already deleted before 0032 ran — see that migration's
   * header for why a placeholder was not invented instead.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  productCodeSnapshot: string | null;

  /** «کد گونه» as it was at sale time. Nullable only for legacy rows. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  variantCodeSnapshot: string | null;

  @Column({
    default: 1,
  })
  quantity: number;

  @Column({ type: 'bigint', default: 0, transformer: bigIntTransformer })
  unit_price: number;

  @Column({ type: 'bigint', default: 0, transformer: bigIntTransformer })
  total_price: number;

  /*
   * ==========================================================================
   * THE COST SNAPSHOT (migration 0037). SUPER_ADMIN-ONLY.
   *
   * Written once, by `InventoryService.allocateOrderLineCosts`, in the same
   * transaction and under the same variant lock as the stock decrement.
   * `trg_order_items_cost_snapshot_immutable` refuses any later change, so a
   * second allocation is a database error. `cogsTotal` is authoritative and is
   * NEVER recomputed from a variant's current cost. No customer, cashier,
   * receipt or admin-order projection selects these columns.
   * ==========================================================================
   */

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  costStatus: OrderItemCostStatus;

  /** Exact COGS of the line's KNOWN-cost units. NULL while pending / legacy. */
  @Column({
    type: 'bigint',
    nullable: true,
    transformer: rialStringTransformer,
  })
  cogsTotal: string | null;

  @Column({ type: 'int', nullable: true })
  costKnownQuantity: number | null;

  @Column({ type: 'int', nullable: true })
  costUnknownQuantity: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  costAllocatedAt: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
