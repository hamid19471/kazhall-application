import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
} from 'typeorm';
import { Role } from './role.entity';
import { Permission } from './permission.entity';
import { User } from 'src/modules/user/entities/user.entity';

/**
 * One grant: this role confers this capability.
 *
 * A COMPOSITE PRIMARY KEY on (`roleId`, `permissionId`) rather than a surrogate
 * id, so "granted twice" is not representable. Re-granting is an
 * `ON CONFLICT DO NOTHING`, which makes the whole replace-the-grant-set
 * operation safely retryable.
 *
 * `grantedByUserId` / `grantedAt` are kept here IN ADDITION to the
 * `admin_audit_log` row, not instead of it: the audit log answers "what
 * happened", this answers "why does this row exist right now" without a scan.
 * The FK is `ON DELETE SET NULL` so retiring the granting administrator never
 * blocks, and never erases the grant.
 */
@Entity('role_permissions')
export class RolePermission {
  @Column({ type: 'int', primary: true })
  roleId: number;

  @ManyToOne(() => Role, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'roleId' })
  role: Role;

  @Index('idx_role_permissions_permission')
  @Column({ type: 'int', primary: true })
  permissionId: number;

  @ManyToOne(() => Permission, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'permissionId' })
  permission: Permission;

  @Column({ type: 'int', nullable: true })
  grantedByUserId: number | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'grantedByUserId' })
  grantedByUser: User | null;

  @CreateDateColumn({ type: 'timestamptz' })
  grantedAt: Date;
}
