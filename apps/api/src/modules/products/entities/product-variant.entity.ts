import {
  Column,
  Entity,
  Index,
  JoinTable,
  ManyToMany,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Product } from './product.entity';
import { ProductAttributeValue } from './product-attribute-value.entity';
import { bigIntTransformer } from 'src/common/transformers/bigint.transformer';
import { rialStringTransformer } from 'src/common/transformers/rial-string.transformer';

@Entity('product_variants')
@Index('idx_variant_product_active', ['product', 'isActive'])
// Index name matches migration 0012 exactly, so entity metadata and the
// migrated schema cannot drift apart.
@Index('uq_variant_one_default_per_product', ['product'], {
  unique: true,
  where: `"isDefault" = true`,
})
export class ProductVariant {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'bigint', nullable: true, transformer: bigIntTransformer })
  price: number = 0;

  @Column({ default: 0 })
  stock: number;

  /*
   * ==========================================================================
   * THE VALUATION POOL (migration 0037, docs/PURCHASE-COST-ACCOUNTING.md §3).
   *
   * SUPER_ADMIN-ONLY DATA. No product, inventory, catalogue, cart, order or
   * realtime projection reads these three columns; they are served only by
   * `/admin/costing/*`. Every projection in this codebase is an explicit
   * allow-list, so adding a field there is a deliberate act — do not.
   *
   * Written ONLY by `InventoryService.writePool`, which stores what
   * `valuation.ts` computed, by compare-and-set under the variant row lock.
   * The CHECK constraints refuse any other combination.
   * ==========================================================================
   */

  /** Units whose purchase cost is UNKNOWN (legacy stock). Never valued at 0. */
  @Column({ type: 'int', default: 0 })
  unvaluedQuantity: number;

  /** Exact Rial value of the `stock − unvaluedQuantity` valued units. */
  @Column({ type: 'bigint', default: 0, transformer: rialStringTransformer })
  inventoryCostValue: string;

  /** Last receipt's unit cost, or the remembered default. Display/prefill only. */
  @Column({
    type: 'bigint',
    nullable: true,
    transformer: rialStringTransformer,
  })
  lastPurchaseUnitCost: string | null;

  /*
   * `costStatus` is a GENERATED column ('valued' | 'unvalued') and is
   * deliberately NOT mapped here, so no TypeORM write can ever name it.
   */

  @Column({ unique: true })
  sku: string;

  /**
   * «کد گونه» — the business identifier for THIS EXACT variant (0031).
   *
   * DISTINCT FROM `sku`, which is left untouched: a SKU is the warehouse's
   * string, frequently a vendor's, while this is the store's own identifier
   * and must visibly begin with its parent's `productCode` (enforced by
   * `assertVariantBelongsToProduct`, not by a CHECK — see
   * `src/common/catalogue/product-codes.ts` for why denormalising the parent
   * code onto this row would be worse).
   *
   * Uniqueness is `uq_product_variants_variant_code`; format is
   * `ck_product_variants_variant_code_format`. Snapshotted onto `order_items`
   * at sale time so editing it never rewrites history.
   */
  @Column({ type: 'varchar', length: 64, unique: true })
  variantCode: string;

  /**
   * VARIANT LIFECYCLE -- see `UpdateProductDto` for the full contract.
   *
   * Variants are NEVER hard-deleted, because `order_items` reference them and
   * order history must remain renderable forever. Retiring a variant sets
   * `isActive = false`:
   *
   *   - it disappears from the public catalog and cannot be added to a basket
   *     or sold at the POS (not sellable);
   *   - it still resolves by id, so historical order lines still render;
   *   - it is still visible to admins (`AdminProductView`) and can be
   *     reactivated by setting `isActive = true` again.
   */
  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  /**
   * THE UNIFORM SELLABLE-SKU MODEL (migration 0012).
   *
   * `product_variants` is the ONLY sellable unit in this system. A product
   * with no options ("simple product") therefore still has exactly one
   * variant, flagged here, and a basket request that names only a product
   * resolves to it.
   *
   * WHY THIS EXISTS. Before 0012 a product could have zero variants and be
   * sold anyway: `CartService` had a `variantId === null` branch that skipped
   * the variant row lock, skipped the four-hour reservation entirely and just
   * wrote a quantity, and checkout filtered those lines out before allocating.
   * Such a product took part in no stock check, could not be displaced by a
   * POS sale, and sold at `products.basePrice` with nothing allocated. With a
   * default variant there is no second kind of sellable thing left to bypass.
   *
   * At most ONE default per product (partial unique index above). A product
   * with real option variants has NO default: the customer must choose, and a
   * product-only basket request is rejected with VARIANT_REQUIRED_FOR_PRODUCT.
   *
   * The flag is NOT part of the admin variant-upsert contract — it is set when
   * a simple product is created and by the 0012 backfill, and is otherwise
   * left alone. A default variant is retired exactly like any other, with
   * `isActive = false`.
   */
  @Column({ type: 'boolean', default: false })
  isDefault: boolean;

  @ManyToOne(() => Product, (product) => product.variants)
  product: Product;

  @ManyToMany(() => ProductAttributeValue)
  @JoinTable({ name: 'variant_product_attribute_value' })
  attributeValues: ProductAttributeValue[];
}
