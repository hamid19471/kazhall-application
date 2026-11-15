import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { CreateProductDto } from './create-product.dto';
import { IsArray, IsInt, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { UpsertVariantDto } from './upsert-variant.dto';

/**
 * ============================================================================
 * PATCH /products/:id
 *
 * Every field is optional. An OMITTED field is never touched. This is a real
 * PATCH, not a disguised PUT -- with two explicitly documented exceptions
 * below (`categoryIds` and `images`) where the supplied array is the COMPLETE
 * desired set, because "add one category" and "replace all categories" cannot
 * both be expressed by the same array otherwise.
 *
 * The whole update runs inside a single `dataSource.transaction`. A failure
 * anywhere -- an unknown attribute value, an image belonging to another
 * product, a duplicate SKU -- rolls back everything. There is no state in
 * which some variants were saved and the product row was not.
 *
 * ----------------------------------------------------------------------------
 * CATEGORY CONTRACT
 * ----------------------------------------------------------------------------
 * `categoryIds` is the COMPLETE desired set of categories.
 *   - omitted    -> categories untouched
 *   - []         -> product removed from every category
 *   - [3, 7]     -> product belongs to exactly categories 3 and 7
 *   - unknown id -> 404 CATEGORY_NOT_FOUND, whole request rolled back
 *
 * ----------------------------------------------------------------------------
 * IMAGE CONTRACT
 * ----------------------------------------------------------------------------
 * Images are uploaded first (`POST /products/uploadImage`), which returns a
 * detached `ProductImage` row. `images` then re-parents them.
 *
 * `images` is the COMPLETE desired ORDERED set of image ids.
 *   - omitted            -> images untouched
 *   - []                 -> every image currently attached is DETACHED AND
 *                           DELETED from the database
 *   - [9, 4, 7]          -> the product ends up with exactly images 9, 4, 7,
 *                           in that order. `sortOrder` is PERSISTED as the
 *                           0-based index (9 -> 0, 4 -> 1, 7 -> 2), so the
 *                           order round-trips through a reload.
 *   - id not in the list -> that image row is deleted (it is unreachable
 *                           otherwise; the object in MinIO is intentionally
 *                           left in place, deletion of blobs is out of scope)
 *   - unknown id         -> 404 PRODUCT_IMAGES_NOT_FOUND, rolled back
 *   - id owned by ANOTHER product
 *                        -> 400 PRODUCT_IMAGE_OWNED_BY_OTHER_PRODUCT,
 *                           rolled back. Stealing another product's image is
 *                           never implicit.
 *   - duplicate ids      -> 400 PRODUCT_IMAGES_DUPLICATED
 *
 * ----------------------------------------------------------------------------
 * VARIANT LIFECYCLE CONTRACT
 * ----------------------------------------------------------------------------
 * `variants` is a PARTIAL UPSERT LIST, NOT the complete desired set. A variant
 * that is not mentioned is left exactly as it was. This differs from images on
 * purpose: variants are referenced by `order_items`, so "absent means delete"
 * would be a footgun that silently destroys sales history.
 *
 *   - entry WITHOUT `id`   -> CREATE. `sku` and `attributeValueIds` are
 *                             required; `price` and `stock` optional
 *                             (default 0). The new variant is active.
 *   - entry WITH `id`      -> UPDATE the named fields only. The id MUST belong
 *                             to this product; a foreign id is rejected with
 *                             400 VARIANT_DOES_NOT_BELONG_TO_PRODUCT (never a
 *                             404, so a caller cannot probe other products'
 *                             variant ids).
 *   - `isActive: false`    -> DEACTIVATE. The variant is hidden from the
 *                             public catalog and is not sellable, but the row
 *                             survives so historical order lines still render.
 *                             Admin views keep showing it.
 *   - `isActive: true`     -> reactivate a previously retired variant.
 *   - `stock` on an UPDATE -> 400 VARIANT_STOCK_NOT_UPDATABLE. Use
 *                             POST /products/variants/:variantId/stock/adjust,
 *                             which is reservation-aware and writes a stock
 *                             movement.
 *
 * There is NO variant delete endpoint, by design.
 *
 * ----------------------------------------------------------------------------
 * THE DEFAULT VARIANT (migration 0012)
 * ----------------------------------------------------------------------------
 * `product_variants` is the ONLY sellable unit in this system, so a product
 * with no options still carries exactly one variant, flagged `isDefault`. A
 * basket request that names only a product resolves to it; a product with real
 * option variants has no default and such a request is rejected with
 * VARIANT_REQUIRED_FOR_PRODUCT.
 *
 * Under this contract:
 *
 *   - ADDING option variants to a simple product DOES NOT retire its default.
 *     The default holds counted physical stock and may hold live reservations;
 *     retiring it as a side effect of an unrelated edit would strand real units
 *     with no ledger entry saying where they went. Retire it explicitly with
 *     `{ id, isActive: false }` when you mean to, having moved its stock first.
 *   - `isDefault` is NOT settable here and is absent from `UpsertVariantDto`.
 *     It decides where a product-only "add to basket" lands, so a routine
 *     catalog edit must not be able to move it.
 *   - DEACTIVATING EVERY variant is allowed and means "discontinued". The
 *     product does not become sellable-with-no-SKU: the basket rejects it with
 *     PRODUCT_NOT_SELLABLE and the public views report no variants and
 *     `inStock: false`.
 * ============================================================================
 */
/*
 * `initialStock` IS OMITTED ON PURPOSE, not forgotten.
 *
 * It is an OPENING balance — the quantity a product entered the catalogue
 * with — and a product can only enter the catalogue once. Allowing it here
 * would give product editing a second, silent way to move stock, one that
 * bypasses the reservation arithmetic `POST /products/variants/:id/stock/adjust`
 * performs and that writes no adjustment anybody can audit.
 *
 * The global pipe runs with `forbidNonWhitelisted`, so sending it to PATCH is a
 * 400 naming the property rather than a value that is quietly dropped. That is
 * the behaviour the Admin form relies on: it never resends the field, and if a
 * future change made it do so the request would fail loudly instead of
 * appearing to work.
 */
export class UpdateProductDto extends PartialType(
  OmitType(CreateProductDto, [
    'variants',
    'images',
    'initialStock',
    // Cost never changes through a product PATCH — /admin/costing only.
    'purchasePrice',
  ] as const),
) {
  @ApiPropertyOptional({
    description:
      'Partial upsert list. Entry without `id` creates; with `id` updates; ' +
      '`isActive:false` deactivates. Unmentioned variants are untouched. ' +
      'See the VARIANT LIFECYCLE CONTRACT in the source of this DTO.',
    example: [
      { id: 1, price: 12000000, attributeValueIds: [1, 5] },
      { id: 2, isActive: false },
      {
        sku: 'IPH17-RED-256',
        price: 15000000,
        stock: 4,
        attributeValueIds: [3],
      },
    ],
    type: () => [UpsertVariantDto],
  })
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => UpsertVariantDto)
  variants?: UpsertVariantDto[];

  @ApiPropertyOptional({
    example: [9, 4, 7],
    description:
      'COMPLETE desired ordered set of pre-uploaded ProductImage ids. Array ' +
      'index becomes the persisted sortOrder. Attached images not listed are ' +
      'deleted. [] clears all images. Omit to leave images untouched. See ' +
      'the IMAGE CONTRACT in the source of this DTO.',
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  images?: number[];
}
