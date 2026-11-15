"use client";

import { useMemo, type ReactNode } from "react";

import { ApiProvider } from "@kazhal/ui/api/react";

import { createPosRealtimeTransport } from "@/lib/realtime-transport";

/**
 * The client boundary for every till screen.
 *
 * `app/layout.tsx` is owned by another workstream and is left untouched, so the
 * provider is mounted per route subtree instead of once at the root. That is
 * harmless here: the session lives in httpOnly cookies, not in this context, so
 * a provider re-created on navigation loses nothing that matters.
 *
 * Realtime is Socket.IO first, polling only while the socket is down — see
 * `lib/realtime-transport.ts`. The transport is built in a dependency-free
 * `useMemo` so one till screen opens exactly one socket, and `ApiProvider`'s
 * own `useEffect` pairs every `start` with a `stop`, which is what keeps React
 * Strict Mode's mount → unmount → mount to a single live connection.
 */
export function StoreProviders({
  children,
  /**
   * Whether this subtree needs a live socket. Default `true`.
   *
   * `false` for the screens that are reached WITHOUT a POS session — the login
   * form and the forced password change. There is no anonymous mode for the
   * till (every frame it receives is staff data), so a socket opened there is
   * an impossible handshake: the gateway refuses it, the client reports
   * `connect_error`, the polling fallback then arms itself against endpoints
   * that answer 401, and the browser's network panel fills with failures on the
   * one screen where nothing can possibly be listening.
   */
  realtime = true,
}: {
  children: ReactNode;
  realtime?: boolean;
}) {
  const transport = useMemo(() => createPosRealtimeTransport(), []);

  // The till names itself. Its cookie pair is `kz_pos_*`, so a storefront or
  // admin session open in the same browser is invisible here — and signing out
  // of either of them leaves the till signed in. The handshake asks for the POS
  // cookie BY NAME, so the same is true of the socket.
  return (
    <ApiProvider
      options={{ audience: "pos" }}
      transport={transport}
      autoStartRealtime={realtime}
    >
      {children}
    </ApiProvider>
  );
}
