import {
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

import { Branch } from 'src/modules/branch/entities/branch.entity';
import { Product } from './product.entity';

/**
 * WHICH BRANCHES SELL THIS PRODUCT — meaningful only when the product's
 * `branchVisibility` is `'selected'` (migration 0030).
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT PER-BRANCH STOCK.
 * ---------------------------------------------------------------------------
 * A row here says "this till may sell this product". It does NOT give that
 * branch its own inventory: `product_variants.stock` remains one global number
 * that every listed branch draws from, and two of them racing for the last
 * unit resolve exactly as two cashiers in one branch do. Nothing in this table
 * is ever consulted by the availability projection.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SCHEMA GUARANTEES, SO THE SERVICE DOES NOT HAVE TO REMEMBER
 * ---------------------------------------------------------------------------
 *   • A duplicate mapping is IMPOSSIBLE — composite PRIMARY KEY
 *     (`productId`, `branchId`), not a de-duplication pass in TypeScript.
 *   • Rows cannot exist unless the parent's mode is `'selected'`, and mode
 *     `'selected'` cannot exist without at least one row — a DEFERRABLE
 *     constraint trigger checks both directions at COMMIT, so the two-statement
 *     transition ("set the mode, then insert the rows") is legal while the
 *     invalid END STATE is not.
 *   • A deleted product or branch cannot leave an orphan — both foreign keys
 *     are `ON DELETE CASCADE`.
 *
 * ---------------------------------------------------------------------------
 * DEACTIVATION DOES NOT DELETE
 * ---------------------------------------------------------------------------
 * Deactivating a branch leaves its rows untouched. The branch stops exposing
 * products because the branch is resolved and checked for `isActive` before
 * this table is ever consulted — which is precisely what makes REACTIVATION
 * restore the previous visibility with no administrative replay.
 */
@Entity({ name: 'product_branch_visibility' })
@Index('idx_pbv_branch', ['branchId'])
export class ProductBranchVisibility {
  @PrimaryColumn({ type: 'int' })
  productId: number;

  @PrimaryColumn({ type: 'int' })
  branchId: number;

  @ManyToOne(() => Product, (product) => product.branchVisibilityRows, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'productId' })
  product: Product;

  @ManyToOne(() => Branch, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'branchId' })
  branch: Branch;

  /** When the branch was added to this product's selection. Audit colour only. */
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
