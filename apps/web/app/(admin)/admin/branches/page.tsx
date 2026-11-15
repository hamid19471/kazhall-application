import type { Metadata } from "next";

import { AdminBranches } from "@/components/admin/branches";
import type { RawSearchParams } from "@/lib/search-params";

export const metadata: Metadata = { title: "شعبه‌ها" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  return <AdminBranches params={await searchParams} />;
}
