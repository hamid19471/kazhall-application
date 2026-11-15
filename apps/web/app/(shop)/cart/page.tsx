import type { Metadata } from "next";

import { CartPageView } from "@/components/cart/cart-view";

export const metadata: Metadata = {
  title: "سبد خرید",
  description: "کالاهای رزروشدهٔ شما و مهلت چهارساعتهٔ نگهداری آن‌ها.",
};

export default function CartPage() {
  return <CartPageView />;
}
