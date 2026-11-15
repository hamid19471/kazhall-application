/**
 * A one-session hand-off between the till and the receipt screen.
 *
 * `sessionStorage`, not `localStorage`: a receipt belongs to the shift at this
 * terminal, and must not survive the browser being closed or leak into another
 * tab's session. It is a CONVENIENCE cache only — the receipt screen always
 * re-reads `GET /orders/:id`, which is the authoritative record and the
 * only path that works for a receipt looked up later.
 *
 * Nothing here is ever trusted for money: it exists so that pressing "print"
 * immediately after a sale does not depend on a network round-trip, and so a
 * reload of the receipt page after a sale does not lose the customer's slip.
 */

import type { PosSaleResult } from "@kazhal/api-client";

const PREFIX = "kazhal.pos.receipt.";
const LAST_KEY = "kazhal.pos.lastReceipt";
/** Keep the shift's recent slips, not its whole history. */
const MAX_CACHED = 20;

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage;
  } catch {
    // Private mode / blocked storage. Not an error worth surfacing.
    return null;
  }
}

export function cacheSale(sale: PosSaleResult): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(`${PREFIX}${sale.id}`, JSON.stringify(sale));
    store.setItem(LAST_KEY, String(sale.id));
    memo.set(sale.id, sale);
    pruneCache(store);
  } catch {
    // Quota or serialization failure — the receipt screen falls back to HTTP.
  }
}

function pruneCache(store: Storage): void {
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key && key.startsWith(PREFIX)) keys.push(key);
  }
  if (keys.length <= MAX_CACHED) return;
  keys
    .sort((a, b) => Number(a.slice(PREFIX.length)) - Number(b.slice(PREFIX.length)))
    .slice(0, keys.length - MAX_CACHED)
    .forEach((key) => store.removeItem(key));
}

export function readCachedSale(orderId: number): PosSaleResult | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(`${PREFIX}${orderId}`);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as { id?: unknown };
    return typeof candidate.id === "number" ? (parsed as PosSaleResult) : null;
  } catch {
    return null;
  }
}

export function readLastSaleId(): number | null {
  const store = storage();
  if (!store) return null;
  const raw = store.getItem(LAST_KEY);
  if (!raw) return null;
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

/**
 * Identity-stable read, for `useSyncExternalStore`.
 *
 * `readCachedSale` parses JSON and therefore returns a NEW object every call,
 * which would spin a store subscription forever. This memoizes per order id so
 * repeated snapshot reads return the same reference until `cacheSale` or
 * `clearSaleCache` invalidates it.
 */
const memo = new Map<number, PosSaleResult | null>();

export function readCachedSaleStable(orderId: number): PosSaleResult | null {
  if (!memo.has(orderId)) memo.set(orderId, readCachedSale(orderId));
  return memo.get(orderId) ?? null;
}

/** Called on logout: a slip must not outlive the cashier's session. */
export function clearSaleCache(): void {
  const store = storage();
  if (!store) return;
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key && (key.startsWith(PREFIX) || key === LAST_KEY)) keys.push(key);
  }
  keys.forEach((key) => store.removeItem(key));
  memo.clear();
}
