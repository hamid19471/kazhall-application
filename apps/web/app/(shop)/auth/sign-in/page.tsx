import type { Metadata } from "next";

import { SignInView } from "@/components/auth/sign-in-view";
import { first, type RawSearchParams } from "@/lib/search-params";

export const metadata: Metadata = {
  title: "ورود",
  description: "ورود به حساب کاربری کژال با شمارهٔ موبایل و کد یک‌بارمصرف.",
  // A sign-in screen has nothing to offer a crawler and should not be indexed.
  robots: { index: false, follow: false },
};

/**
 * Sign-in.
 *
 * `next` is read here, in a Server Component, rather than with
 * `useSearchParams()` in the view — that hook forces a client-side bail-out
 * from prerendering and would need a `<Suspense>` wrapper. Awaiting
 * `searchParams` (a Promise in Next 16) makes the route dynamic, which is
 * correct for a page whose whole purpose depends on where the visitor came
 * from. The value itself is validated in `safeNextPath` before any navigation.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  const next = first(params, "next");

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-16">
      <SignInView {...(next ? { next } : {})} />
    </div>
  );
}
