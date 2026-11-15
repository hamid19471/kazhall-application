/**
 * The transport: one `fetch` wrapper that every resource helper goes through.
 *
 * Responsibilities, in order:
 *  1. URL building (base URL + path + query)
 *  2. `credentials: "include"` on EVERY request — the API authenticates with
 *     httpOnly `access_token` / `refresh_token` cookies and nothing else
 *  3. `Idempotency-Key` injection, stable across retries of one logical attempt
 *  4. envelope unwrapping (see `envelope.ts`)
 *  5. error-envelope parsing into a single `ApiError` (see `errors.ts`)
 *  6. single-flight 401 refresh + EXACTLY ONE retry (see `auth-coordinator.ts`)
 *  7. cancellation via `AbortSignal` (+ optional timeout)
 *
 * Explicitly NOT a responsibility: reading the JWT. The access token is
 * httpOnly; it is unreadable from JS by design and must never be decoded even
 * if it leaks into a readable location. `GET /auth/<audience>/me` — this
 * client's own audience, never another's — is the only authoritative session
 * source.
 */

import { AuthCoordinator, type SignedOutReason } from "./auth-coordinator";
import { ApiAudience, authRoutes } from "./audience";
import { isBrowser, resolveApiBaseUrl } from "./config";
import { type EnvelopeMode, unwrapEnvelope } from "./envelope";
import { ApiError } from "./errors";
import {
  IDEMPOTENCY_HEADER,
  type IdempotentAttempt,
  createIdempotencyKey,
  resolveIdempotencyKey,
} from "./idempotency";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "HEAD";

/** Primitive-ish values accepted in a query string. Arrays become CSV. */
export type QueryValue = string | number | boolean | null | undefined | Array<string | number>;
export type QueryParams = Record<string, QueryValue>;

/** Next.js `fetch` extensions. Ignored outside Next; typed loosely on purpose. */
export interface NextFetchOptions {
  revalidate?: number | false;
  tags?: string[];
}

export interface RequestOptions {
  method?: HttpMethod;
  /** JSON-encoded unless it is a `FormData`, `Blob`, `URLSearchParams` or string. */
  body?: unknown;
  query?: QueryParams;
  headers?: Record<string, string>;
  /** Caller cancellation. Combined with any `timeoutMs`. */
  signal?: AbortSignal;
  /** Default `"auto"`. See {@link EnvelopeMode}. */
  envelope?: EnvelopeMode;
  /**
   * Idempotency key for this call. Pass an {@link IdempotentAttempt} so the
   * SAME key is reused across retries of one logical attempt.
   */
  idempotencyKey?: string | IdempotentAttempt;
  /** Client-side timeout in ms. `0`/omitted disables it. */
  timeoutMs?: number;
  /** Participate in the 401 refresh flow. Default `true`. */
  auth?: boolean;
  /**
   * Extra statuses to treat as success. Needed for `GET /health`, which answers
   * 503 with a `success: true` body when the database is down.
   */
  acceptStatuses?: number[];
  /** Standard `fetch` cache mode. */
  cache?: RequestCache;
  /** Next.js-only fetch options (`revalidate`, `tags`). */
  next?: NextFetchOptions;
  /**
   * Extra request-scoped context forwarded to `onRequest`/`onResponse` hooks.
   * Useful for correlation ids in server logs.
   */
  meta?: Record<string, unknown>;
}

/** A response with its transport metadata, for callers that need the status. */
export interface ApiResponse<T> {
  data: T;
  status: number;
  headers: Headers;
  /** The success envelope's `timeStamp`, when present. */
  serverTime: string | undefined;
}

export interface ApiClientOptions {
  /**
   * Which application this client is. Decides which `/auth/<audience>/*`
   * routes it calls and therefore which cookie pair authenticates it.
   * Required: there is no ambiguous shared session to fall back to.
   */
  audience: ApiAudience;
  /** Overrides `NEXT_PUBLIC_API_BASE_URL` / `API_BASE_URL`. */
  baseUrl?: string;
  /** Injected for tests / server-side instrumentation. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Merged into every request. Per-request headers win. */
  defaultHeaders?: Record<string, string>;
  /** Applied when a request does not set `timeoutMs`. */
  defaultTimeoutMs?: number;
  /** Called on every signed-out transition (failed refresh, explicit logout). */
  onSignedOut?: (reason: SignedOutReason) => void;
  /** Observability hooks. Must not throw. */
  onRequest?: (info: { method: HttpMethod; url: string; meta?: Record<string, unknown> }) => void;
  onResponse?: (info: {
    method: HttpMethod;
    url: string;
    status: number;
    durationMs: number;
    meta?: Record<string, unknown>;
  }) => void;
  onError?: (error: ApiError) => void;

