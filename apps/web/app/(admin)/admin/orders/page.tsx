import type { Metadata } from "next";

import { AdminOrders } from "@/components/admin/orders";
import type { RawSearchParams } from "@/lib/search-params";

export const metadata: Metadata = { title: "سفارش‌ها" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  return <AdminOrders params={await searchParams} />;
}
