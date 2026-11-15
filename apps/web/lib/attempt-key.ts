import { useCallback, useState } from "react";

import { createIdempotencyKey, isApiError } from "@kazhal/api-client";

/**
 * Idempotency keys for the purchase-cost mutations
 * (docs/PURCHASE-COST-ACCOUNTING.md §13: 8..200 chars of `[A-Za-z0-9._:-]`).
 *
 * `crypto.randomUUID()` where the browser has it (every secure context does),
 * the api-client's own generator otherwise.
 */
export function mintAttemptKey(): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  return typeof cryptoObj?.randomUUID === "function"
    ? cryptoObj.randomUUID()
    : createIdempotencyKey("admin");
}

/** Same key, different body: the server already holds another request under this key. */
export function isKeyConflict(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.code === "STOCK_RECEIPT_IDEMPOTENCY_CONFLICT" ||
      error.code === "IDEMPOTENCY_KEY_REUSED" ||
      error.code === "PRICING_IDEMPOTENCY_KEY_REUSED")
  );
}

/**
 * ONE KEY PER DIALOG OPEN.
 *
 * Minted when the component mounts and reused for every retry of the same
 * attempt, so a request whose response was lost (network, timeout, 5xx) is
 * replayed by the server rather than applied twice. Rotated only after a
 * DEFINITIVE refusal (a 4xx other than a key conflict): the server did
 * nothing, and the next attempt may carry different values — which under the
 * old key would be refused as "same key, different body".
 */
export function useAttemptKey() {
  const [key, setKey] = useState(mintAttemptKey);
  const settle = useCallback((error: unknown) => {
    if (isApiError(error) && error.status >= 400 && error.status < 500 && !isKeyConflict(error)) {
      setKey(mintAttemptKey());
    }
  }, []);
  return { key, settle };
}
