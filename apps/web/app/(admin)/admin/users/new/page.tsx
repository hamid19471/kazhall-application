import type { Metadata } from "next";

import { AdminUserCreate } from "@/components/admin/user-create";

export const metadata: Metadata = { title: "کاربر تازه" };

export default function Page() {
  return <AdminUserCreate />;
}
