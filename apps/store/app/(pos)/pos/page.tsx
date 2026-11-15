import type { Metadata } from "next";

import { Till } from "@/components/till";

/**
 * `metadata` is only supported in Server Components, so this page stays a
 * server component and the interactive till is a separate `"use client"`
 * component it renders.
 */
export const metadata: Metadata = {
  title: "صندوق",
  description: "انتخاب کالا از فهرست، ثبت فروش حضوری و صدور رسید.",
};

export default function PosPage() {
  return <Till />;
}
