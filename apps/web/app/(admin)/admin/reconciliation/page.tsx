import type { Metadata } from "next";

import { ReconciliationQueue, type QueueFilters } from "@/components/admin/reconciliation-queue";
import { boolParam, first, intParam, pageParam, type RawSearchParams } from "@/lib/search-params";

export const metadata: Metadata = { title: "مغایرت‌های پرداخت" };

const CASE_TYPES = ["unapplied_receipt", "fulfilment_incomplete", "awaiting_stock", "operator_open"];
const PAYMENT_STATUSES = ["pending", "success", "failed", "refunded", "confirmed_unapplied"];

/**
 * The three tabs. Allow-listed here rather than passed through, because an
 * unknown value would otherwise reach the API as a 400 the operator cannot
 * explain — an unrecognised `stage` simply falls back to the default view.
 */
const STAGES = ["needs_action", "tracking", "closed"];

/**
 * The queue.
 *
 * `resolved` is read as a TRISTATE: absent means "both", which is the server's
 * own default and the safe one. It is never coerced to `false` — that would
 * hide closed cases behind a filter the operator did not choose.
 */
export default async function ReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;

  const caseType = first(params, "caseType");
  const paymentStatus = first(params, "paymentStatus");
  const orderStatus = first(params, "orderStatus");
  const fulfillmentState = first(params, "fulfillmentState");
  const branchId = intParam(params, "branchId");
  const resolved = boolParam(params, "resolved");
  const stage = first(params, "stage");

  const filters: QueueFilters = {
    page: pageParam(params),
    ...(caseType && CASE_TYPES.includes(caseType)
      ? { caseType: caseType as QueueFilters["caseType"] }
      : {}),
    ...(paymentStatus && PAYMENT_STATUSES.includes(paymentStatus)
      ? { paymentStatus: paymentStatus as QueueFilters["paymentStatus"] }
      : {}),
    ...(orderStatus ? { orderStatus } : {}),
    ...(fulfillmentState ? { fulfillmentState } : {}),
    ...(branchId !== undefined ? { branchId } : {}),
    ...(resolved !== undefined ? { resolved } : {}),
    ...(stage && STAGES.includes(stage) ? { stage: stage as QueueFilters["stage"] } : {}),
  };

  return <ReconciliationQueue filters={filters} />;
}
