/**
 * Runtime configuration for the Kazhal API client.
 *
 * ============================================================================
 * WHY EVERY PUBLIC VARIABLE IS READ AS A LITERAL MEMBER EXPRESSION
 * ============================================================================
 * This module used to read its configuration through a helper:
 *
 *     readEnv("NEXT_PUBLIC_API_BASE_URL")     // -> process.env[name]
 *
 * That is a DYNAMIC property access, and Next.js cannot inline it. The client
 * bundle is built by replacing the exact text `process.env.NEXT_PUBLIC_FOO`
 * with a string literal; there is no `process` object in the browser for a
 * computed lookup to read afterwards. So in every browser, in every
 * environment, `readEnv` returned `undefined` and the client silently fell back
 * to the built-in localhost default.
 *
 * It was invisible in development because the API really is on that port there.
 * In production it means the browser calls a host that does not exist, and the
 * only symptom is that every request fails.
 *
 * So the two public variables are now read as LITERAL member expressions —
 * `process.env.NEXT_PUBLIC_API_BASE_URL`, spelled out, once each. That exact
 * text is what the bundler substitutes. They must never be routed through a
 * helper that takes the name as an argument, however tidy that looks: doing so
 * silently reintroduces this bug, and nothing fails to compile when it happens.
 *
 * ============================================================================
 * SERVER-ONLY VARIABLES NEVER REACH THE BROWSER
 * ============================================================================
 * `API_BASE_URL` and `REALTIME_URL` (no `NEXT_PUBLIC_` prefix) exist for
 * in-cluster hostnames that must not be published to a client — a service-mesh
 * address, an internal load balancer. They are read only when
 * {@link isBrowser} is false, and a dynamic lookup is correct for them:
 * on a server `process.env` is a real object at runtime, so nothing needs
 * inlining, and NOT inlining them is exactly what keeps them out of the bundle.
 * ============================================================================
 */

/**
 * Default base URL used when nothing is configured.
 *
 * The local-development port contract is API `8000`, Web (storefront and
 * admin) `8001`, POS `8002`; `pnpm dev` at the repository root starts all
 * three. Port 3000 is deliberately unused — it is left to other local tools.
 *
 * The NestJS API defaults to `PORT=8000` and mounts controllers at the bare
 * path — there is NO global prefix (`/auth/admin/login`, `/products`,
 * `/me/orders`). The only `v1`-prefixed thing is Swagger UI at `/v1/api`.
 *
 * This is a development default only. Any real deployment sets
 * `NEXT_PUBLIC_API_BASE_URL` (and optionally `NEXT_PUBLIC_REALTIME_URL`), which
 * always take precedence over it.
 */
export const DEFAULT_API_BASE_URL = "http://localhost:8000";

/** Default realtime (Socket.IO) origin used when nothing is configured. */
export const DEFAULT_REALTIME_URL = DEFAULT_API_BASE_URL;

/** True when running in a browser-like environment. */
export function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.document !== "undefined";
}

/**
 * Treat an absent, empty or whitespace-only value as "not configured".
 *
 * An empty string is what a deployment produces when a variable is declared in
 * a manifest but never given a value, and it must behave like a missing one
 * rather than becoming an empty base URL that turns every request into a
 * request against the current page's origin.
 */
