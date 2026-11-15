import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One administrative act. Append-only, enforced by the database trigger
 * `trg_admin_audit_log_append_only` (migration 0022).
 *
 * THERE IS NO FOREIGN KEY ON `actorUserId`, deliberately and for the same
 * reason `payment_actions` has none: `ON DELETE SET NULL` is an UPDATE, and an
 * UPDATE against an append-only table is exactly what the trigger forbids.
 * Deleting a staff member would therefore either rewrite history or fail with
 * a trigger error. The id joins while the account exists;
 * `actorDisplaySnapshot` is the part that must outlive it, and it is NOT NULL.
 */
@Entity('admin_audit_log')
@Index('idx_admin_audit_created', ['createdAt', 'id'])
@Index('idx_admin_audit_target', ['targetType', 'targetId', 'createdAt'])
@Index('idx_admin_audit_actor', ['actorUserId', 'createdAt'])
@Index('idx_admin_audit_action', ['action', 'createdAt'])
export class AdminAuditLog {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'int', nullable: true })
  actorUserId: number | null;

  /** Survives rename, deactivation and deletion of the acting administrator. */
  @Column({ type: 'varchar', length: 160 })
  actorDisplaySnapshot: string;

  /** Which surface the act was performed from. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  actorAudience: string | null;

  /** A member of `AuditAction`. */
  @Column({ type: 'varchar', length: 64 })
  action: string;

  /** `user`, `role`, `branch`, `variant`, `order`, `category`, `attribute`… */
  @Column({ type: 'varchar', length: 32 })
  targetType: string;

  /** Stringified so one column serves numeric ids and composite keys alike. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  targetId: string | null;

  /** Human label of the target AS IT WAS, so a later rename cannot rewrite it. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  targetLabel: string | null;

  /**
   * `{ before, after }`, built from an EXPLICIT ALLOW-LIST of scalar fields.
   * Never a spread DTO — that is how a plaintext password ends up in an audit
   * log on the first password-reset call.
   */
  @Column({ type: 'jsonb', nullable: true })
  summary: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  requestId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
