/**
 * Catalog fixtures for the workstream-B integration tests.
 *
 * These build rows through the real repositories against the real disposable
 * Postgres, so they exercise the same column types and constraints the
 * application does. They deliberately do NOT go through the HTTP API: a test
 * that asserts "the public catalog leaks no cart data" must be able to plant
 * cart data that the API itself would never let it plant.
 */
import { DataSource, In } from 'typeorm';

import { Category } from 'src/modules/categories/entities/category.entity';
import { Product } from 'src/modules/products/entities/product.entity';
import { ProductVariant } from 'src/modules/products/entities/product-variant.entity';
import { ProductImage } from 'src/modules/products/entities/product-image.entity';
import { ProductAttribute } from 'src/modules/products/entities/product-attribute.entity';
import { ProductAttributeValue } from 'src/modules/products/entities/product-attribute-value.entity';
import { CartItem } from 'src/modules/cart/entities/cart-item.entity';

let skuCounter = 0;
export const uniqueSku = (prefix = 'SKU') =>
  `${prefix}-${Date.now().toString(36)}-${++skuCounter}`;

export async function seedCategory(
  dataSource: DataSource,
  title: string,
): Promise<Category> {
  return dataSource.getRepository(Category).save({ title } as Category);
}

export async function seedAttribute(
  dataSource: DataSource,
  name: string,
  values: string[],
): Promise<{ attribute: ProductAttribute; values: ProductAttributeValue[] }> {
  const attribute = await dataSource.getRepository(ProductAttribute).save({
    name,
    values: values.map((value) => ({ value })),
  } as ProductAttribute);
  const stored = await dataSource
    .getRepository(ProductAttributeValue)
    .find({ where: { attribute: { id: attribute.id } } });
  return { attribute, values: stored };
}

export interface SeedVariantInput {
  /** «کد گونه». Defaults to one derived from the parent's product code. */
  variantCode?: string;
  sku?: string;
  price?: number;
  stock?: number;
  isActive?: boolean;
  attributeValueIds?: number[];
}

export interface SeedProductInput {
  title: string;
  description?: string;
  basePrice?: number | null;
  categories?: Category[];
  variants?: SeedVariantInput[];
  imageUrls?: string[];
  /** «کد محصول». Defaults to a generated, collision-free one. */
  productCode?: string;
  /** Website channel. Fixtures default to TRUE — see `seedProduct`. */
  visibleOnSite?: boolean;
  /** Retail channel. Fixtures default to `'all'` — see `seedProduct`. */
  branchVisibility?: 'none' | 'all' | 'selected';
}

export async function seedProduct(
  dataSource: DataSource,
  input: SeedProductInput,
): Promise<Product> {
  const productRepo = dataSource.getRepository(Product);
  const attributeValueRepo = dataSource.getRepository(ProductAttributeValue);

  const product = productRepo.create({
    title: input.title,
    description: input.description ?? `${input.title} description`,
    basePrice: input.basePrice ?? null,
    categories: input.categories ?? [],
    /*
     * Required and unique since 0031. Fixtures are VISIBLE EVERYWHERE by
     * default so that the hundreds of specs written before channel visibility
     * existed keep testing what they were written to test; a spec that cares
     * about visibility sets it explicitly.
     */
    productCode:
      input.productCode ??
      `CATP-${uniqueSku()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')}`,
    visibleOnSite: input.visibleOnSite ?? true,
    branchVisibility: input.branchVisibility ?? 'all',
  } as Partial<Product>);

  const saved = await productRepo.save(product);

  const variantRepo = dataSource.getRepository(ProductVariant);
  for (const v of input.variants ?? []) {
    await variantRepo.save(
      variantRepo.create({
        product: { id: saved.id } as Product,
        sku: v.sku ?? uniqueSku(),
        variantCode:
          v.variantCode ??
          `${saved.productCode}-V${uniqueSku()
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '')}`,
        price: v.price ?? 0,
        stock: v.stock ?? 0,
        isActive: v.isActive ?? true,
        attributeValues: v.attributeValueIds?.length
          ? await attributeValueRepo.findBy({ id: In(v.attributeValueIds) })
          : [],
      }),
    );
  }

  const imageRepo = dataSource.getRepository(ProductImage);
  let sortOrder = 0;
  for (const url of input.imageUrls ?? []) {
    await imageRepo.save(
      imageRepo.create({
        url,
        sortOrder: sortOrder++,
        product: { id: saved.id } as Product,
      }),
    );
  }

  return reloadProduct(dataSource, saved.id);
}

export async function seedDetachedImage(
  dataSource: DataSource,
  url: string,
): Promise<ProductImage> {
  const repo = dataSource.getRepository(ProductImage);
  return repo.save(repo.create({ url, sortOrder: null }));
}

export async function reloadProduct(
  dataSource: DataSource,
  id: number,
): Promise<Product> {
  const product = await dataSource.getRepository(Product).findOne({
    where: { id },
    relations: {
      categories: true,
      images: true,
      variants: { attributeValues: true },
    },
  });
  if (!product) throw new Error(`fixture: product ${id} disappeared`);
  return product;
}

/**
 * Plants a cart row that the public catalog must never disclose.
 *
 * `variantId` is REQUIRED: since migration 0013 `cart_items."variantId"` is
 * NOT NULL, because a basket line that names no sellable SKU used to skip the
 * variant lock, the availability check and the four-hour hold entirely. There
 * is deliberately no way to plant one from here any more -- not even for a
 * privacy test -- because the database itself will not store it.
 */
export async function seedCartItem(
  dataSource: DataSource,
  input: {
    userId: number;
    productId: number;
    variantId: number;
    quantity?: number;
  },
): Promise<CartItem> {
  const repo = dataSource.getRepository(CartItem);
  const item = repo.create({
    userId: input.userId,
    productId: input.productId,
    variantId: input.variantId,
    quantity: input.quantity ?? 1,
  });
  return repo.save(item);
}

/** Plants a bookmark (bookmark_products junction row) directly. */
export async function seedBookmark(
  dataSource: DataSource,
  productId: number,
  userId: number,
): Promise<void> {
  await dataSource.query(
    `INSERT INTO "bookmark_products" ("product_id", "user_id")
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [productId, userId],
  );
}

export async function countBookmarks(
  dataSource: DataSource,
  productId: number,
  userId?: number,
): Promise<number> {
  const rows: Array<{ count: string }> = userId
    ? await dataSource.query(
        `SELECT COUNT(*)::text AS count FROM "bookmark_products"
          WHERE "product_id" = $1 AND "user_id" = $2`,
        [productId, userId],
      )
    : await dataSource.query(
        `SELECT COUNT(*)::text AS count FROM "bookmark_products"
          WHERE "product_id" = $1`,
        [productId],
      );
  return Number(rows[0]?.count ?? 0);
}
