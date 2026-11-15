/**
 * Resolution hook for `node --test`, so the web unit tests can import ANY
 * `@kazhal/api-client` source module — not just the leaf ones.
 *
 * ## Why this is needed
 *
 * `packages/api-client` is consumed from source through a tsconfig `paths`
 * entry and is bundled by Next, so its imports are written the way the rest of
 * the repository writes them: extensionless (`from "./polling"`). Node's ESM
 * resolver resolves real paths and does not guess extensions, so importing
 * `realtime/client.ts` under `node --test` failed to LINK — the module graph
 * could not find `./polling` — even though the test never uses the polling
 * transport.
 *
 * ## Why the fix lives here and not in the source
 *
 * The two obvious alternatives are both worse:
 *
 *  - Writing `from "./polling.ts"` in the source needs
 *    `allowImportingTsExtensions` in every tsconfig that reads those files.
 *    Only `apps/web` has it; `apps/store` and `packages/ui` do not, and both
 *    fail to type-check and build (TS5097). Spreading a compiler flag across
 *    three packages so one test file can load is the tail wagging the dog.
 *  - Not importing `client.ts` at all, and re-implementing its start/stop
 *    bookkeeping against a fake coordinator. That would test a copy of the
 *    logic rather than the logic, and the bug it exists to pin lived exactly
 *    in the interaction between the real `AuthCoordinator` and the real
 *    client.
 *
 * So the accommodation is confined to the test runner, where it costs nothing
 * at runtime and cannot affect a shipped bundle.
 *
 * ## What it does, and what it deliberately does not do
 *
 * It retries a FAILED resolution of a RELATIVE, extensionless specifier with
 * `.ts` appended. It never rewrites a specifier that already resolved, never
 * touches bare package specifiers, and never invents a file: if `./polling.ts`
 * does not exist either, the original error is thrown. A genuine typo is still
 * a hard failure naming the original specifier.
 */
import { register } from "node:module";

register("./test-resolver-hooks.mjs", import.meta.url);
