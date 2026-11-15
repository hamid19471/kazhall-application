import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { bigIntTransformer } from 'src/common/transformers/bigint.transformer';
import { rialStringTransformer } from 'src/common/transformers/rial-string.transformer';

/** What happened to the units (docs/PURCHASE-COST-ACCOUNTING.md §5). */
export type OrderItemAdjustmentKind =
  | 'void'
  | 'return_refund'
  | 'refund_only'
  | 'return_only';

/**
 * Who wrote the row: a whole-order reversal, the line endpoint, or the 0037
 * backfill of reversals that happened before cost was recorded.
 */
export type OrderItemAdjustmentScope = 'order' | 'line' | 'legacy';

/**
 * ============================================================================
 * THE REVERSAL LEDGER — one row per (reversal event, order line).
 * ============================================================================
 *
 * Append-only at the database (`trg_order_item_adjustments_append_only`), and
 * bounded at the database (`trg_order_item_adjustments_bounded`): cumulative
 * revenue units, restocked units and COGS reversed can never exceed what the
 * line recognised. Revenue and COGS reversals in `/reports/profit/*` are read
 * from here and nowhere else. SUPER_ADMIN-ONLY: no customer, cashier or
 * delegated-admin projection reads it.
 */
@Entity('order_item_adjustments')
@Index('idx_adjustment_item', ['orderItemId'])
@Index('idx_adjustment_order', ['orderId'])
@Index('idx_adjustment_event_at', ['eventAt'])
export class OrderItemAdjustment {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  orderId: number;

  @Column({ type: 'int' })
  orderItemId: number;

  @Column({ type: 'varchar', length: 16 })
  kind: OrderItemAdjustmentKind;

  @Column({ type: 'varchar', length: 8 })
  scope: OrderItemAdjustmentScope;

  /** Units whose revenue this row reverses. */
  @Column({ type: 'int', default: 0 })
  revenueQuantity: number;

  /** Integer Rial. Bounded by the line's `total_price`, so a safe number. */
  @Column({ type: 'bigint', default: 0, transformer: bigIntTransformer })
  revenueReversed: number;

  /** Units physically returned whose cost was known. NULL only for legacy. */
  @Column({ type: 'int', nullable: true })
  restockedKnownQuantity: number | null;

  /** Units physically returned whose cost was unknown. NULL only for legacy. */
  @Column({ type: 'int', nullable: true })
  restockedUnknownQuantity: number | null;

  /** Exact COGS put back into the pool. NULL only for legacy. */
  @Column({
    type: 'bigint',
    nullable: true,
    transformer: rialStringTransformer,
  })
  cogsReversed: string | null;

  /** Reporting date. NULL only for a legacy refund of unknown date. */
  @Column({ type: 'timestamptz', nullable: true })
  eventAt: Date | null;

  @Column({ type: 'int', nullable: true })
  actorUserId: number | null;

  @Column({ type: 'varchar', nullable: true })
  actorDisplaySnapshot: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  reason: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  idempotencyKey: string | null;

  /** The restore movement carrying the physical and cost change, if any. */
  @Column({ type: 'int', nullable: true })
  stockMovementId: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
