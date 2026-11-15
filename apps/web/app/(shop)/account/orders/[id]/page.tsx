import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { OrderDetail } from "@/components/account/order-views";
import { RequireSession } from "@/components/common";

export const metadata: Metadata = {
  title: "جزئیات سفارش",
  robots: { index: false, follow: false },
};

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId) || orderId < 1) notFound();

  return (
    <div className="mx-auto w-full max-w-[64rem] px-4 py-6 md:px-6 md:py-10">
      <RequireSession title="برای دیدن این سفارش وارد شوید">
        <OrderDetail orderId={orderId} />
      </RequireSession>
    </div>
  );
}
