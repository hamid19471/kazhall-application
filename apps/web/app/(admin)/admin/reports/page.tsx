import type { Metadata } from "next";

import { ReportsView, type ReportFilters } from "@/components/admin/reports-view";
import {
  enumParam,
  first,
  localDateParam,
  pageParam,
  type RawSearchParams,
} from "@/lib/search-params";

export const metadata: Metadata = { title: "گزارش فروش" };

const CHANNELS = ["online", "pos"] as const;

export default async function AdminReportsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;

  const from = localDateParam(params, "from");
  const to = localDateParam(params, "to");
  const channel = enumParam(params, "channel", CHANNELS);
  const status = first(params, "status");

  const filters: ReportFilters = {
    page: pageParam(params),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(channel ? { channel } : {}),
    ...(status ? { status } : {}),
  };

  return <ReportsView filters={filters} />;
}
