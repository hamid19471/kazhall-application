import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";

import "./globals.css";

/**
 * Root layout for the customer storefront AND the `/admin` back office — both
 * route groups, `(shop)` and `(admin)`, sit under this one `<html>`.
 *
 * Notes for anyone editing this file (Next 16 / React 19):
 *
 *  - The `children` prop is typed with a plain local type on purpose. The
 *    generated `LayoutProps<"/">` global only exists after `next dev`,
 *    `next build` or `next typegen` has written `.next/types`, and `.next/` is
 *    gitignored — so depending on it makes `tsc --noEmit` fail on a clean
 *    checkout. Typed ROUTES still work (`next typegen` runs before
 *    `check-types` via turbo.json); it is only this prop that is decoupled.
 *  - `dir="rtl"` and `lang="fa"` are set here, once. Everything downstream must
 *    use CSS logical properties.
 *  - `data-scroll-behavior="smooth"` is required in Next 16: the router no
 *    longer overrides `scroll-behavior` during navigation without it, so
 *    `scroll-behavior: smooth` in the base layer would otherwise make every
 *    route change animate its scroll to top.
 *  - The typeface is layered. `Vazirmatn` (SIL OFL 1.1) is the BASELINE and is
 *    committed under `packages/ui/fonts/vazirmatn/`; it is what `localFont`
 *    below loads, and because those files are always in the tree `next build`
 *    can never fail on a missing font. `Yekan Bakh` is the BRAND face, is
 *    commercial, is NOT in this repository, and is layered on top by plain
 *    `@font-face` rules in `packages/ui/src/styles/tokens.css` that point at
 *    `/fonts/*.woff2` in this app's gitignored `public/fonts/`. Absent files
 *    404 and matching falls through to Vazirmatn; present files win. Either
 *    way nothing is fetched from Google Fonts or any CDN, at build or run
 *    time, and `next/font` ships inside `next` itself so this adds no
 *    dependency and leaves pnpm-lock.yaml untouched — the same reason
 *    `globals.css` reaches `packages/ui` by relative path.
 *    Provenance, licences and the weight mapping: `packages/ui/fonts/README.md`.
 *  - The `localFont` declaration below is a byte-for-byte twin of the other
 *    app's and MUST stay that way: `next/font` is a compile-time transform that
 *    only accepts literal values, so the weight table cannot be lifted into a
 *    shared module. Change one, change both.
 */

/*
 * Only the four weights the interface actually uses are shipped. Vazirmatn has
 * nine statics upstream (Thin…Black); nothing renders Thin, ExtraLight, Light,
 * Medium or ExtraBold, so bundling them would be ~250KB of preload for no
 * pixels. Every weight declared here is a REAL file whose `usWeightClass`
 * matches — the browser never has to synthesise a bold.
 *
 * The four weights and their numbers are identical to the brand face's, so the
 * overlay swaps in cleanly with no mapping table to keep in sync.
 *
 * `font-medium` (500) and `font-extrabold` (800) are used by components but
 * have no file of their own. CSS font matching resolves 500 down to Regular and
 * 800 up to Black; neither is synthesised. See the README.
 */
const vazirmatn = localFont({
  src: [
    {
      path: "../../../packages/ui/fonts/vazirmatn/Vazirmatn-Regular.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../../../packages/ui/fonts/vazirmatn/Vazirmatn-SemiBold.woff2",
      weight: "600",
      style: "normal",
    },
    {
      path: "../../../packages/ui/fonts/vazirmatn/Vazirmatn-Bold.woff2",
      weight: "700",
      style: "normal",
    },
    {
      path: "../../../packages/ui/fonts/vazirmatn/Vazirmatn-Black.woff2",
      weight: "900",
      style: "normal",
    },
  ],
  variable: "--kz-font-vazirmatn",
  display: "swap",
  preload: true,
  /*
   * Persian-capable faces only. A Latin-only fallback would render Persian as
   * tofu for the one frame before the real font paints.
   */
  fallback: [
    "IRANSansX",
    "Segoe UI",
    "Noto Sans Arabic",
    "Geeza Pro",
    "Tahoma",
    "system-ui",
    "sans-serif",
  ],
});

/*
 * Is the licensed brand face installed?
 *
 * `NEXT_PUBLIC_BRAND_FONT=yekan-bakh` is the licensee's declaration that the
 * four `YekanBakh-*.woff2` files have been placed in `public/fonts/`. It does
 * NOT load them — the `@font-face` rules in `packages/ui/src/styles/tokens.css`
 * do that, and they work whether or not this is set. All this flag controls is
 * the `ss01` OpenType feature, which is safe under Yekan Bakh but rewrites every
 * ASCII digit under the Vazirmatn baseline. Read as a literal so Next can inline
 * it at build time. Default: unset, meaning off.
 */
const brandFont =
  process.env.NEXT_PUBLIC_BRAND_FONT === "yekan-bakh" ? "yekan-bakh" : undefined;

export const metadata: Metadata = {
  title: {
    default: "کژال | تجهیزات کوهنوردی، کمپینگ، شکار و ماهیگیری",
    template: "%s | کژال",
  },
  description:
    "فروشگاه اینترنتی تجهیزات کوهنوردی، کمپینگ و آفرود، شکار و ماهیگیری.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f7f4" },
    { media: "(prefers-color-scheme: dark)", color: "#121815" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="fa"
      dir="rtl"
      data-scroll-behavior="smooth"
      data-brand-font={brandFont}
      className={`${vazirmatn.variable} h-full`}
    >
      <body className="flex min-h-full flex-col bg-canvas text-ink antialiased">
        {/*
          Skip link. It expects the page shell to render an element with
          `id="main"` (normally `<main id="main" tabIndex={-1}>`). Whoever owns
          the app shell must provide that target.
        */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:start-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:text-ink focus:shadow-raised"
        >
          پرش به محتوای اصلی
        </a>
        {children}
      </body>
    </html>
  );
}
