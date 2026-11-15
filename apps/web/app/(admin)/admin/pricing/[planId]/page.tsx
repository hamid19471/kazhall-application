import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PricingPlanWorkspace, type PricingPreviewParams } from "@/components/admin/pricing-plan";
import {
  PRICING_ITEM_CHANNELS,
  PRICING_ITEM_DIRECTIONS,
  PRICING_ITEM_SORTS,
  PRICING_ITEM_STATUSES,
  PRICING_ITEM_VIEWS,
} from "@/lib/admin-api";
import { boolParam, enumParam, intParam, pageParam, textParam, type RawSearchParams } from "@/lib/search-params";

export const metadata: Metadata = { title: "برنامهٔ قیمت‌گذاری" };

const PERCENT_BOUND = /^-?\d{1,6}(\.\d{1,2})?$/;

function percentParam(params: RawSearchParams, key: string): string | undefined {
  const raw = textParam(params, key, 12);
  return raw !== undefined && PERCENT_BOUND.test(raw) ? raw : undefined;
}

export default async function AdminPricingPlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ planId: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const { planId } = await params;
  const numeric = Number(planId);
  if (!Number.isInteger(numeric) || numeric < 1) notFound();
  const query = await searchParams;
  const categoryId = intParam(query, "categoryId");
  const preview: PricingPreviewParams = {
    view: enumParam(query, "view", PRICING_ITEM_VIEWS) ?? "exceptions",
    search: textParam(query, "search", 120),
    status: enumParam(query, "status", PRICING_ITEM_STATUSES),
    categoryId: categoryId !== undefined && categoryId >= 1 ? categoryId : undefined,
    channel: enumParam(query, "channel", PRICING_ITEM_CHANNELS),
    direction: enumParam(query, "direction", PRICING_ITEM_DIRECTIONS),
    minChangePercent: percentParam(query, "minChangePercent"),
    maxChangePercent: percentParam(query, "maxChangePercent"),
    included: boolParam(query, "included"),
    stale: boolParam(query, "stale"),
    sort: enumParam(query, "sort", PRICING_ITEM_SORTS) ?? "product",
    order: enumParam(query, "order", ["asc", "desc"] as const) ?? "asc",
    page: pageParam(query),
  };
  return <PricingPlanWorkspace planId={numeric} preview={preview} />;
}
