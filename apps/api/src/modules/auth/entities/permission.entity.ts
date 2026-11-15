import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One delegatable capability.
 *
 * The ROWS are SYSTEM REFERENCE DATA owned by MIGRATIONS, not user data and
 * not application state. Nothing in the API creates, renames, retires or
 * deletes a permission: a code no guard checks authorises nothing, a renamed
 * code silently changes who can do what, and a deleted code cascades through
 * `role_permissions` and strips the capability from every custom role that
 * held it. `PermissionCatalogIntegrityService` compares this table with
 * `permissions/permission.catalog.ts` at boot and refuses to start the process
 * if they differ — a read-only check that writes nothing.
 *
 * The table exists (rather than the catalogue living only in code) for one
 * reason: `role_permissions` needs something to point at, and a foreign key is
 * what makes "this role grants a capability that no longer exists" impossible
 * rather than merely unlikely.
 */
@Entity('permissions')
export class Permission {
  @PrimaryGeneratedColumn()
  id: number;

  /**
   * The stable machine key, e.g. `orders.status.update`. Written into
   * `@RequirePermissions(...)` call sites, so it is part of the source code as
   * much as of the schema.
   */
  @Column({ type: 'varchar', length: 64, unique: true })
  code: string;

  /** Which section of the access-control screen this appears under. */
  @Index('idx_permissions_group')
  @Column({ type: 'varchar', length: 48 })
  groupKey: string;

  /** What an administrator reads. Never the code. */
  @Column({ type: 'varchar', length: 160 })
  labelFa: string;

  /** The consequence sentence, reused verbatim in the confirmation dialog. */
  @Column({ type: 'text' })
  descriptionFa: string;

  /** `normal` | `sensitive` | `critical`. Drives the confirmation the UI asks for. */
  @Column({ type: 'varchar', length: 16, default: 'normal' })
  risk: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  /**
   * When this capability stopped granting anything, or NULL while it still
   * does.
   *
   * Set by a MIGRATION, never by the application. Retiring rather than
   * deleting is what keeps the decision reversible and auditable: the
   * `role_permissions` rows survive, so "which roles used to hold this?" is
   * still answerable, and clearing the column restores exactly the access
   * those roles had. A DELETE would cascade and leave no record the grant had
   * ever existed.
   *
   * Every effective-permission query filters on `retiredAt IS NULL`, so a
   * retired code contributes nothing from the moment the migration lands.
   */
  @Column({ type: 'timestamptz', nullable: true })
  retiredAt: Date | null;
}
