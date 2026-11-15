import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AdminProductEdit } from "@/components/admin/product-form";

export const metadata: Metadata = { title: "ویرایش کالا" };

export default async function AdminProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const productId = Number(id);
  if (!Number.isInteger(productId) || productId < 1) notFound();
  return <AdminProductEdit productId={productId} />;
}
