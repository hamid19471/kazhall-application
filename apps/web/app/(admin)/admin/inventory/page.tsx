import type { Metadata } from "next";

import { AdminInventory } from "@/components/admin/inventory";
import type { RawSearchParams } from "@/lib/search-params";

export const metadata: Metadata = { title: "موجودی" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  return <AdminInventory params={await searchParams} />;
}
