import type { Metadata } from "next";

import { AdminStockMovements } from "@/components/admin/stock-movements";
import type { RawSearchParams } from "@/lib/search-params";

export const metadata: Metadata = { title: "گردش موجودی" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  return <AdminStockMovements params={await searchParams} />;
}
