import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Role } from 'src/modules/auth/entities/role.entity';
import { RefreshToken } from 'src/modules/auth/entities/refresh-token.entity';
import { Branch } from 'src/modules/branch/entities/branch.entity';
import { Exclude } from 'class-transformer';
import { Product } from 'src/modules/products/entities/product.entity';
import { Address } from 'src/modules/address/entities/address.entity';
import { CartItem } from 'src/modules/cart/entities/cart-item.entity';
import { Order } from 'src/modules/orders/entities/order.entity';

@Entity({ name: 'users' })
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true, nullable: true })
  mobile: string;

  @Column({ unique: true, nullable: true })
  username: string;

  @Column({ nullable: true })
  @Exclude()
  password: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToMany(() => Role)
  @JoinTable({ name: 'user_roles' })
  roles: Role[];

  @OneToMany(() => Address, (address) => address.user)
  addresses: Address[];

  @OneToMany(() => CartItem, (cartItem) => cartItem.user)
  cartItems: CartItem[];

  @OneToMany(() => Order, (order) => order.user)
  orders: Order[];

  @OneToMany(() => RefreshToken, (refreshToken) => refreshToken.user)
  refreshToken: RefreshToken[];

  @ManyToOne(() => Branch, { nullable: true })
  @JoinColumn({ name: 'branchId' })
  branch: Branch | null;

  @ManyToMany(() => Product, (product) => product.users)
  products: Product[];

  @Column({ nullable: true })
  branchId: number;

  /**
   * Soft deactivation. Staff who have sales can never be hard-deleted
   * (`orders.cashierUserId` is ON DELETE RESTRICT), so retiring an employee is
   * done by stamping this column. A deactivated user must fail login and must
   * not be issued or allowed to keep a session (enforced in workstream A's
   * auth code).
   */
  @Column({ type: 'timestamptz', nullable: true })
  deactivatedAt: Date | null;

  /**
   * Last time the password changed. Auth compares it against an access token's
   * `iat` so that changing a password invalidates already-issued sessions.
   */
  @Column({ type: 'timestamptz', nullable: true })
  passwordChangedAt: Date | null;

  /**
   * An administrator issued a TEMPORARY password (migration 0023). Until the
   * user replaces it, `JwtAuthGuard` refuses every route that is not marked
   * `@AllowPasswordChangePending()`, so the temporary value is live for exactly
   * one sign-in and the change that clears this flag.
   *
   * Never set by a self-service password change — only by the administrator
   * reset path, which stamps `passwordChangedAt` at the same time so every
   * session the user already held dies in every audience.
   */
  @Column({ type: 'boolean', default: false })
  mustChangePassword: boolean;

  /**
   * THE SESSION EPOCH (migration 0027).
   *
   * Every access and refresh token carries this value as its `pv` claim, and a
   * verifier admits the token only while the two are EQUAL. Changing a
   * password — self-service or administrator reset — increments it inside the
   * database, so every token from the old epoch stops working at the next
   * request and a token minted afterwards works immediately.
   *
   * IT REPLACED A TIMESTAMP COMPARISON. `passwordChangedAt` (above) was the
   * old lever: a token was rejected when its `iat` predated the column. `iat`
   * is in whole SECONDS and the column is microseconds, so a token minted in
   * the same second as a change could not be ordered against it, and the
   * fail-closed resolution rejected a legitimate login once before letting it
   * through on retry. An integer compared for equality has no such tie.
   *
   * NEVER WRITTEN BY ASSIGNING A COMPUTED VALUE. It is always
   * `"passwordVersion" = "passwordVersion" + 1` in SQL, under the row's own
   * lock, so two concurrent password changes cannot both read 4 and both
   * write 5.
   *
   * -------------------------------------------------------------------------
   * `update: false` IS LOAD-BEARING, NOT TIDINESS.
   *
   * TypeORM's `save(entity)` computes its SET list by diffing the in-memory
   * entity against the row AS IT IS WHEN THE SAVE RUNS — not against the row
   * as it was when the entity was loaded. So a column that changed in the
   * DATABASE between the load and the save looks like a change the caller
   * made, and is written back at the entity's STALE value.
   *
   * That is a silent clobber of somebody else's password change. Measured, on
   * this schema:
   *
   *   T1 loads the user (passwordVersion = 1)
   *   T2 changes the password           → database says 2
   *   T1 saves an unrelated field       → database says 1 again
   *
   * The sessions T2 had just killed would come back to life, because their
   * tokens carry `pv = 1` and the column says 1 once more. No error, no
   * conflict, nothing in a log.
   *
   * `update: false` removes the possibility rather than relying on every
   * present and future caller to avoid it: TypeORM never includes this column
   * in an UPDATE, so the SQL increment is the only thing that can move it.
   * INSERT is unaffected, so a newly created account still starts at the
   * column default.
   */
  @Column({ type: 'int', default: 1, update: false })
  passwordVersion: number;

  get isActive(): boolean {
    return this.deactivatedAt === null || this.deactivatedAt === undefined;
  }

  get identifier(): string {
    return this.username ?? this.mobile;
  }
}
