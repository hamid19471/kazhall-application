import { Order } from 'src/modules/orders/entities/order.entity';
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
import { bigIntTransformer } from 'src/common/transformers/bigint.transformer';
import {
  PaymentReconciliationReason,
  PaymentStatusEnum,
} from '../enums/payment-status-enum';

/**
 * A payment attempt.
 *
 * THREE SEPARATE CONCERNS, DELIBERATELY NOT FUSED (FINDING E)
 * ----------------------------------------------------------
 *  1. GATEWAY CONFIRMATION is an objective external fact. Every verified
 *     receipt is persisted with an explicit, honest state and a `paid_at` taken
 *     from the DATABASE clock: `success` when it settled its order,
 *     `confirmed_unapplied` when it did not. A confirmed receipt is NEVER left
 *     `pending` — that claimed the customer had not paid, and `Start()` would
 *     later sweep the row to `failed`, erasing the only local record of real
 *     money.
 *
 *  2. RECONCILIATION is a separate, queryable state:
 *     `requires_reconciliation` + `reconciliation_reason` + `reconciled_at`,
 *     with `ref_number` and `gateway_amount` as the bookkeeping an operator
 *     needs. NO AUTOMATIC FINANCIAL ACTION IS EVER TAKEN — no refunds, no
 *     credits. Owner decisions D-2/D-3 are still open.
 *
 *  3. EXACTLY-ONCE FULFILMENT is enforced at the ORDER/FULFILMENT layer
 *     (FulfilmentService: `FOR UPDATE SKIP LOCKED` claim + guarded conditional
 *     UPDATE), never by hiding a receipt.
 *
 * `uq_payment_one_success_per_order` remains the structural guarantee that two
 * attempts for the same order can never BOTH settle it: the second successful
 * UPDATE raises 23505 and the service records that attempt as
 * `confirmed_unapplied` instead of fulfilling twice.
 *
 * `uq_payment_track_id` makes `track_id` the safe idempotency key for the
 * verify callback.
 *
 * ==========================================================================
 * RECONCILIATION QUERY (the one an operator actually runs)
 * ==========================================================================
 * Every confirmed receipt that did not settle its order, newest first:
 *
 *   SELECT p.id,
 *          p."orderId",
 *          p.track_id,
 *          p.ref_number,
 *          p.amount            AS recorded_rial,
 *          p.gateway_amount    AS gateway_rial,
 *          p.paid_at,
 *          p.reconciliation_reason,
 *          o.status::text      AS order_status
 *     FROM payment p
 *     JOIN orders o ON o.id = p."orderId"
 *    WHERE p.requires_reconciliation
 *      AND p.reconciled_at IS NULL
 *    ORDER BY p.paid_at DESC;
 *
 * Narrower forms:
 *   -- duplicate receipts only
 *   ... AND p.status = 'confirmed_unapplied'
 *       AND p.reconciliation_reason = 'duplicate_confirmed'
 *   -- money confirmed against an order that was not payable
 *   ... AND p.reconciliation_reason IN ('order_not_payable',
 *                                       'late_confirmation_unapplied')
 *   -- MONEY RECEIVED THAT DID NOT CHECK OUT AGAINST THE ORDER (migration 0016).
 *   -- These orders are still PENDING and NOTHING HAS SHIPPED for them, which
 *   -- is the point: an amount-discrepant receipt used to settle the order and
 *   -- let phase 2 consume stock, so the flag was raised only after the goods
 *   -- were gone.
 *   ... AND p.reconciliation_reason IN ('amount_mismatch',   -- over/underpaid
 *                                       'amount_missing',    -- gateway said nothing
 *                                       'amount_invalid')    -- gateway said nonsense
 *   -- with p.amount (ours), p.gateway_amount (theirs) and p.gateway_amount_raw
 *   -- (theirs verbatim, when unusable) as the evidence.
 *
 * INVARIANT ADDED BY MIGRATION 0016: a row written by the current code can no
 * longer be `status='success'` with an amount-verification reason. `success`
 * now means the gateway's amount was PRESENT, VALID and EQUAL. Rows written by
 * the OLD code may still carry that combination and are left exactly as they
 * are — a confirmation is never rewritten — so an operator query must not
 * assume the combination is impossible historically.
 *
 * The OLD query documented here was
 *   `WHERE p.status='pending' AND p.track_id IS NOT NULL AND o.status='paid'`
 * and it was wrong twice over: it could not distinguish a genuinely unfinished
 * attempt from a confirmed duplicate, and the rows it looked for stopped
 * existing as soon as `Start()` swept them to `failed`.
 * ==========================================================================
 */
