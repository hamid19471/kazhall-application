"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { ApiAudience, AuthoritativeChannel } from "@kazhal/api-client";
import type {
  ApiError,
  CartLine,
  CartView,
  Category,
  Session,
  UserRole,
} from "@kazhal/api-client";
import { createAuthoritativeChannel, isApiError } from "@kazhal/api-client";
import {
  ApiProvider,
  useApi,
  useApiQuery,
  useRealtimeEvent,
  useRealtimeInterest,
  useRealtimeResync,
} from "@kazhal/ui/api/react";

import { recordServerTime } from "@/lib/hooks";
import { createWebRealtimeTransport } from "@/lib/realtime-transport";

/**
 * App-wide providers.
 *
 * ## Why every screen in this app fetches on the CLIENT
 *
 * The API authenticates with httpOnly `access_token` / `refresh_token` cookies
 * and nothing else — there is no Bearer path at all. Those cookies are issued
 * by the API's origin (`localhost:8000` in development) while this app is
 * served from another (`localhost:8001`), so they only ride along on a request
 * the BROWSER makes with `credentials: "include"`. A Server Component fetching
 * the same route from Node would arrive anonymous, and `@kazhal/api-client`
 * deliberately has no cookie-forwarding path to paper over that.
 *
 * The consequence is not just that authenticated screens must be client-side —
 * it is that a `next build` must never depend on the API being up, which is
 * exactly what prerendering a Server Component catalogue page would do.
 *
 * ## What lives here
 *
 * `useSession` and `GET /cart` are needed by the header on every route. Calling
 * the hooks per component would mean one `/auth/me` per consumer, so they are
 * hoisted into contexts and fetched ONCE:
 *
 *  - {@link useAppSession} — the session, from `/auth/me`. The only session
 *    source; the JWT is httpOnly and is never decoded.
 *  - {@link useCart} — the server-authoritative basket plus its notices.
 *
 * ## Realtime
 *
 * One Socket.IO connection per provider lifecycle, carrying this tree's
 * audience and nothing else — see `lib/realtime-transport.ts`. Polling survives
 * only as a recovery fallback for the minutes the socket is unreachable.
 */
