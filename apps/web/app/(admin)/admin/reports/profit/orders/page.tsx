import { redirect } from "next/navigation";

import { adminProfitReportHref } from "@/lib/routes";

/**
 * The breadcrumb on an order's profit page links here. The orders list lives
 * on the report itself, so this segment simply sends the reader there.
 */
export default function Page() {
  redirect(adminProfitReportHref());
}
