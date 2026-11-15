import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Receipt } from "@/components/receipt";

export const metadata: Metadata = {
  title: "رسید فروش",
};

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const orderId = Number.parseInt(id, 10);
  if (!Number.isSafeInteger(orderId) || orderId <= 0) notFound();

  return <Receipt orderId={orderId} />;
}
