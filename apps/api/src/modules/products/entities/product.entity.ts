import { Category } from 'src/modules/categories/entities/category.entity';
import { User } from 'src/modules/user/entities/user.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinTable,
  ManyToMany,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ProductVariant } from './product-variant.entity';
import { CartItem } from 'src/modules/cart/entities/cart-item.entity';
import { ProductImage } from './product-image.entity';
import { ProductBranchVisibility } from './product-branch-visibility.entity';
import { bigIntTransformer } from 'src/common/transformers/bigint.transformer';
import type { BranchVisibilityMode } from 'src/common/catalogue/product-visibility';

@Entity('products')
export class Product {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ nullable: false })
  title: string;

  @Column({ nullable: false })
  description: string;

  @Column({ type: 'bigint', nullable: true, transformer: bigIntTransformer })
  basePrice: number;

  /**
   * «کد محصول» — the business identifier for this product FAMILY (0031).
   *
   * NOT the database id and never derived from it after creation: a
   * super_admin may retype it. `order_items` snapshots it at sale time, so
   * editing this changes the catalogue and never a historical receipt.
   *
   * Uniqueness and format are guaranteed by `uq_products_product_code` and
   * `ck_products_product_code_format`; the rules live in
   * `src/common/catalogue/product-codes.ts`.
   */
  @Column({ type: 'varchar', length: 32, unique: true })
  productCode: string;

  /**
   * WEBSITE CHANNEL (0030). One of the two INDEPENDENT visibility dimensions.
   *
   * `false` withdraws the product from every storefront surface — listing,
   * detail, search, category filter, cart add, quote and checkout — while
   * leaving it sellable at whatever tills `branchVisibility` allows.
   *
   * Only `super_admin` may change it. A delegated catalogue editor's new
   * product is born `false`.
   */
  @Column({ type: 'boolean', default: false })
  visibleOnSite: boolean;

  /**
   * RETAIL CHANNEL (0030). The other dimension.
   *
   *   'none'      no till sells it
   *   'all'       every ACTIVE branch sells it, INCLUDING ONES CREATED LATER
   *   'selected'  only the branches in `branchVisibility` rows
   *
   * `'all'` is a MODE, not a materialised row set, precisely so a branch
   * opened next month inherits it with no catalogue replay. See
   * `src/common/catalogue/product-visibility.ts`.
   *
   * THIS IS NOT PER-BRANCH STOCK. Every branch that can sell this product
   * sells out of the same single global `product_variants.stock`.
   */
  @Column({
    type: 'enum',
    enum: ['none', 'all', 'selected'],
    enumName: 'products_branchvisibility_enum',
    default: 'none',
  })
  branchVisibility: BranchVisibilityMode;

  /**
   * The selected branches, meaningful ONLY when `branchVisibility` is
   * `'selected'`. A deferrable constraint trigger makes any other combination
   * impossible to commit, and the composite primary key makes a duplicate
   * mapping impossible.
   */
  @OneToMany(() => ProductBranchVisibility, (row) => row.product, {
    cascade: false,
  })
  branchVisibilityRows: ProductBranchVisibility[];

  @ManyToMany(() => Category, (category) => category.products)
  @JoinTable({
    name: 'product_category',
    joinColumn: { name: 'product_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'category_id', referencedColumnName: 'id' },
  })
  categories: Category[];

  @ManyToMany(() => User, (user) => user.products)
  @JoinTable({
    name: 'bookmark_products',
    joinColumn: { name: 'product_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'user_id', referencedColumnName: 'id' },
  })
  users: User[];

  // @ManyToMany(() => User, (user) => user.basket_items)
  // baskets: User[];

  @OneToMany(() => CartItem, (cartItem) => cartItem.product)
  cartItems: CartItem[];

  @OneToMany(() => ProductVariant, (variant) => variant.product, {
    cascade: true,
  })
  variants: ProductVariant[];

  @OneToMany(() => ProductImage, (image) => image.product)
  images: ProductImage[];

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
