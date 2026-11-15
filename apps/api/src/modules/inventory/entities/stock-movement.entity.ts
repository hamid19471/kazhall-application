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
import { rialStringTransformer } from 'src/common/transformers/rial-string.transformer';

export enum StockMovementReason {
  POS_SALE = 'pos_sale',
  ONLINE_FULFILLMENT = 'online_fulfillment',
  CANCELLATION_RESTORE = 'cancellation_restore',
  RETURN_RESTORE = 'return_restore',
  MANUAL_ADJUSTMENT = 'manual_adjustment',
  /**
   * The opening quantity a product entered the catalogue with, written once by
   * the same transaction that created its default variant (migration 0036).
   *
   * DELIBERATELY NOT `MANUAL_ADJUSTMENT`. That one means "a person looked at
   * the shelf and corrected the number", and its rows are what a stock-take
   * audit reads; filing an opening balance under it would put a correction on
   * the ledger that nobody made. It is also what makes "every later change
   * goes through the adjustment endpoint" checkable — an `initial_stock` row
   * can only ever be a variant's FIRST movement.
   */
  INITIAL_STOCK = 'initial_stock',
  /** Purchase intake: units in at a stated unit cost (migration 0037). */
  STOCK_RECEIPT = 'stock_receipt',
  /** Stock-count correction, damage or loss, with an explicit cost policy. */
  INVENTORY_CORRECTION = 'inventory_correction',
  /**
   * Legacy stock valued for the first time. The ONLY reason whose `delta` may
   * be zero (`ck_movement_delta_non_zero`): value changes, quantity does not.
   */
  VALUATION_INITIALIZATION = 'valuation_initialization',
}

/**
 * Append-only physical-stock ledger. Never updated, never deleted.
 *
 * `balanceAfter` is the COMMITTED physical stock immediately after this
 * movement, read back inside the same transaction from the conditional UPDATE's
 * RETURNING clause. Realtime stock events publish this value -- never a value
 * recomputed in application memory from a pre-lock snapshot.
 */
@Entity('stock_movements')
@Index('idx_movement_variant_created', ['variantId', 'createdAt'])
@Index('idx_movement_order', ['orderId'])
export class StockMovement {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  variantId: number;

  @ManyToOne(() => ProductVariant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'variantId' })
  variant: ProductVariant;

  /** Negative for a decrement, positive for a restore. Never zero. */
  @Column({ type: 'int' })
  delta: number;

  /** Committed physical stock after applying `delta`. */
  @Column({ type: 'int' })
  balanceAfter: number;

  @Column({ type: 'enum', enum: StockMovementReason })
  reason: StockMovementReason;

  /**
   * The HUMAN explanation, beside the machine `reason` above — never instead
   * of it. Migration 0024.
   *
   * NULL for every system-generated movement (POS sale, online fulfilment,
   * cancellation/return restore) because no person authored a sentence for it,
   * and NULL on every row written before the column existed — those rows'
   * explanations, where any exist, are in `admin_audit_log`. A blank string is
   * refused by `chk_stock_movement_reason_text_not_blank`, so a non-NULL value
   * here always carries text somebody actually typed.
   */
  @Column({ type: 'varchar', length: 500, nullable: true })
  reasonText: string | null;

  @Column({ type: 'int', nullable: true })
  orderId: number | null;

  @Column({ type: 'int', nullable: true })
  actorUserId: number | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'actorUserId' })
  actorUser: User | null;

  /** Survives actor rename/deactivation/deletion. */
  @Column({ type: 'varchar', nullable: true })
  actorDisplaySnapshot: string | null;

  @Column({ type: 'int', nullable: true })
  branchId: number | null;

  /*
   * COST EVIDENCE (migration 0037). SUPER_ADMIN-ONLY — the delegable
   * `GET /admin/inventory/movements` list never selects these. NULL on every
   * row written before 0037; `costDelta`, `inventoryValueAfter`,
   * `unvaluedQuantityDelta` and `unvaluedQuantityAfter` are present together
   * on every row written since (`ck_movement_cost_evidence_complete`).
   */

  /** Unit purchase cost for a receipt / opening balance / valued correction. */
  @Column({
    type: 'bigint',
    nullable: true,
    transformer: rialStringTransformer,
  })
  unitCost: string | null;

  /** Signed change in the variant's inventory value. −COGS for a sale. */
  @Column({
    type: 'bigint',
    nullable: true,
    transformer: rialStringTransformer,
  })
  costDelta: string | null;

  @Column({
    type: 'bigint',
    nullable: true,
    transformer: rialStringTransformer,
  })
  inventoryValueAfter: string | null;

  @Column({ type: 'int', nullable: true })
  unvaluedQuantityDelta: number | null;

  @Column({ type: 'int', nullable: true })
  unvaluedQuantityAfter: number | null;

  /** Supplier invoice / delivery reference on a receipt. */
  @Column({ type: 'varchar', length: 120, nullable: true })
  supplierReference: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
