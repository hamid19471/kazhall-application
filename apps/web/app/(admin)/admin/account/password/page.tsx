import type { Metadata } from "next";

import { AdminChangePassword } from "@/components/admin/change-password";

export const metadata: Metadata = { title: "تغییر گذرواژه" };

export default function Page() {
  return <AdminChangePassword />;
}
