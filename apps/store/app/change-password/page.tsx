import type { Metadata } from "next";

import { PosChangePassword } from "@/components/change-password";
import { StoreProviders } from "@/components/providers";

/**
 * Deliberately a SIBLING of `/login` rather than a member of the `(pos)` route
 * group: the group's shell is a session gate, and this is the one screen whose
 * job includes ending the session it runs on. See `components/change-password`
 * for the full reasoning — and for why that separation is what makes a
 * redirect loop impossible.
 */
export const metadata: Metadata = {
  title: "تغییر گذرواژه",
  description: "جایگزینی گذرواژه‌ی موقتی که مدیر سیستم تعیین کرده است.",
  robots: { index: false, follow: false },
};

export default function ChangePasswordPage() {
  return (
    /*
     * No socket here either, and for a second reason on top of the first.
     *
     * A staff account with `mustChangePassword` set is refused every protected
     * realtime channel by the gateway — that is one of the authorization gaps
     * this pass closed — so a socket opened on this screen could not receive
     * anything even if a POS cookie were present.
     */
    <StoreProviders realtime={false}>
      <PosChangePassword />
    </StoreProviders>
  );
}
