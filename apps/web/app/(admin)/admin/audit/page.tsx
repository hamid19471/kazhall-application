import type { Metadata } from "next";

import { AdminAudit } from "@/components/admin/audit";
import type { RawSearchParams } from "@/lib/search-params";

export const metadata: Metadata = { title: "دفتر رخدادها" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  return <AdminAudit params={await searchParams} />;
}
