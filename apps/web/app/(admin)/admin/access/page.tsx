import type { Metadata } from "next";

import { AdminAccess } from "@/components/admin/access";
import type { RawSearchParams } from "@/lib/search-params";

export const metadata: Metadata = { title: "نقش‌ها و دسترسی‌ها" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  return <AdminAccess params={await searchParams} />;
}
