import type { Metadata } from "next";

import { AdminProductCreate } from "@/components/admin/product-form";

export const metadata: Metadata = { title: "کالای تازه" };

export default function AdminProductNewPage() {
  return <AdminProductCreate />;
}
