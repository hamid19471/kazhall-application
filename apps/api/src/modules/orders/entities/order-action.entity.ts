import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Order } from './order.entity';
import { User } from 'src/modules/user/entities/user.entity';

export enum OrderActionType {
  STATUS_CHANGE = 'status_change',
  VOID = 'void',
  RETURN = 'return',
  REFUND = 'refund',
}

/**
 * Append-only audit of everything that happened to an order AFTER creation.
 *
 * The original seller lives on `orders.cashierUserId` and is NEVER overwritten.
 * When a different employee voids or adjusts a sale, that fact is recorded here
 * with its own actor and timestamp, so "who sold it" and "who cancelled it"
 * remain independently answerable.
 */
@Entity('order_actions')
@Index('idx_order_action_order', ['orderId', 'createdAt'])
@Index('idx_order_action_actor', ['actorUserId'])
export class OrderAction {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  orderId: number;

  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'orderId' })
  order: Order;

  @Column({ type: 'enum', enum: OrderActionType })
  action: OrderActionType;

  @Column({ type: 'varchar', nullable: true })
  fromStatus: string | null;

  @Column({ type: 'varchar', nullable: true })
  toStatus: string | null;

  @Column({ type: 'int', nullable: true })
  actorUserId: number | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'actorUserId' })
  actorUser: User | null;

  /** Survives rename/deactivation/deletion of the acting staff member. */
  @Column({ type: 'varchar' })
  actorDisplaySnapshot: string;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
