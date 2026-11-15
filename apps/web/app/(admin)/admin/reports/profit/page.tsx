import type { Metadata } from "next";

import { ProfitReport, type ProfitReportParams } from "@/components/admin/profit-report";
import { PROFIT_GROUP_BY } from "@/lib/admin-api";
import { enumParam, intParam, localDateParam, type RawSearchParams } from "@/lib/search-params";

export const metadata: Metadata = { title: "گزارش سود ناخالص" };

const CHANNELS = ["online", "pos"] as const;

/** A row id: `@Min(1)` on the API, so 0 is dropped rather than sent. */
function idParam(params: RawSearchParams, key: string): number | undefined {
  const value = intParam(params, key);
  return value !== undefined && value >= 1 ? value : undefined;
}

function pageOf(params: RawSearchParams, key: string): number {
  const value = intParam(params, key);
  return value !== undefined && value >= 1 ? value : 1;
}

export default async function AdminProfitReportPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;

  const from = localDateParam(params, "from");
  const to = localDateParam(params, "to");
  const channel = enumParam(params, "channel", CHANNELS);
  const branchId = idParam(params, "branchId");
  const cashierUserId = idParam(params, "cashierUserId");
  const productId = idParam(params, "productId");
  const variantId = idParam(params, "variantId");
  const categoryId = idParam(params, "categoryId");

  const report: ProfitReportParams = {
    groupBy: enumParam(params, "groupBy", PROFIT_GROUP_BY) ?? "day",
    page: pageOf(params, "page"),
    bpage: pageOf(params, "bpage"),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(channel ? { channel } : {}),
    ...(branchId !== undefined ? { branchId } : {}),
    ...(cashierUserId !== undefined ? { cashierUserId } : {}),
    ...(productId !== undefined ? { productId } : {}),
    ...(variantId !== undefined ? { variantId } : {}),
    ...(categoryId !== undefined ? { categoryId } : {}),
  };

  return <ProfitReport params={report} />;
}
