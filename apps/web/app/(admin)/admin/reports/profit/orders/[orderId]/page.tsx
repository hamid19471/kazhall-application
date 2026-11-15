import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { ProfitOrderView } from "@/components/admin/profit-report";

export const metadata: Metadata = { title: "سود ناخالص سفارش" };

export default async function Page({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const numeric = Number(orderId);
  if (!Number.isInteger(numeric) || numeric < 1) notFound();
  return <ProfitOrderView orderId={numeric} />;
}