  /**
   * Every success envelope's `timeStamp`, as it arrives.
   *
   * WHY THIS EXISTS. A countdown rendered in the browser is only as trustworthy
   * as the browser's clock, and a device whose clock is minutes fast shows a
   * four-hour basket reservation expiring early — or, worse, one whose clock is
   * slow shows time remaining on a hold the server has already released. The
   * API states its own `now` on every successful response, so the client can
   * measure the offset instead of trusting the device.
   *
   * `receivedAtMs` is `Date.now()` at the moment the body was parsed, so the
   * caller can compute `serverTime - receivedAt` itself and decide how much
   * network latency to attribute to it. This callback deliberately does NOT
   * compute or store an offset: transport code should report a fact, not own a
   * policy about clocks.
   *
   * Fires for successful responses only — an error envelope carries a
   * `timestamp` (lower-case `s`) which is a different field with a different
   * shape, and conflating the two is how a clock correction becomes a bug.
   */
  onServerTime?: (serverTimeIso: string, receivedAtMs: number) => void;
}

const JSON_CONTENT_TYPE = "application/json";

function isBodyInit(value: unknown): value is BodyInit {
  if (typeof value === "string") return true;
  if (typeof FormData !== "undefined" && value instanceof FormData) return true;
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  if (typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams) return true;
  if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return true;
  return false;
}

export function buildQueryString(query: QueryParams | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      // The API's `AvailabilityQueryDto` accepts comma-separated OR repeated
      // params; CSV keeps URLs short and is accepted everywhere.
      params.set(key, value.join(","));
      continue;
    }
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs.length > 0 ? `?${qs}` : "";
}

/** Combine caller cancellation with an optional timeout into one signal. */
function combineSignals(
  external: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal | undefined; cleanup: () => void; timedOut: () => boolean } {
  if (!external && !timeoutMs) {
    return { signal: undefined, cleanup: () => undefined, timedOut: () => false };
  }

  const controller = new AbortController();
  let didTimeout = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const abortFromExternal = () => controller.abort(external?.reason);

  if (external) {
    if (external.aborted) abortFromExternal();
    else external.addEventListener("abort", abortFromExternal, { once: true });
  }

  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      external?.removeEventListener("abort", abortFromExternal);
    },
    timedOut: () => didTimeout,
  };
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return null;
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not JSON — hand back the raw text so the error message stays useful.
    return text;
  }
}

/**
 * The API client. Create one per app (see `createApiClient`) and share it.
 */
export class ApiClient {
  readonly baseUrl: string;
  readonly auth: AuthCoordinator;
  /** Fixed at construction; every auth route this client calls derives from it. */
  readonly audience: ApiAudience;

  private readonly fetchImpl: typeof fetch;
  private readonly defaultHeaders: Record<string, string>;
  private readonly defaultTimeoutMs: number | undefined;
  private readonly options: ApiClientOptions;

  constructor(options: ApiClientOptions) {
    this.options = options;
    this.audience = options.audience;
    this.baseUrl = resolveApiBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.auth = new AuthCoordinator({
      refresh: () => this.performRefresh(),
      ...(options.onSignedOut ? { onSignedOut: options.onSignedOut } : {}),
    });
  }

  /** Absolute URL for a path, useful for `<form action>` or a Socket.IO origin. */
  url(path: string, query?: QueryParams): string {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return `${this.baseUrl}${normalized}${buildQueryString(query)}`;
  }

