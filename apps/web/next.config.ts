import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Minimal production server for apps/web/Dockerfile. Shared source lives
  // outside this app, so the trace must start at the monorepo root.
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),

  // Statically typed `Link href` / `router.push`. Stable (no longer
  // `experimental.typedRoutes`) as of Next 16.
  //
  // The generated types live in `.next/types` and are produced by `next dev`,
  // `next build` or `next typegen`. `turbo.json` makes `check-types` depend on
  // the `typegen` task so `pnpm check-types` from the repo root always has them
  // on a clean checkout.
  typedRoutes: true,

  // Build output directory. Unset is Next's default `.next`. The disposable
  // pricing browser workflow (scripts/pricing-e2e) builds into its own
  // directory so it never overwrites the running dev server's output.
  ...(process.env.KAZHAL_NEXT_DIST_DIR ? { distDir: process.env.KAZHAL_NEXT_DIST_DIR } : {}),

  // NOTE: `transpilePackages` is deliberately NOT set. `@kazhal/ui` and
  // `@kazhal/api-client` are resolved from source through the tsconfig `paths`
  // entries, and Turbopack compiles them in place. Adding them here would fail
  // anyway — `transpilePackages` takes package names, not paths, and neither is
  // a declared dependency of this app.
};

export default nextConfig;
