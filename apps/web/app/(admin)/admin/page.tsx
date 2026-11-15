import type { Metadata } from "next";

import { AdminDashboard } from "@/components/admin/dashboard";

export const metadata: Metadata = { title: "داشبورد" };

export default function AdminDashboardPage() {
  return <AdminDashboard />;
}
