import type { Metadata } from "next";

import { AdminCashiers } from "@/components/admin/cashiers";
import type { RawSearchParams } from "@/lib/search-params";

export const metadata: Metadata = { title: "صندوق‌داران" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  return <AdminCashiers params={await searchParams} />;
}
