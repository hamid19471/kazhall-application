import type { Metadata } from "next";

import { OrderList } from "@/components/account/order-views";
import { Breadcrumbs, PageHeading, RequireSession } from "@/components/common";
import { pageParam, type RawSearchParams } from "@/lib/search-params";

export const metadata: Metadata = {
  title: "سفارش‌های من",
  robots: { index: false, follow: false },
};

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;

  return (
    <div className="mx-auto w-full max-w-[64rem] px-4 py-6 md:px-6 md:py-10">
      <Breadcrumbs items={[{ label: "حساب من", href: "/account" }, { label: "سفارش‌ها" }]} />
      <PageHeading
        title="سفارش‌های من"
        description="وضعیت پول و وضعیت کالا برای هر سفارش جدا نگه داشته می‌شود."
      />
      <div className="mt-6">
        <RequireSession title="برای دیدن سفارش‌ها وارد شوید">
          <OrderList page={pageParam(params)} />
        </RequireSession>
      </div>
    </div>
  );
}
