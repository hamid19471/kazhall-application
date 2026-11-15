import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A named bundle of permissions.
 *
 * WHAT CHANGED. A role used to be a bare NAME that `@Roles(...)` matched
 * against, which made the catalogue a fixed list of three and made "create a
 * role" meaningless — a new name authorised nothing, because no guard
 * mentioned it. Authorisation now hangs off `role_permissions`, so a role
 * created through the API is a first-class thing: it grants exactly the
 * capabilities an administrator ticked, and every guard that matters reads
 * those capabilities rather than the name.
 *
 * `isSystem` marks the three roles the application's own invariants are
 * written against (`super_admin`, `sale`, `site`). They cannot be renamed,
 * deleted or deactivated: `super_admin` is the administrator mutex
 * (`role-safety.ts`), and `sale` / `site` are the shapes the seeder and the
 * audience rules assume. Their PERMISSION SETS are likewise owned by the
 * catalogue sync, not by the access-control screen.
 *
 * `isActive` is how a custom role is retired WITHOUT stripping it from the
 * users who hold it: an inactive role contributes nothing to a user's
 * effective permissions (the effective-permission query joins on
 * `roles."isActive" = true`), so reactivating it restores exactly the access
 * it had. Deleting it would lose the assignments and could not be undone.
 */
@Entity('roles')
export class Role {
  @PrimaryGeneratedColumn()
  id: number;

  /**
   * The machine key. Unique, and for system roles it is what
   * `UserRoleEnum` and `role-safety.ts` match on — matching on NAME rather
   * than id is deliberate, because `roles.id` differs per environment.
   */
  @Column({ unique: true })
  name: string;

  /** What an administrator reads in the role list. Falls back to `name`. */
  @Column({ type: 'varchar', length: 80, nullable: true })
  titleFa: string | null;

  @Column({ type: 'varchar', length: 400, nullable: true })
  description: string | null;

  /** Built-in. Protected from rename, deletion and deactivation. */
  @Column({ type: 'boolean', default: false })
  isSystem: boolean;

  /** An inactive role grants nothing while keeping its assignments. */
  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
