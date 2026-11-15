import type { Metadata } from "next";

import { PaymentReturnView } from "@/components/checkout/payment-return";
import { first, type RawSearchParams } from "@/lib/search-params";

export const metadata: Metadata = {
  title: "نتیجهٔ پرداخت",
  robots: { index: false, follow: false },
};

/**
 * The SAME-SITE return page the gateway sends the customer back to.
 *
 * Gateways are not consistent about the parameter's spelling, so all three
 * shipped spellings are accepted. Whatever arrives is treated as an untrusted
 * string: it is only ever handed to `POST /payment/verify`, whose answer is the
 * sole basis for anything this page tells the customer.
 */
export default async function PaymentReturnPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  const trackId =
    first(params, "trackId") ?? first(params, "track_id") ?? first(params, "trackid");

  return <PaymentReturnView {...(trackId ? { trackId } : {})} />;
}
