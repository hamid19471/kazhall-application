/**
 * The local-development port contract: API 8000, Web (storefront and admin)
 * 8001, POS 8002, all started by `pnpm dev` at the repository root. Port 3000
 * belongs to another local service on the owner's machine, and 3000/3100/3200
 * were the previous defaults, so none of them may return.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";

import {
  DEFAULT_API_BASE_URL,
  DEFAULT_REALTIME_URL,
  resolveApiBaseUrl,
  resolveRealtimeUrl,
} from "../../../packages/api-client/src/config.ts";

const ENV = ["NEXT_PUBLIC_API_BASE_URL", "NEXT_PUBLIC_REALTIME_URL", "API_BASE_URL", "REALTIME_URL"];
const RETIRED = /\b(3000|3100|3200)\b/;

function json(relativePath: string): {
  scripts?: Record<string, string>;
  tasks?: Record<string, { passThroughEnv?: string[] }>;
} {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
}

afterEach(() => {
  for (const name of ENV) delete process.env[name];
});

describe("frontend API and realtime defaults", () => {
  it("default to the API on localhost:8000", () => {
    assert.equal(DEFAULT_API_BASE_URL, "http://localhost:8000");
    assert.equal(DEFAULT_REALTIME_URL, "http://localhost:8000");
  });

  it("resolve to localhost:8000 when nothing is configured", () => {
    for (const name of ENV) delete process.env[name];
    assert.equal(resolveApiBaseUrl(), "http://localhost:8000");
    assert.equal(resolveRealtimeUrl(), "http://localhost:8000");
  });

  it("are still overridden by the public environment variables", () => {
    process.env.NEXT_PUBLIC_API_BASE_URL = "https://api.kazhal.example";
    assert.equal(resolveApiBaseUrl(), "https://api.kazhal.example");
    assert.equal(resolveRealtimeUrl(), "https://api.kazhal.example");
    process.env.NEXT_PUBLIC_REALTIME_URL = "https://rt.kazhal.example";
    assert.equal(resolveRealtimeUrl(), "https://rt.kazhal.example");
  });
});

describe("app scripts", () => {
  const web = json("../package.json").scripts ?? {};
  const store = json("../../store/package.json").scripts ?? {};

  it("serves Web on 8001 in dev and production start", () => {
    assert.equal(web.dev, "next dev -p 8001");
    assert.equal(web.start, "next start -p 8001");
  });

  it("serves POS on 8002 in dev and production start", () => {
    assert.equal(store.dev, "next dev -p 8002");
    assert.equal(store.start, "next start -p 8002");
  });

  it("use none of the retired ports", () => {
    for (const script of [...Object.values(web), ...Object.values(store)]) {
      assert.doesNotMatch(script, RETIRED);
    }
  });
});

describe("root pnpm dev", () => {
  it("runs every app's dev task through turbo", () => {
    assert.equal(json("../../../package.json").scripts?.dev, "turbo run dev");
  });

  it("lets an explicit PORT reach the API through turbo's strict env mode", () => {
    const passThrough = json("../../../turbo.json").tasks?.dev?.passThroughEnv ?? [];
    assert.ok(passThrough.includes("PORT"));
  });
});
