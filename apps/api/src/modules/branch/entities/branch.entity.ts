import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from 'src/modules/user/entities/user.entity';

@Entity({ name: 'branches' })
export class Branch {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  name: string;

  @Column({ nullable: true, default: null })
  address: string;

  @Column({ nullable: true, default: null })
  phone: string;

  /**
   * BRANCH LIFECYCLE (migration 0021).
   *
   * A closed shop is DEACTIVATED, never deleted: `users.branchId` and
   * `orders.branchId` both point here, so a hard delete either destroys the
   * answer to "which shop sold this" or surfaces the foreign-key restriction
   * as a 500. Deactivating keeps every row and every `branchNameSnapshot`
   * meaningful while taking the branch out of the selling flow — a cashier
   * assigned to an inactive branch is refused at `POST /orders/pos`.
   *
   * Staff assignments are deliberately NOT cascaded away when this flips.
   * Reassigning them is an explicit administrative act surfaced by the branch
   * screen, not a silent side effect.
   */
  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @OneToMany(() => User, (user) => user.branch)
  users: User[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
