import type { Metadata } from "next";

import { LoginForm } from "@/components/login-form";
import { StoreProviders } from "@/components/providers";

export const metadata: Metadata = {
  title: "ورود صندوق‌دار",
  description: "ورود به صندوق فروش حضوری کژال.",
};

export default function LoginPage() {
  return (
    // No socket here: there is no POS session yet, and the till has no
    // anonymous mode. See `StoreProviders`'s `realtime` prop.
    <StoreProviders realtime={false}>
      <LoginForm />
    </StoreProviders>
  );
}
