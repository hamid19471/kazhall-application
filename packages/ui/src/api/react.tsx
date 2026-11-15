"use client";

/**
 * Minimal React bindings for `@kazhal/api-client`.
 *
 * There is **no data-fetching library installed** in either front-end app, so
 * this is deliberately small and platform-only: React 19 hooks plus `fetch`.
 * It is not a cache and does not try to be one — prefer Server Components and
 * `fetch` on the server, and reach for these hooks only for genuinely
 * client-side, interactive state (cart badge, session menu, live availability).
 *
 * Import path: `@kazhal/ui/api/react` (re-exported from `@kazhal/ui`).
 *
 * It lives in `packages/ui` rather than `packages/api-client` for a concrete
 * reason: `packages/ui` is the only shared folder with `react`, `react-dom` and
 * `@types/react` in its `node_modules`, so `tsc` and the bundler can both
 * resolve React from source here without adding a dependency anywhere.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DependencyList, ReactNode } from "react";

import {
  createKazhalApi,
  createRealtimeClient,
  isApiError,
  type ApiError,
  type KazhalApi,
  type KazhalApiOptions,
  type RealtimeClient,
  type RealtimeEventMap,
  type RealtimeEventName,
  type RealtimeInterest,
  type RealtimeStatus,
  type RealtimeTransport,
  type ResyncReason,
  type Session,
} from "@kazhal/api-client";

interface ApiContextValue {
  api: KazhalApi;
  realtime: RealtimeClient;
}

const ApiContext = createContext<ApiContextValue | null>(null);

export interface ApiProviderProps {
  children: ReactNode;
  /** Options for the client created on first render. Ignored if `api` is given. */
  options?: KazhalApiOptions;
  /** Supply a pre-built API surface (e.g. one shared with server code). */
  api?: KazhalApi;
  /** Swap the realtime transport — see `createSocketIoTransport`. */
  transport?: RealtimeTransport;
  /** Start the realtime client on mount. Default `true`. */
  autoStartRealtime?: boolean;
}

export function ApiProvider({
  children,
  options,
  api: providedApi,
  transport,
  autoStartRealtime = true,
}: ApiProviderProps) {
  const value = useMemo<ApiContextValue>(() => {
    // `options` is required unless a ready-made api is passed: the client
    // cannot be built without naming an audience, and defaulting one here
    // would quietly recreate the shared session this replaces.
    const api =
      providedApi ??
      createKazhalApi(
        options ?? (() => { throw new Error("ApiProvider needs `options.audience` or an `api`"); })(),
      );
    const realtime = createRealtimeClient({
      client: api.client,
      ...(transport ? { transport } : {}),
    });
    return { api, realtime };
    // The client is intentionally created ONCE per provider instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!autoStartRealtime) return;
    value.realtime.start();
    return () => value.realtime.stop("unmount");
  }, [value, autoStartRealtime]);

  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

function useApiContext(): ApiContextValue {
  const ctx = useContext(ApiContext);
  if (!ctx) throw new Error("useApi must be used inside <ApiProvider>");
  return ctx;
}

export function useApi(): KazhalApi {
  return useApiContext().api;
}

export function useRealtimeClient(): RealtimeClient {
  return useApiContext().realtime;
}

// ---------------------------------------------------------------------------
// Async query
// ---------------------------------------------------------------------------

export interface QueryState<T> {
  data: T | undefined;
  error: ApiError | undefined;
  isLoading: boolean;
  /** Re-run the query. Cancels any in-flight run first. */
  refetch: () => void;
}

/**
 * Run an async function on mount and whenever `deps` change, with cancellation.
 *
 * ```ts
 * const { data, error, isLoading } = useApiQuery(
 *   (signal) => api.catalog.listProducts({ page }, { signal }),
 *   [page],
 * );
 * ```
 *
 * The `signal` argument is wired to an `AbortController` that fires on unmount
 * and on every dependency change, so a stale response can never win a race.
 */
export function useApiQuery<T>(
  run: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
  options: { enabled?: boolean } = {},
): QueryState<T> {
  const enabled = options.enabled !== false;
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(enabled);
  const [nonce, setNonce] = useState(0);
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setIsLoading(true);
    setError(undefined);

    runRef
      .current(controller.signal)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setIsLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (isApiError(cause) && cause.kind === "aborted") return;
        setError(isApiError(cause) ? cause : undefined);
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, nonce, ...deps]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, isLoading, refetch };
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface SessionState {
  session: Session | null | undefined;
  isLoading: boolean;
  error: ApiError | undefined;
  refresh: () => void;
  /** `roles.includes(role)` with an undefined-safe default of `false`. */
  hasRole: (role: Session["roles"][number]) => boolean;
}

/**
 * The session, from `GET /auth/<audience>/me` — the ONLY authoritative source.
 *
 * Never decode the httpOnly JWT in the browser: it is unreadable by design, and
 * `roles`/`branchId` are re-read from the database on every request anyway.
 *
 * Re-runs automatically when the client transitions to signed-out (failed
 * refresh, explicit logout), so a stale menu cannot linger.
 */
export function useSession(): SessionState {
  const api = useApi();
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const { data, error, isLoading } = useApiQuery<Session | null>(
    (signal) => api.auth.me({ signal }),
    [api, nonce],
  );

  useEffect(() => api.client.auth.onSignedOut(() => refresh()), [api, refresh]);

  const hasRole = useCallback(
    (role: Session["roles"][number]) => data?.roles.includes(role) ?? false,
    [data],
  );

  return { session: data, isLoading, error, refresh, hasRole };
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

/** Subscribe to one realtime event for the lifetime of the component. */
export function useRealtimeEvent<K extends RealtimeEventName>(
  event: K,
  handler: (payload: RealtimeEventMap[K]) => void,
): void {
  const realtime = useRealtimeClient();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(
    () => realtime.on(event, (payload) => handlerRef.current(payload)),
    [realtime, event],
  );
}

/**
 * Declare what this component cares about so the polling fallback watches it.
 * A no-op cost once a real Socket.IO transport is installed.
 *
 * Pass a memoized `interest` (or a primitive-derived one) — it is compared by
 * identity.
 */
export function useRealtimeInterest(interest: RealtimeInterest | null): void {
  const realtime = useRealtimeClient();
  useEffect(() => {
    if (!interest) return;
    return realtime.track(interest);
  }, [realtime, interest]);
}

/**
 * Run `handler` after every (re)connect. **This is where you refetch.** Missed
 * frames are recovered here, not by trusting the event stream.
 */
export function useRealtimeResync(handler: (reason: ResyncReason) => void): void {
  const realtime = useRealtimeClient();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => realtime.onResync((reason) => handlerRef.current(reason)), [realtime]);
}

/** The current transport status, for a connection indicator. */
export function useRealtimeStatus(): RealtimeStatus {
  const realtime = useRealtimeClient();
  const [status, setStatus] = useState<RealtimeStatus>(realtime.status);
  useEffect(() => {
    setStatus(realtime.status);
    return realtime.onStatus(setStatus);
  }, [realtime]);
  return status;
}
