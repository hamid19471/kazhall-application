import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ReconciliationCase } from "@/components/admin/reconciliation-case";

export const metadata: Metadata = { title: "پروندهٔ مغایرت" };

/**
 * One case. THE CASE ID IS THE ORDER ID — there is deliberately no separate
 * case identifier, because a case is a decision about one order and an order
 * can carry several receipts belonging to that same decision.
 */
export default async function ReconciliationCasePage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  const id = Number(orderId);
  if (!Number.isInteger(id) || id < 1) notFound();
  return <ReconciliationCase orderId={id} />;
}
