import type { Metadata } from "next";

import { AdminCategories } from "@/components/admin/categories";
import type { RawSearchParams } from "@/lib/search-params";

export const metadata: Metadata = { title: "دسته‌بندی‌ها" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  return <AdminCategories params={await searchParams} />;
}
