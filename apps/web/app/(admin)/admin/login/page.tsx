import type { Metadata } from "next";

import { AdminLoginView } from "@/components/admin/admin-login";
import { textParam, type RawSearchParams } from "@/lib/search-params";

export const metadata: Metadata = {
  title: "ورود کارکنان",
  robots: { index: false, follow: false },
};

/**
 * Staff sign-in. Deliberately NOT wrapped in the admin shell's role gate —
 * `AdminShell` renders this route bare, because a page whose whole purpose is
 * to obtain a session cannot itself require one.
 */
export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  const next = textParam(params, "next");
  return <AdminLoginView {...(next !== undefined ? { next } : {})} />;
}
