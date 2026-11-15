import type { Metadata } from "next";

import { PricingPlans } from "@/components/admin/pricing-plans";
import { enumParam, pageParam, type RawSearchParams } from "@/lib/search-params";
import { PRICING_PLAN_STATUSES } from "@/lib/admin-api";

export const metadata: Metadata = { title: "قیمت‌گذاری ماهانه" };

export default async function AdminPricingPlansPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  return (
    <PricingPlans
      page={pageParam(params)}
      status={enumParam(params, "status", PRICING_PLAN_STATUSES)}
    />
  );
}