export function Providers({
  children,
  audience,
}: {
  children: ReactNode;
  /**
   * The storefront and the admin console are the SAME Next.js origin, so the
   * browser cannot tell them apart and neither could the old shared cookie.
   * Each route group mounts its own provider naming its own audience; that is
   * what stops the shop header showing whoever is signed into /admin, and
   * vice versa.
   */
  audience: ApiAudience;
}) {
  /*
   * ONE transport per provider instance, built with no dependencies.
   *
   * `createSocketIoTransport` passes `forceNew`, so every call to this factory
   * is a genuinely separate connection. Rebuilding it on a re-render would open
   * a socket per render; `ApiProvider` pairs `start` with `stop` in an effect,
   * which is what keeps React Strict Mode's mount → unmount → mount to one
   * live socket rather than two.
   */
  const transport = useMemo(() => createWebRealtimeTransport(), []);

  return (
    <ApiProvider
      transport={transport}
      /**
       * THE ADMIN CONSOLE OPENS NO SOCKET, because no admin screen consumes
       * one.
       *
       * All 27 admin routes are polled-on-navigation today; `grep useRealtime`
       * under the admin tree returns nothing. The provider was nonetheless
       * opening an `audience=admin` connection on every admin page load, which
       * joined rooms and then sat there — a live websocket, a re-validation
       * entry and a reconnect budget spent on zero subscribers.
       *
       * When an admin screen does start consuming events, this becomes `true`
       * and the room it needs should be a content-scoped, permission-gated one
       * beside `staff:availability` — not a widening of the super-admin room.
       */
      autoStartRealtime={audience !== "admin"}
      options={{
        audience,
        /*
         * THE SERVER'S CLOCK FEEDS EVERY COUNTDOWN ON THE PAGE.
         *
         * Wired once, here, rather than at each call site: the basket
         * reservation countdown, the checkout quote countdown and the OTP
         * cooldown must all agree about what time it is, and they would not if
         * each corrected itself from whichever response it happened to make.
         *
         * `recordServerTime` only ever adjusts what "now" means. It cannot move
         * a deadline and it cannot extend a reservation — see `lib/hooks.ts`
         * for the sampling rule and the sanity bound.
         */
        onServerTime: recordServerTime,
      }}
    >
      <SessionProvider>
        <CategoriesProvider>
          <CartProvider>{children}</CartProvider>
        </CategoriesProvider>
      </SessionProvider>
    </ApiProvider>
  );
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface AppSession {
  /** `undefined` while loading, `null` when signed out. */
  session: Session | null | undefined;
  isLoading: boolean;
  error: ApiError | undefined;
  /** True once `/auth/me` has answered, either way. */
  isResolved: boolean;
  refresh: () => void;
  /** Gates NAVIGATION only. The server is the authority on every request. */
  hasRole: (role: UserRole) => boolean;
}

const SessionContext = createContext<AppSession | null>(null);

function SessionProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const { data, error, isLoading } = useApiQuery<Session | null>(
    (signal) => api.auth.me({ signal }),
    [api, nonce],
  );

  // The client tells us when a refresh failed or a logout landed, so a stale
  // account menu cannot linger after the cookies are gone.
  useEffect(() => api.client.auth.onSignedOut(() => refresh()), [api, refresh]);

  const value = useMemo<AppSession>(
    () => ({
      session: data,
      isLoading,
      error,
      isResolved: !isLoading,
      refresh,
      hasRole: (role: UserRole) => data?.roles.includes(role) ?? false,
    }),
    [data, isLoading, error, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useAppSession(): AppSession {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useAppSession must be used inside <Providers>");
  return ctx;
}

// ---------------------------------------------------------------------------
// Categories
//
// The category tree is the storefront's navigation, so the header, the home
// page and the catalogue filters all want it. It is public, small and
// server-cached — but it is still one HTTP call, so it is fetched once here
// rather than once per consumer.
//
// There is NO hardcoded category list anywhere in this app. If `/categories`
// is empty, the nav is empty, and that is the truth about the shop.
// ---------------------------------------------------------------------------

export interface CategoriesState {
  categories: Category[];
  isLoading: boolean;
  error: ApiError | undefined;
  refresh: () => void;
}

const CategoriesContext = createContext<CategoriesState | null>(null);

function CategoriesProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const { data, error, isLoading } = useApiQuery(
    (signal) => api.catalog.listCategories({ signal }),
    [api, nonce],
  );

  const value = useMemo<CategoriesState>(
    () => ({ categories: data ?? [], isLoading, error, refresh }),
    [data, isLoading, error, refresh],
  );

  return <CategoriesContext.Provider value={value}>{children}</CategoriesContext.Provider>;
}

export function useCategories(): CategoriesState {
  const ctx = useContext(CategoriesContext);
  if (!ctx) throw new Error("useCategories must be used inside <Providers>");
  return ctx;
}

// ---------------------------------------------------------------------------
// Basket
// ---------------------------------------------------------------------------

export interface CartState {
  lines: CartLine[];
  /**
   * Basket-level notices: whole LINES whose `change` is non-null.
   *
   * `GET /cart` returns them as a SIBLING of `data`, not nested inside it, and
   * a notice can describe a line that is still present with a reduced quantity
   * — see `dedupeNotices`. It can also describe a line that is NO LONGER in
   * `data` at all, which is what a fully displaced basket line looks like, and
   * is why the reason lives on `notice.change` rather than on the notice.
   */
  notices: CartLine[];
  /** Sum of line quantities. `0` while loading or signed out. */
  itemCount: number;
  isLoading: boolean;
  error: ApiError | undefined;
  /**
   * Ask for authoritative state. Coalesced: bursts collapse into one in-flight
   * read plus at most one trailing read, so an event, a reconnect and a tab
   * focus arriving together cost two requests, not five.
   */
  refresh: () => void;
  /**
   * Run a basket MUTATION inside the ordering guarantee.
   *
   * Every call site that changes the basket must go through this rather than
   * calling `api.cart.*` and then `refresh()`. The bracket issues exactly one
   * authoritative read after the mutation settles — success or failure — and
   * the channel's ticketing makes that read outrank anything a POS event kicked
   * off while the mutation was in flight. Without it, a `GET /cart` racing a
   * `PATCH /cart/items/:id` can repaint the basket with pre-mutation state.
   */
  mutate: <T>(run: () => Promise<T>) => Promise<T>;
  /** True when the viewer is signed out — an empty basket, not a failure. */
  isAnonymous: boolean;
}

const CartContext = createContext<CartState | null>(null);

const CART_INTEREST = { kind: "cart" } as const;

/**
 * The latest authoritative `GET /cart`, tagged with the channel that produced
 * it. See {@link CartProvider} for why the tag exists.
 */
interface CartAnswer {
  owner: AuthoritativeChannel<CartView> | null;
  cart?: CartView;
  error?: ApiError;
  /** True once this channel has answered at all, success or failure. */
  settled: boolean;
}

/** Shared, so the derived-state comparison never allocates a new object. */
const EMPTY_ANSWER: CartAnswer = { owner: null, settled: false };

/** Collapses the `visibilitychange` + `focus` pair browsers fire together. */
const VISIBILITY_DEDUPE_MS = 1000;

function CartProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const { session, isResolved } = useAppSession();

  /*
   * THE BASKET IS A STOREFRONT THING, and `GET /cart` is `@Audiences('storefront')`.
   *
   * The admin console mounts these same providers (it needs the session and
   * the category list), and with only the signed-in test below it fired a
   * `/cart` request on every admin page load that the API answered 401 — a
   * failed authenticated request in the network panel on every screen,
   * invisible only because the error was swallowed as "signed out".
   *
   * The audience is read from the CLIENT, which was told once at construction,
   * so this cannot drift from whichever surface actually mounted the provider.
   */
  const cartSurface = api.client.audience === "storefront";
  const signedIn = Boolean(session) && cartSurface;

  /*
   * ===========================================================================
   * ONE AUTHORITATIVE CHANNEL FOR THE BASKET
   * ===========================================================================
   *
   * This replaces a `useApiQuery` driven by a nonce. The nonce was correct
   * about the important thing — realtime is advisory, only `GET /cart` decides
   * — but it issued one request per signal and aborted the previous one, so a
   * till sale touching three basket variants produced three `GET /cart` calls
   * of which two were cancelled mid-flight.
   *
   * The channel keeps exactly one read in flight and at most one trailing read,
   * and stamps every read with a monotonic ticket so a slow response can never
   * repaint over a newer one. See `createAuthoritativeChannel` for the two
   * failure modes it closes and `lib/authoritative-channel.test.ts` for the
   * cases that pin them.
   */
  const channel = useMemo<AuthoritativeChannel<CartView> | null>(() => {
    if (!signedIn) return null;
    // The channel has to tag its own results, so it needs a reference to
    // itself from inside the callbacks it is constructed with.
    const box: { self?: AuthoritativeChannel<CartView> } = {};
    box.self = createAuthoritativeChannel<CartView>({
      read: (signal) => api.cart.get({ signal }),
      onResult: (value) =>
        setAnswer({ owner: box.self ?? null, cart: value, settled: true }),
      onError: (cause) =>
        setAnswer({
          owner: box.self ?? null,
          error: isApiError(cause) ? cause : undefined,
          settled: true,
        }),
    });
    return box.self;
  }, [api, signedIn]);

  /**
   * The latest authoritative answer, TAGGED WITH THE CHANNEL THAT PRODUCED IT.
   *
   * Tagging is what lets "we have no basket for this session yet" be DERIVED
   * rather than assigned. The obvious shape — three `useState`s plus an effect
   * that resets them when the channel changes — needs a synchronous `setState`
   * inside an effect, which schedules a second render pass before the first has
   * painted and is exactly what React's `set-state-in-effect` rule is pointing
   * at. Comparing `owner` to the current channel costs nothing and removes the
   * write entirely.
   */
  const [answer, setAnswer] = useState<CartAnswer>(EMPTY_ANSWER);

  const current = answer.owner === channel ? answer : EMPTY_ANSWER;
  const cart = current.cart;
  const error = current.error;
  // Loading until this channel has answered once, either way.
  const isLoading = channel !== null && !current.settled;

  useEffect(() => {
    if (!channel) return;
    channel.refresh();
    // `stop()` aborts the in-flight read; it is NOT a latch, so React Strict
    // Mode's second mount re-fetches rather than sitting on an empty basket.
    return () => channel.stop();
  }, [channel]);

  const refresh = useCallback(() => {
    channel?.refresh();
  }, [channel]);

  const mutate = useCallback(
    async <T,>(run: () => Promise<T>): Promise<T> => {
      if (!channel) return run();
      const end = channel.beginMutation();
      try {
        return await run();
      } finally {
        end();
      }
    },
    [channel],
  );

  // Realtime is ADVISORY; HTTP is authoritative. Every path below only ever
  // asks the channel to refetch — no frame is allowed to mutate a line in
  // place, and no payload field is ever rendered.
  useRealtimeInterest(signedIn ? CART_INTEREST : null);
  useRealtimeResync(refresh);

  // `availability:updated` is the only GLOBAL broadcast in the whole API — it
  // fires for every variant in the shop — so refetching on each one would
  // hammer the server. Only the variants actually in this basket matter.
  //
  // The set is derived with `useMemo` rather than mirrored into a ref: writing
  // a ref during render is exactly the pattern that makes a component miss an
  // update, and the derived value is what the handler needs anyway.
  const basketVariantIds = useMemo(() => {
    const ids = new Set<number>();
    for (const line of cart?.data ?? []) {
      if (line.variant?.id !== undefined) ids.add(line.variant.id);
    }
    return ids;
  }, [cart]);

  useRealtimeEvent(
    "availability:invalidated",
    useCallback(
      (payload) => {
        /*
         * The payload names a variant, its product and a coarse reason, and
         * nothing else. None of it is written anywhere — it cannot describe a
         * reservation, and a reservation is what changed. It only decides
         * whether to ask.
         *
         * Matched on VARIANT, not product: a basket holds specific SKUs, and a
         * frame for a sibling variant of the same product changes nothing in
         * this basket.
         */
        if (basketVariantIds.has(payload.variantId)) refresh();
      },
      [refresh, basketVariantIds],
    ),
  );

  /*
   * ===========================================================================
   * RECONCILE WHEN THE TAB COMES BACK — the recovery path, no longer the path
   * ===========================================================================
   *
   * The basket is a SNAPSHOT of server-authoritative state that a till can
   * change at any moment: a cashier selling the last units displaces a
   * customer's hold and the line comes back reduced or gone, with
   * `sold_in_store` on it.
   *
   * That now arrives on the socket, in milliseconds, while the tab sits open
   * and untouched — which is the whole point of this workstream. This listener
   * is what is left of the previous design: a cheap belt-and-braces refetch for
   * the case where the socket AND the polling fallback both missed something
   * while the tab was hidden.
   *
   * `visibilitychange` and `focus` both fire in the common case, so the refetch
   * is collapsed by a short window — otherwise returning to the tab would issue
   * two identical `GET /cart` calls every time. The channel would coalesce the
   * second into a trailing read rather than a parallel one, but a trailing read
   * is still a request, and there is nothing to learn from it.
   */
  const lastReconcileRef = useRef(0);
  useEffect(() => {
    if (!signedIn) return;

    const reconcile = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastReconcileRef.current < VISIBILITY_DEDUPE_MS) return;
      lastReconcileRef.current = now;
      refresh();
    };

    document.addEventListener("visibilitychange", reconcile);
    window.addEventListener("focus", reconcile);
    return () => {
      document.removeEventListener("visibilitychange", reconcile);
      window.removeEventListener("focus", reconcile);
    };
  }, [signedIn, refresh]);

  const value = useMemo<CartState>(() => {
    const lines = signedIn ? (cart?.data ?? []) : [];
    return {
      lines,
      notices: signedIn ? (cart?.notices ?? []) : [],
      itemCount: lines.reduce((sum, line) => sum + (line.quantity ?? 0), 0),
      isLoading: signedIn ? isLoading : false,
      // A 401 here is "signed out", which the session context already models.
      error: signedIn && !isUnauthorizedError(error) ? error : undefined,
      refresh,
      mutate,
      isAnonymous: isResolved && !signedIn,
    };
  }, [signedIn, cart, isLoading, error, refresh, mutate, isResolved]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

function isUnauthorizedError(error: unknown): boolean {
  return isApiError(error) && error.status === 401;
}

export function useCart(): CartState {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used inside <Providers>");
  return ctx;
}
