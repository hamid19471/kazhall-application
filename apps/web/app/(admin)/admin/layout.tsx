import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AdminShell } from "@/components/admin/admin-shell";
import { Providers } from "@/components/providers";

/**
 * The admin area.
 *
 * A sibling route group to `(shop)`, so it gets the root layout's `<html
 * dir="rtl">` and skip link but none of the storefront chrome. `AdminShell`
 * provides the `#main` target the skip link expects, and gates each section on
 * the CAPABILITY that section needs — so a delegated role sees the parts of the
 * console it can actually use and nothing else.
 *
 * `noindex` is not a security control — the server's capability guard is — but
 * an operator console has no business in a search index.
 */
export const metadata: Metadata = {
  title: {
    default: "بخش مدیریت | کژال",
    template: "%s | مدیریت کژال",
  },
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <Providers audience="admin">{children === null ? null : <AdminShell>{children}</AdminShell>}</Providers>;
}
