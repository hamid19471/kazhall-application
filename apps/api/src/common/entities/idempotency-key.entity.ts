import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export enum IdempotencyScope {
  POS_SALE = 'pos_sale',
  ONLINE_ORDER = 'online_order',
  /**
   * Declared by migration 0002 and STILL UNUSED by any code path in `src/`.
   * `PaymentService.Verify` is made idempotent structurally instead, by
   * `uq_payment_track_id` plus the guarded conditional settle — see the Payment
   * entity. Kept because removing an enum member from a live Postgres type is a
   * migration with no upside.
   */
  PAYMENT_VERIFY = 'payment_verify',
  /**
   * Every mutating endpoint under `/payment/admin/reconciliation` (migration
   * 0018). Its own namespace on purpose: these actions move money and stock,
   * and sharing a namespace with a different operation would let one
   * operation's key collide with another's.
   */
  PAYMENT_RECONCILIATION = 'payment_reconciliation',
  /*
   * Purchase-cost accounting (migration 0037). One namespace per operation so
   * a receipt key can never replay as a correction, and vice versa.
   */
  STOCK_RECEIPT = 'stock_receipt',
  INVENTORY_CORRECTION = 'inventory_correction',
  INVENTORY_VALUATION = 'inventory_valuation',
  ORDER_LINE_ADJUSTMENT = 'order_line_adjustment',
}

export enum IdempotencyStatus {
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
}

/**
 * Request-level replay protection.
 *
 * Protocol (see IdempotencyService):
 *  1. INSERT (scope, key, requestHash, IN_PROGRESS). The UNIQUE constraint is
 *     the concurrency primitive -- a duplicate INSERT raises 23505 rather than
 *     racing.
 *  2. On 23505: load the existing row.
 *       - requestHash differs      -> 409 IDEMPOTENCY_KEY_REUSED
 *       - status IN_PROGRESS       -> 409 IDEMPOTENCY_REQUEST_IN_PROGRESS
 *       - status COMPLETED         -> replay the stored response verbatim
 *  3. On success: UPDATE to COMPLETED with the response snapshot.
 *
 * The row is written in the SAME transaction as the business effect, so a
 * rolled-back sale also rolls back its key and the client may safely retry.
 */
@Entity('idempotency_keys')
@Unique('uq_idempotency_scope_key', ['scope', 'key'])
@Index('idx_idempotency_created', ['createdAt'])
export class IdempotencyKey {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'enum', enum: IdempotencyScope })
  scope: IdempotencyScope;

  @Column({ type: 'varchar', length: 255 })
  key: string;

  /** sha256 of the canonicalised request payload. */
  @Column({ type: 'varchar', length: 64 })
  requestHash: string;

  @Column({
    type: 'enum',
    enum: IdempotencyStatus,
    default: IdempotencyStatus.IN_PROGRESS,
  })
  status: IdempotencyStatus;

  @Column({ type: 'int', nullable: true })
  responseStatus: number | null;

  /**
   * The stored response, replayed verbatim to a retry.
   *
   * `unknown`, not `unknown | null`: the union was redundant (`unknown` already
   * admits null) and it read as a promise that the column is nullable in a
   * useful way — it is not, since a caller must narrow `unknown` before using
   * it either way. The NULL is still real at the database level, for a row that
   * is claimed but not yet completed.
   */
  @Column({ type: 'jsonb', nullable: true })
  responseBody: unknown;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;
}
