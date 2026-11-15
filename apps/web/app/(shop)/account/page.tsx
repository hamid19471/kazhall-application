import type { Metadata } from "next";

import { AccountHome } from "@/components/account/account-home";
import { PageHeading, RequireSession } from "@/components/common";

export const metadata: Metadata = {
  title: "حساب من",
  robots: { index: false, follow: false },
};

export default function AccountPage() {
  return (
    <div className="mx-auto w-full max-w-[64rem] px-4 py-6 md:px-6 md:py-10">
      <PageHeading title="حساب من" description="اطلاعات حساب، سفارش‌ها و نشانی‌های شما." />
      <div className="mt-6">
        <RequireSession>
          <AccountHome />
        </RequireSession>
      </div>
    </div>
  );
}
