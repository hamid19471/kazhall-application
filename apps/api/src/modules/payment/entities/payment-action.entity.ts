import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { bigIntTransformer } from 'src/common/transformers/bigint.transformer';
import { Order } from 'src/modules/orders/entities/order.entity';
import { Payment } from './payment.entity';

/**
 * What an operator did to a reconciliation case. One member per mutation
 * endpoint under `/payment/admin/reconciliation`.
 *
 * Every member describes an ACTION A HUMAN TOOK, never something the system
 * inferred. Nothing in this module ever writes one of these rows on its own.
 */
export enum PaymentActionType {
  /** Re-drove phase 2 through the unchanged `FulfilmentService.drive()`. */
  RETRY_FULFILMENT = 'retry_fulfilment',
  /**
   * Recorded that money must go back. NOTHING HAS BEEN REFUNDED by this
   * action — it is the obligation, not the payment.
   */
  MARK_REFUND_REQUIRED = 'mark_refund_required',
  /**
   * Confirmed a refund the operator completed WITH THE PROVIDER, quoting its
   * reference. This is the only action that may say a refund happened, and it
   * can only ever be a report of something that happened elsewhere.
   */
  CONFIRM_EXTERNAL_REFUND = 'confirm_external_refund',
  /** Decided to keep the paid order open and wait for stock. */
  MARK_BACKORDER = 'mark_backorder',
  /** Closed the case with no money moving in either direction. */
  RESOLVE_NO_ACTION = 'resolve_no_action',
}

/**
 * ===========================================================================
 * APPEND-ONLY AUDIT OF EVERY MANUAL RECONCILIATION DECISION
 * ===========================================================================
 *
 * Modelled on `order_actions` — same shape, same discipline — because the two
 * answer the same kind of question about different subjects: `order_actions`
 * records what happened to the GOODS/commercial state, this records what an
 * operator decided about the MONEY.
 *
 * APPEND-ONLY IS A DATABASE GUARANTEE. Migration 0018 installs
 * `trg_payment_actions_append_only`, a `BEFORE UPDATE OR DELETE` trigger that
 * raises. TypeORM cannot rewrite one of these rows even by accident, and
 * neither can a future code path, a bad migration, or somebody at a psql
 * prompt. There is intentionally no repository method anywhere that updates
 * this table.
 *
 * NO FOREIGN KEY ON `actorUserId`, AND THAT IS DELIBERATE. `order_actions`
 * declares `ON DELETE SET NULL`, which is an UPDATE — and the append-only
 * trigger must forbid UPDATEs. Deleting a staff member would then either
 * rewrite the audit trail or fail. `actorDisplaySnapshot` is NOT NULL and is
 * the record that has to survive; `actorUserId` is a join hint that is allowed
 * to point at a row that no longer exists.
 *
 * WHY THE FROM/TO TRIPLES. A reconciliation action can move three independent
 * things at once — the receipt's `payment.status`, the order's
 * `orders.status`, and the case's `orders."reconciliationState"` — and an
 * auditor needs to see all three as they were and as they became. Reading them
 * back off the current rows is exactly what an audit trail exists to avoid.
 */
@Entity('payment_actions')
@Index('idx_payment_action_order', ['orderId', 'createdAt'])
@Index('idx_payment_action_payment', ['paymentId'])
@Index('idx_payment_action_actor', ['actorUserId'])
export class PaymentAction {
  @PrimaryGeneratedColumn()
  id: number;

  /** The case. A reconciliation decision is always about one order. */
  @Column({ type: 'int' })
  orderId: number;

  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'orderId' })
  order: Order;

  /**
   * The specific receipt the action was about, when there was one. NULL for
   * order-level decisions (retry fulfilment, back-order, resolve) that are not
   * about a particular payment attempt.
   */
  @Column({ type: 'int', nullable: true })
  paymentId: number | null;

  @ManyToOne(() => Payment, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'paymentId' })
  payment: Payment | null;

  @Column({ type: 'enum', enum: PaymentActionType })
  action: PaymentActionType;

  @Column({ type: 'varchar', length: 32, nullable: true })
  fromPaymentStatus: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  toPaymentStatus: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  fromOrderStatus: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  toOrderStatus: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  fromReconciliationState: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  toReconciliationState: string | null;

  /** May point at a user row that has since been deleted. See the class note. */
  @Column({ type: 'int', nullable: true })
  actorUserId: number | null;

  /** Survives rename/deactivation/deletion of the acting operator. */
  @Column({ type: 'varchar' })
  actorDisplaySnapshot: string;

  /**
   * MANDATORY. Every reconciliation endpoint requires a non-empty reason from
   * the operator; "why" is the entire point of a manual decision and a nullable
   * column would make it optional in practice.
   */
  @Column({ type: 'text' })
  reason: string;

  /**
   * The PROVIDER'S reference for an externally completed refund — the number an
   * operator quotes when the customer asks. NULL for every action that did not
   * move money with a provider.
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  externalReference: string | null;

  /**
   * INTEGER RIAL. The expected refund amount on `mark_refund_required`, the
   * confirmed refund amount on `confirm_external_refund`, NULL otherwise.
   *
   * `bigint` through `bigIntTransformer`, like every other money column: this is
   * a figure that is quoted back to an operator and it must never be rounded.
   */
  @Column({ type: 'bigint', nullable: true, transformer: bigIntTransformer })
  amount: number | null;

  /**
   * The `Idempotency-Key` the action was taken under, so a replayed request and
   * the original are traceable to each other from the audit trail alone.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  idempotencyKey: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
