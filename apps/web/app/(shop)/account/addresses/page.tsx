import type { Metadata } from "next";

import { AddressBook } from "@/components/address/addresses";
import { Breadcrumbs, PageHeading, RequireSession } from "@/components/common";

export const metadata: Metadata = {
  title: "نشانی‌های من",
  robots: { index: false, follow: false },
};

export default function AddressesPage() {
  return (
    <div className="mx-auto w-full max-w-[64rem] px-4 py-6 md:px-6 md:py-10">
      <Breadcrumbs items={[{ label: "حساب من", href: "/account" }, { label: "نشانی‌ها" }]} />
      <PageHeading
        title="نشانی‌های من"
        description="این نشانی‌ها فقط متعلق به حساب شماست و هنگام ثبت سفارش قابل انتخاب‌اند."
      />
      <div className="mt-6">
        <RequireSession title="برای مدیریت نشانی‌ها وارد شوید">
          <AddressBook />
        </RequireSession>
      </div>
    </div>
  );
}