@Entity('payment')
// Index names match migrations 0007 / 0010 exactly, so entity metadata and the
// migrated schema cannot drift apart.
@Index('uq_payment_one_success_per_order', ['orderId'], {
  unique: true,
  where: `status = 'success'`,
})
@Index('uq_payment_track_id', ['track_id'], {
  unique: true,
  where: `"track_id" IS NOT NULL`,
})
@Index('idx_payment_order_status', ['orderId', 'status'])
@Index('idx_payment_requires_reconciliation', ['orderId'], {
  where: `"requires_reconciliation"`,
})
@Index('idx_payment_reverify_due', ['next_reverify_at'], {
  where: `"track_id" IS NOT NULL AND status IN ('pending', 'failed')`,
})
export class Payment {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Order, (order) => order.payments, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'orderId' })
  order: Order;

  @Column({ type: 'int' })
  orderId: number;

  @Column({
    type: 'varchar',
    nullable: true,
  })
  track_id: string | null;

  /** INTEGER RIAL (docs/ARCHITECTURE.md section 0). What WE asked for. */
  @Column({ type: 'bigint', transformer: bigIntTransformer })
  amount: number;

  /**
   * INTEGER RIAL as reported by the GATEWAY on verification, when it reports
   * one. Kept separate from `amount` on purpose: an under/overpayment is a
   * reconciliation fact, and overwriting our own figure with the gateway's
   * would destroy the evidence of the discrepancy.
   */
  @Column({ type: 'bigint', nullable: true, transformer: bigIntTransformer })
  gateway_amount: number | null;

  /**
   * The gateway's reported amount VERBATIM, as text, when it could not be
   * stored as an integer Rial amount (migration 0016).
   *
   * `gateway_amount` is `bigint`, so a gateway that answers `NaN`, `-1` or
   * `2000000.5` has nowhere to be recorded — and discarding it would destroy
   * the only evidence of what the gateway actually said, which is precisely
   * what an operator needs to chase the discrepancy. NULL for every receipt
   * whose amount was usable (including a plain over/underpayment, where the
   * figure lives in `gateway_amount`).
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  gateway_amount_raw: string | null;

  /** The gateway's own reference for the receipt. What an operator quotes. */
  @Column({ type: 'varchar', nullable: true })
  ref_number: string | null;

  @Column({
    type: 'enum',
    enum: PaymentStatusEnum,
    default: PaymentStatusEnum.PENDING,
  })
  status: PaymentStatusEnum;

  /**
   * Set from `now()` (the DATABASE clock) for EVERY confirmed receipt —
   * `success` and `confirmed_unapplied` alike. Never from a JS Date: this is a
   * naive `timestamp` column and node-postgres serialises a Date with the
   * client's offset, which Postgres then discards.
   */
  @Column({
    type: 'timestamp',
    nullable: true,
  })
  paid_at: Date | null;

  /** True while this receipt still needs a human decision. */
  @Column({ type: 'boolean', default: false })
  requires_reconciliation: boolean;

  /** Mirrors CHECK `ck_payment_reconciliation_reason` (migration 0010). */
  @Column({ type: 'varchar', nullable: true })
  reconciliation_reason: PaymentReconciliationReason | null;

  /** Set by a human/back-office process when the receipt has been dealt with. */
  @Column({ type: 'timestamp', nullable: true })
  reconciled_at: Date | null;

  // ---- re-verification bookkeeping (PaymentReverificationService) ----------
  /** How many times the gateway has been re-asked about this attempt. */
  @Column({ type: 'int', default: 0 })
  reverify_attempts: number;

  @Column({ type: 'timestamptz', nullable: true })
  last_reverified_at: Date | null;

  /** NULL means "eligible now"; the sweep leases rows by pushing this out. */
  @Column({ type: 'timestamptz', nullable: true })
  next_reverify_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
