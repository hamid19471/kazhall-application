import type { Metadata } from "next";

import { AdminProductList } from "@/components/admin/product-list";
import { pageParam, textParam, type RawSearchParams } from "@/lib/search-params";

export const metadata: Metadata = { title: "کالاها" };

export default async function AdminProductsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  const search = textParam(params, "search");
  return <AdminProductList page={pageParam(params)} {...(search ? { search } : {})} />;
}
