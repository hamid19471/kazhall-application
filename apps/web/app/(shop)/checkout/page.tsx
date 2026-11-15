import type { Metadata } from "next";

import { CheckoutPageView } from "@/components/checkout/checkout-view";

export const metadata: Metadata = {
  title: "تأیید و ثبت سفارش",
  robots: { index: false, follow: false },
};

export default function CheckoutPage() {
  return <CheckoutPageView />;
}
