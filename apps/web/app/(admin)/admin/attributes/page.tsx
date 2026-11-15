import type { Metadata } from "next";

import { AdminAttributes } from "@/components/admin/attributes";
import type { RawSearchParams } from "@/lib/search-params";

export const metadata: Metadata = { title: "ویژگی‌ها" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  return <AdminAttributes params={await searchParams} />;
}
