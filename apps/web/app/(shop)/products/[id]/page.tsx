import { notFound } from "next/navigation";

import { ProductDetail } from "@/components/catalog/product-detail";

/**
 * Product detail.
 *
 * `params` is a Promise in Next 16. The id is validated here so a URL like
 * `/products/abc` becomes a 404 immediately instead of sending `NaN` to the API
 * and rendering the server's `ParseIntPipe` 400 as if it were a real failure.
 */
export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const productId = Number(id);
  if (!Number.isInteger(productId) || productId < 1) notFound();

  return <ProductDetail productId={productId} />;
}
