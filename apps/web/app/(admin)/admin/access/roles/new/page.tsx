import type { Metadata } from "next";

import { AdminRoleCreate } from "@/components/admin/role-create";

export const metadata: Metadata = { title: "نقش تازه" };

export default function Page() {
  return <AdminRoleCreate />;
}
