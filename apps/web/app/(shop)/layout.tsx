import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Footer } from "@/components/shell/footer";
import { Header } from "@/components/shell/header";
import { MobileNav } from "@/components/shell/mobile-nav";
import { Providers } from "@/components/providers";

/**
 * The storefront shell.
 *
 * `app/layout.tsx` (Workstream D) owns `<html>`, `<body>`, `dir="rtl"` and the
 * skip link. That skip link targets `#main`, and THIS is the layout that
 * provides it — `<main id="main" tabIndex={-1}>`. `tabIndex={-1}` is what makes
 * the target focusable: without it the browser scrolls but focus stays on the
 * link, and the next Tab goes back to the header the user just skipped.
 *
 * The metadata below overrides the root layout's, which still described a
 * cosmetics shop. Nested `metadata` merges over an ancestor's, so redefining
 * `title` here (default AND template) retargets every storefront page without
 * touching a file this workstream does not own.
 */
export const metadata: Metadata = {
  title: {
    default: "کژال | تجهیزات کوهنوردی، شکار، کمپینگ و ماهیگیری",
    template: "%s | کژال",
  },
  description:
    "فروشگاه اینترنتی تجهیزات کوهنوردی، شکار، کمپینگ و آفرود و ماهیگیری: چادر، کیسه خواب، کوله‌پشتی، پوشاک و لوازم سفر.",
};

export default function ShopLayout({ children }: { children: ReactNode }) {
  return (
    <Providers audience="storefront">
      <Header />
      {/*
        `pb-20 md:pb-0` reserves the height of the fixed mobile bottom bar, so
        the last row of a product grid is never hidden underneath it.
      */}
      <main id="main" tabIndex={-1} className="flex-1 pb-20 outline-none md:pb-0">
        {children}
      </main>
      <Footer />
      <MobileNav />
    </Providers>
  );
}
