import type { Metadata } from "next";

import { AdminUserCreate } from "@/components/admin/user-create";

export const metadata: Metadata = { title: "صندوق‌دار تازه" };

/**
 * The SAME form as `/admin/users/new`, in cashier mode.
 *
 * One creation path, not two: a second implementation of "create a staff
 * account" is how one of them ends up missing the branch requirement or the
 * escalation check. `preset="cashier"` only changes the defaults and the
 * copy — the request it sends is identical.
 */
export default function Page() {
  return <AdminUserCreate preset="cashier" />;
}