function configured(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * `process.env.NEXT_PUBLIC_API_BASE_URL`, spelled out so a bundler can inline
 * it.
 *
 * ============================================================================
 * WHY THERE IS NO `typeof process` GUARD IN FRONT OF THIS
 * ============================================================================
 * There was one, and it silently defeated the entire fix:
 *
 *     if (typeof process === "undefined") return undefined;   // <- always true
 *     return configured(process.env.NEXT_PUBLIC_API_BASE_URL);
 *
 * It was added for non-Next consumers, on the reasoning that it "does not
 * prevent the substitution, because the member expression below is still
 * literal". The substitution was indeed fine — the built chunk really does
 * contain the configured host. THE LINE ABOVE IT RETURNED FIRST.
 *
 * This version of Next does not define `process` in the browser at all, so
 * `typeof process === "undefined"` is TRUE on every page load, the function
 * returned before reaching the inlined literal, and every browser fell back to
 * the localhost default — the exact defect the rewrite was meant to remove,
 * reproduced one line higher up. It survived review because the proof used was
 * "the configured host appears in the built chunks", which stays true when the
 * value is inlined into code that never executes.
 *
 * So the member expression is now reached UNCONDITIONALLY, and the
 * non-Next case is handled by `try`/`catch` instead:
 *
 *   - Next (browser): the whole expression is replaced with a string literal
 *     at build time. No `process` reference survives, so nothing can throw.
 *   - Node (SSR, tests): `process` is real and the property read works.
 *   - A bundler with no define plugin and no `process` shim: the reference
 *     throws `ReferenceError`, which is caught, and the caller falls back.
 *
 * VERIFY IT AT RUNTIME, NOT IN THE BUNDLE. Grepping the chunks proves only
 * that the text is present. The test that matters is a real browser loading a
 * production build and requesting the configured host — see the delivery
 * report's browser evidence.
 */
function publicApiBaseUrl(): string | undefined {
  try {
    return configured(process.env.NEXT_PUBLIC_API_BASE_URL);
  } catch {
    return undefined;
  }
}

/** As above, for the realtime origin. Same reasoning, same shape. */
function publicRealtimeUrl(): string | undefined {
  try {
    return configured(process.env.NEXT_PUBLIC_REALTIME_URL);
  } catch {
    return undefined;
  }
}

/**
 * A server-only override. Returns `undefined` in a browser, unconditionally.
 *
 * The dynamic lookup is deliberate and safe here — see the header. It is also
 * what guarantees the value cannot be inlined into a client bundle even by
 * accident.
 */
function serverOnlyEnv(name: "API_BASE_URL" | "REALTIME_URL"): string | undefined {
  if (isBrowser()) return undefined;
  if (typeof process === "undefined") return undefined;
  return configured(process.env[name]);
}

/** Strip trailing slashes so path joining is predictable. */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * Normalise a configured origin, refusing one that cannot work.
 *
 * THROWS rather than falling back. A misconfigured `NEXT_PUBLIC_API_BASE_URL`
 * that quietly degrades to `localhost` is precisely the failure this module was
 * rewritten to eliminate: it turns a deployment mistake into a mystery at
 * runtime. A thrown error names the variable and the value, and it surfaces on
 * the first render rather than on a support ticket a week later.
 *
 * Only a value somebody actually CONFIGURED reaches this. The built-in default
 * is a constant and is never validated at runtime.
 */
function validateOrigin(raw: string, source: string): string {
  const normalized = normalizeBaseUrl(raw);

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(
      `[kazhal] ${source} is not a valid absolute URL: ${JSON.stringify(raw)}. ` +
        `Expected something like "https://api.example.com".`,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `[kazhal] ${source} must use http or https, got ${JSON.stringify(parsed.protocol)} ` +
        `in ${JSON.stringify(raw)}.`,
    );
  }

  return normalized;
}

/**
 * Resolve the API base URL.
 *
 * Precedence:
 *  1. explicit argument (a caller that already knows, e.g. a test)
 *  2. `NEXT_PUBLIC_API_BASE_URL` — the only one the BROWSER can see
 *  3. `API_BASE_URL` — server-only, never read in a browser
 *  4. {@link DEFAULT_API_BASE_URL}
 */
export function resolveApiBaseUrl(explicit?: string): string {
  const fromExplicit = configured(explicit);
  if (fromExplicit !== undefined) {
    return validateOrigin(fromExplicit, "the explicit apiBaseUrl argument");
  }

  const fromPublic = publicApiBaseUrl();
  if (fromPublic !== undefined) {
    return validateOrigin(fromPublic, "NEXT_PUBLIC_API_BASE_URL");
  }

  const fromServer = serverOnlyEnv("API_BASE_URL");
  if (fromServer !== undefined) {
    return validateOrigin(fromServer, "API_BASE_URL");
  }

  return DEFAULT_API_BASE_URL;
}

/**
 * Resolve the realtime origin. Falls back to the API base URL, which is the
 * common deployment shape (the Socket.IO gateway is mounted on the API server).
 */
export function resolveRealtimeUrl(explicit?: string): string {
  const fromExplicit = configured(explicit);
  if (fromExplicit !== undefined) {
    return validateOrigin(fromExplicit, "the explicit realtimeUrl argument");
  }

  const fromPublic = publicRealtimeUrl();
  if (fromPublic !== undefined) {
    return validateOrigin(fromPublic, "NEXT_PUBLIC_REALTIME_URL");
  }

  const fromServer = serverOnlyEnv("REALTIME_URL");
  if (fromServer !== undefined) {
    return validateOrigin(fromServer, "REALTIME_URL");
  }

  return resolveApiBaseUrl();
}
