/**
 * ============================================================================
 * API CLIENT CONFIG — precedence, validation, and the browser/server split.
 *
 * THE BUG THIS PINS. `config.ts` used to read its public variables through
 * `readEnv("NEXT_PUBLIC_API_BASE_URL")`. A bundler inlines the literal text
 * `process.env.NEXT_PUBLIC_FOO`; it cannot inline a computed lookup, and there
 * is no `process` in the browser for one to read afterwards. So the browser
 * always fell through to the localhost default — invisible in development,
 * where the API really is on that port, and fatal in production.
 *
 * A unit test cannot run a bundler, so it cannot prove the inlining directly —
 * that is proven separately by grepping the built browser chunks for the
 * configured host. What it CAN prove, and does here, is every rule around it:
 * precedence, empty and whitespace handling, trailing slashes, rejection of
 * unusable values, and that a server-only variable is never consulted in a
 * browser.
 *
 * Imported by relative path with an explicit extension, matching the other
 * specs in this directory (`node --test`, no bundler, no tsconfig paths).
 * ============================================================================
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  DEFAULT_API_BASE_URL,
  isBrowser,
  normalizeBaseUrl,
  resolveApiBaseUrl,
  resolveRealtimeUrl,
} from "../../../packages/api-client/src/config.ts";

const PUBLIC_API = "NEXT_PUBLIC_API_BASE_URL";
const PUBLIC_RT = "NEXT_PUBLIC_REALTIME_URL";
const SERVER_API = "API_BASE_URL";
const SERVER_RT = "REALTIME_URL";
const ALL = [PUBLIC_API, PUBLIC_RT, SERVER_API, SERVER_RT];

function clearEnv(): void {
  for (const name of ALL) delete process.env[name];
}

/**
 * Pretend to be a browser for the duration of `fn`.
 *
 * `isBrowser()` tests `window` and `window.document`, so defining a minimal
 * stand-in exercises the real branch rather than a mocked one.
 */
async function asBrowser(fn: () => void | Promise<void>): Promise<void> {
  const g = globalThis as { window?: unknown };
  const had = "window" in g;
  const previous = g.window;
  g.window = { document: {} };
  try {
    await fn();
  } finally {
    if (had) g.window = previous;
    else delete g.window;
  }
}

afterEach(() => {
  clearEnv();
});

describe("resolveApiBaseUrl precedence", () => {
  it("1. an explicit argument outranks everything", () => {
    process.env[PUBLIC_API] = "https://public.example.com";
    process.env[SERVER_API] = "https://server.example.com";
    assert.equal(
      resolveApiBaseUrl("https://explicit.example.com"),
      "https://explicit.example.com",
    );
  });

  it("2. the PUBLIC variable outranks the server-only one", () => {
    process.env[PUBLIC_API] = "https://public.example.com";
    process.env[SERVER_API] = "https://server.example.com";
    assert.equal(resolveApiBaseUrl(), "https://public.example.com");
  });

  it("3. the server-only variable is used on the server when no public one is set", () => {
    process.env[SERVER_API] = "https://server.example.com";
    assert.equal(isBrowser(), false, "this test must run on the server side");
    assert.equal(resolveApiBaseUrl(), "https://server.example.com");
  });

  it("4. falls back to the local default when nothing is configured", () => {
    assert.equal(resolveApiBaseUrl(), DEFAULT_API_BASE_URL);
  });
});

describe("server-only variables never reach the browser", () => {
  it("ignores API_BASE_URL in a browser and falls back to the default", async () => {
    process.env[SERVER_API] = "https://internal.cluster.local";
    await asBrowser(() => {
      assert.equal(isBrowser(), true);
      // The server-only value must NOT be used here; it may name an in-cluster
      // host that must never be published to a client.
      assert.equal(resolveApiBaseUrl(), DEFAULT_API_BASE_URL);
    });
    // ...and is used again the moment we are back on the server.
    assert.equal(resolveApiBaseUrl(), "https://internal.cluster.local");
  });

  it("still honours the PUBLIC variable in a browser", async () => {
    process.env[PUBLIC_API] = "https://api.kazhal.example";
    await asBrowser(() => {
      assert.equal(resolveApiBaseUrl(), "https://api.kazhal.example");
    });
  });

  it("ignores REALTIME_URL in a browser", async () => {
    process.env[SERVER_RT] = "https://rt.cluster.local";
    process.env[PUBLIC_API] = "https://api.kazhal.example";
    await asBrowser(() => {
      // Falls through to the API base URL, not to the server-only realtime host.
      assert.equal(resolveRealtimeUrl(), "https://api.kazhal.example");
    });
  });
});

/**
 * ============================================================================
 * THE GUARD THAT DEFEATED THE FIX.
 *
 * `config.ts` briefly read its public variables like this:
 *
 *     if (typeof process === "undefined") return undefined;
 *     return configured(process.env.NEXT_PUBLIC_API_BASE_URL);
 *
 * This version of Next does not define `process` in the browser, so the guard
 * was TRUE on every page load and the function returned before reaching the
 * inlined literal. Every browser fell back to the localhost default — the
 * original defect, one line higher up. The bundle-grep proof did not catch it,
 * because the value really was inlined; it was inlined into unreachable code.
 *
 * These tests delete `globalThis.process` to reproduce that environment
 * faithfully: a bare `process` reference then throws `ReferenceError`, exactly
 * as it would in a bundle with no define plugin and no shim.
 * ============================================================================
 */
