import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { AdminUserDetail } from "@/components/admin/user-detail";

export const metadata: Metadata = { title: "کاربر" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numeric = Number(id);
  // A non-numeric segment is not "not found yet" — it is a URL that cannot
  // refer to anything, so it is refused here rather than sent to the API.
  if (!Number.isInteger(numeric) || numeric < 1) notFound();
  return <AdminUserDetail userId={numeric} />;
}
