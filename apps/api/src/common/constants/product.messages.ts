export const ProductMessages = {
  PRODUCT_CREATED: 'Product created successfully',
  PRODUCT_UPDATED: 'Product updated successfully',
  PRODUCT_DELETED: 'Product deleted successfully',

  PRODUCT_NOT_FOUND: 'Product not found',
  PRODUCT_VARIANT_NOT_FOUND: 'Product variant not found',
  VARIANT_DOES_NOT_BELONG_TO_PRODUCT:
    'The given variant does not belong to the given product',
  VARIANT_STOCK_NOT_UPDATABLE:
    'Variant stock cannot be changed through the product update endpoint. Use POST /products/variants/:variantId/stock/adjust so the change is reservation-aware and recorded in the stock ledger.',
  VARIANT_SKU_REQUIRED: 'sku is required when creating a variant',
  VARIANT_ATTRIBUTE_VALUES_REQUIRED:
    'attributeValueIds is required when creating a variant',
  VARIANT_SKU_ALREADY_EXISTS: 'A variant with this sku already exists',
  VARIANT_INACTIVE: 'This product variant is no longer available for sale',

  PRODUCT_BOOKMARKED: 'Product bookmarked successfully',
  PRODUCT_BOOKMARK_REMOVED: 'Product bookmark removed successfully',

  IMAGE_UPLOADED: 'Image uploaded successfully',
  PRODUCT_IMAGES_NOT_FOUND: 'One or more product images not found',
  PRODUCT_IMAGES_DUPLICATED: 'Duplicate image ids are not allowed',
  PRODUCT_IMAGE_OWNED_BY_OTHER_PRODUCT:
    'One or more images already belong to another product',

  STOCK_ADJUSTED: 'Variant stock adjusted successfully',
  STOCK_BELOW_RESERVED:
    'This adjustment would push physical stock below the currently reserved quantity. Pass allowBelowReserved=true to force it.',
  STOCK_NEGATIVE_NOT_ALLOWED: 'Physical stock can never be negative',

  NOT_ENOUGH_STOCK: 'Not enough stock',
} as const;