describe("a browser where `process` does not exist at all", () => {
  /** Run `fn` with `globalThis.process` removed, restoring it afterwards. */
  function withoutProcess<T>(fn: () => T): T {
    const g = globalThis as { process?: unknown };
    const saved = g.process;
    delete g.process;
    try {
      return fn();
    } finally {
      g.process = saved;
    }
  }

  it("does not throw when no bundler substituted the value", () => {
    withoutProcess(() => {
      assert.doesNotThrow(() => resolveApiBaseUrl());
      assert.doesNotThrow(() => resolveRealtimeUrl());
    });
  });

  it("falls back to the default rather than exploding", () => {
    withoutProcess(() => {
      assert.equal(resolveApiBaseUrl(), DEFAULT_API_BASE_URL);
    });
  });

  it("still honours an explicit argument", () => {
    // The caller-supplied value never depended on `process` and must survive.
    withoutProcess(() => {
      assert.equal(
        resolveApiBaseUrl("https://explicit.example.com"),
        "https://explicit.example.com",
      );
    });
  });

  it("reads the public variable again once `process` is back", () => {
    // Proves the previous cases removed nothing permanently, and that the
    // read really is attempted rather than skipped by a cached decision.
    withoutProcess(() => resolveApiBaseUrl());
    process.env[PUBLIC_API] = "https://api.kazhal.example";
    assert.equal(resolveApiBaseUrl(), "https://api.kazhal.example");
  });
});

describe("missing, empty and whitespace values behave as unset", () => {
  it("treats an empty string as not configured", () => {
    process.env[PUBLIC_API] = "";
    assert.equal(resolveApiBaseUrl(), DEFAULT_API_BASE_URL);
  });

  it("treats a whitespace-only string as not configured", () => {
    process.env[PUBLIC_API] = "   ";
    assert.equal(resolveApiBaseUrl(), DEFAULT_API_BASE_URL);
  });

  it("treats an empty explicit argument as not configured", () => {
    process.env[PUBLIC_API] = "https://public.example.com";
    assert.equal(resolveApiBaseUrl(""), "https://public.example.com");
  });

  it("falls through an empty public value to the server-only one", () => {
    process.env[PUBLIC_API] = "";
    process.env[SERVER_API] = "https://server.example.com";
    assert.equal(resolveApiBaseUrl(), "https://server.example.com");
  });
});

describe("trailing slashes and surrounding whitespace", () => {
  it("strips a single trailing slash", () => {
    process.env[PUBLIC_API] = "https://api.example.com/";
    assert.equal(resolveApiBaseUrl(), "https://api.example.com");
  });

  it("strips several trailing slashes", () => {
    process.env[PUBLIC_API] = "https://api.example.com///";
    assert.equal(resolveApiBaseUrl(), "https://api.example.com");
  });

  it("keeps a path prefix but drops its trailing slash", () => {
    process.env[PUBLIC_API] = "https://example.com/api/";
    assert.equal(resolveApiBaseUrl(), "https://example.com/api");
  });

  it("trims surrounding whitespace", () => {
    process.env[PUBLIC_API] = "  https://api.example.com  ";
    assert.equal(resolveApiBaseUrl(), "https://api.example.com");
  });

  it("normalizeBaseUrl is exported and does the same thing", () => {
    assert.equal(normalizeBaseUrl("https://x.example.com//"), "https://x.example.com");
    assert.equal(normalizeBaseUrl("  https://x.example.com "), "https://x.example.com");
  });
});

describe("an unusable configured value is refused, never silently downgraded", () => {
  it("throws on a value that is not an absolute URL", () => {
    process.env[PUBLIC_API] = "api.example.com";
    assert.throws(() => resolveApiBaseUrl(), /NEXT_PUBLIC_API_BASE_URL/);
  });

  it("throws on a non-http protocol", () => {
    process.env[PUBLIC_API] = "ftp://api.example.com";
    assert.throws(() => resolveApiBaseUrl(), /http or https/);
  });

  it("names the explicit argument when that is what is wrong", () => {
    assert.throws(() => resolveApiBaseUrl("nonsense"), /explicit apiBaseUrl argument/);
  });

  it("does NOT fall back to localhost on a bad value", () => {
    // The whole point: a deployment mistake must be loud. Degrading to
    // localhost is how the original defect stayed hidden for so long.
    process.env[PUBLIC_API] = "nonsense";
    assert.throws(() => resolveApiBaseUrl());
  });
});

describe("resolveRealtimeUrl", () => {
  it("prefers its own public variable", () => {
    process.env[PUBLIC_API] = "https://api.example.com";
    process.env[PUBLIC_RT] = "https://rt.example.com";
    assert.equal(resolveRealtimeUrl(), "https://rt.example.com");
  });

  it("falls back to the API base URL when unset", () => {
    process.env[PUBLIC_API] = "https://api.example.com";
    assert.equal(resolveRealtimeUrl(), "https://api.example.com");
  });

  it("falls back to the local default when nothing at all is set", () => {
    assert.equal(resolveRealtimeUrl(), DEFAULT_API_BASE_URL);
  });

  it("honours an explicit argument above everything", () => {
    process.env[PUBLIC_RT] = "https://rt.example.com";
    assert.equal(
      resolveRealtimeUrl("https://explicit.example.com"),
      "https://explicit.example.com",
    );
  });
});
