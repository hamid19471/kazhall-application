import type { ReactNode } from "react";

import "../print.css";

import { PosShell } from "@/components/pos-shell";
import { StoreProviders } from "@/components/providers";

/**
 * Route group `(pos)` — the signed-in till. The group parentheses keep it out
 * of the URL, so the routes below are `/pos` and
 * `/receipt/[id]`.
 *
 * `children` is typed with a plain local type rather than the generated
 * `LayoutProps<'/'>` global, matching the root layout's reasoning: `.next/` is
 * gitignored, so a bare `tsc --noEmit` on a clean checkout must not depend on
 * generated types. Typed ROUTES still work (`next typegen` runs before
 * `check-types` via turbo.json).
 */
export default function PosLayout({ children }: { children: ReactNode }) {
  return (
    <StoreProviders>
      <PosShell>{children}</PosShell>
    </StoreProviders>
  );
}
