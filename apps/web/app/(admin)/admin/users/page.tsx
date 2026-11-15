import type { Metadata } from "next";

import { AdminUsers } from "@/components/admin/users";
import type { RawSearchParams } from "@/lib/search-params";

export const metadata: Metadata = { title: "کاربران" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  return <AdminUsers params={await searchParams} />;
}