  /**
   * `POST /auth/<audience>/refresh`. Never retried, never recursive.
   *
   * The route is public and reads only this audience's refresh cookie, so a
   * storefront refresh can no longer rotate — or invalidate — the till's
   * session, which is what the single shared cookie used to do.
   */
  private async performRefresh(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(this.url(authRoutes(this.audience).refresh), {
        method: "POST",
        credentials: "include",
        headers: { Accept: JSON_CONTENT_TYPE, ...this.defaultHeaders },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Full response including status/headers. */
  async requestDetailed<T>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    const method = options.method ?? "GET";
    const url = this.url(path, options.query);
    const envelopeMode: EnvelopeMode = options.envelope ?? "auto";
    const participatesInAuth = options.auth !== false;

    // Resolved ONCE per call so the post-refresh retry re-sends the SAME key.
    // A caller-supplied `IdempotentAttempt` keeps it stable across their own
    // retries too. Keys are never auto-minted: only `POST /orders` and
    // `POST /orders/pos` accept the header, and `resources/orders` supplies it.
    const idempotencyKey = resolveIdempotencyKey(options.idempotencyKey);

    const attemptGeneration = this.auth.generation;
    let refreshed = false;

    for (let attempt = 0; ; attempt += 1) {
      const started = Date.now();
      const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
      const { signal, cleanup, timedOut } = combineSignals(options.signal, timeoutMs);

      const headers: Record<string, string> = {
        Accept: JSON_CONTENT_TYPE,
        ...this.defaultHeaders,
        ...options.headers,
      };
      if (idempotencyKey) headers[IDEMPOTENCY_HEADER] = idempotencyKey;

      let body: BodyInit | undefined;
      if (options.body !== undefined && options.body !== null) {
        if (isBodyInit(options.body)) {
          body = options.body;
        } else {
          body = JSON.stringify(options.body);
          headers["Content-Type"] = JSON_CONTENT_TYPE;
        }
      }

      const init: RequestInit & { next?: NextFetchOptions } = {
        method,
        headers,
        // Non-negotiable: the API has no Bearer path at all.
        credentials: "include",
      };
      if (body !== undefined) init.body = body;
      if (signal) init.signal = signal;
      if (options.cache) init.cache = options.cache;
      if (options.next) init.next = options.next;

      this.options.onRequest?.({ method, url, ...(options.meta ? { meta: options.meta } : {}) });

      let response: Response;
      try {
        response = await this.fetchImpl(url, init);
      } catch (cause) {
        cleanup();
        if (timedOut()) {
          throw this.fail(ApiError.timeout(timeoutMs ?? 0, { path, method }));
        }
        if (options.signal?.aborted || (cause instanceof Error && cause.name === "AbortError")) {
          throw this.fail(ApiError.aborted({ path, method }));
        }
        throw this.fail(
          ApiError.network(
            cause instanceof Error ? cause.message : "Network request failed",
            cause,
            { path, method },
          ),
        );
      }
      cleanup();

      const parsed = await readBody(response);
      this.options.onResponse?.({
        method,
        url,
        status: response.status,
        durationMs: Date.now() - started,
        ...(options.meta ? { meta: options.meta } : {}),
      });

      const accepted = response.ok || (options.acceptStatuses?.includes(response.status) ?? false);
      if (accepted) {
        const serverTime = readServerTime(parsed);
        // Reported before the body is handed back, so a caller that keeps a
        // clock offset has it in hand by the time it renders the data.
        if (serverTime !== undefined) {
          this.options.onServerTime?.(serverTime, Date.now());
        }
        return {
          data: unwrapEnvelope<T>(parsed, envelopeMode),
          status: response.status,
          headers: response.headers,
          serverTime,
        };
      }

      // ---- 401: single-flight refresh, then EXACTLY ONE retry -------------
      if (response.status === 401 && participatesInAuth && !refreshed && attempt === 0) {
        refreshed = true;
        const ok = await this.auth.ensureFresh(attemptGeneration);
        if (ok) continue; // retry once, same idempotency key
        // Refresh failed → signed out. Fall through and surface the 401.
      }

      throw this.fail(
        ApiError.fromResponse(response.status, parsed, {
          path,
          method,
          headers: response.headers,
        }),
      );
    }
  }

  private fail(error: ApiError): ApiError {
    this.options.onError?.(error);
    return error;
  }

  /** The common case: unwrapped payload only. */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const result = await this.requestDetailed<T>(path, options);
    return result.data;
  }

  get<T>(path: string, options: Omit<RequestOptions, "method" | "body"> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: "GET" });
  }

  post<T>(path: string, body?: unknown, options: Omit<RequestOptions, "method" | "body"> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: "POST", body });
  }

  patch<T>(path: string, body?: unknown, options: Omit<RequestOptions, "method" | "body"> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: "PATCH", body });
  }

  put<T>(path: string, body?: unknown, options: Omit<RequestOptions, "method" | "body"> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: "PUT", body });
  }

  /**
   * `DELETE`. Note `DELETE /roles/remove` takes a JSON BODY — that is why this
   * signature accepts one.
   */
  delete<T>(path: string, body?: unknown, options: Omit<RequestOptions, "method" | "body"> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: "DELETE", body });
  }

  /** Mint a key without going through `beginIdempotentAttempt`. */
  newIdempotencyKey(prefix?: string): string {
    return createIdempotencyKey(prefix);
  }
}

function readServerTime(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const ts = (body as Record<string, unknown>)["timeStamp"];
  return typeof ts === "string" ? ts : undefined;
}

/** Warn once if a browser client was created without a configured base URL. */
let warnedAboutDefaultBaseUrl = false;

/** Preferred entry point. */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const client = new ApiClient(options);
  if (
    isBrowser() &&
    !warnedAboutDefaultBaseUrl &&
    typeof console !== "undefined" &&
    client.baseUrl === resolveApiBaseUrl() &&
    client.baseUrl.includes("localhost")
  ) {
    warnedAboutDefaultBaseUrl = true;
    console.info(
      "[kazhal] API base URL falls back to %s. Set NEXT_PUBLIC_API_BASE_URL for non-local environments.",
      client.baseUrl,
    );
  }
  return client;
}
