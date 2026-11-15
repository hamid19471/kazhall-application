/**
 * Idempotency-Key generation and reuse.
 *
 * Server contract (mirrored from `apps/api/src/modules/orders/idempotency.helper.ts`
 * and `apps/api/src/common/services/idempotency.service.ts`):
 *
 *  - header name is exactly `Idempotency-Key`
 *  - charset `[A-Za-z0-9._:-]` — comma and whitespace are excluded ON PURPOSE so
 *    a duplicated header (Node joins duplicates with `,`) is rejected outright
 *  - length 8–200 after trimming
 *  - violations are named 400s (`IDEMPOTENCY_KEY_REQUIRED` / `IDEMPOTENCY_KEY_INVALID`)
 *
 * Required on exactly two routes today:
 *  - `POST /orders`      (online checkout, scope `online_order`)
 *  - `POST /orders/pos`  (in-store sale,  scope `pos_sale`)
 *
 * Replay semantics that dictate how the key must be reused:
 *  - same key + same payload, previous attempt COMPLETED → the original response
 *    is replayed verbatim. One sale, one stock decrement.
 *  - same key + different payload → 409 `IDEMPOTENCY_KEY_REUSED`
 *  - same key while the first attempt is still running → 409 `IDEMPOTENCY_REQUEST_IN_PROGRESS`
 *  - POS only: a completed key presented by a different cashier → 409 `IDEMPOTENCY_KEY_FOREIGN_CASHIER`
 *  - a request that ROLLED BACK rolls its key back too, so the SAME key is the
 *    correct thing to resend after a refusal.
 *
 * Therefore: one key per *logical attempt*, held stable across every retry of
 * that attempt (network retry, post-refresh retry, user pressing "try again"
 * on the same basket). Mint a new key only when the user starts over.
 */

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;
/** Exactly the server's `CHECKOUT_KEY_CHARSET`. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** True when `value` would be accepted by the server as-is. */
export function isValidIdempotencyKey(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length >= IDEMPOTENCY_KEY_MIN_LENGTH &&
    trimmed.length <= IDEMPOTENCY_KEY_MAX_LENGTH &&
    IDEMPOTENCY_KEY_PATTERN.test(trimmed)
  );
}

function randomHex(bytes: number): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj?.getRandomValues) {
    const buf = new Uint8Array(bytes);
    cryptoObj.getRandomValues(buf);
    let out = "";
    for (let i = 0; i < buf.length; i += 1) {
      out += (buf[i] ?? 0).toString(16).padStart(2, "0");
    }
    return out;
  }
  // Last-resort fallback. Only reachable in an environment with no Web Crypto
  // at all; still yields a key inside the server charset.
  let out = "";
  while (out.length < bytes * 2) {
    out += Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, "0");
  }
  return out.slice(0, bytes * 2);
}

/**
 * Mint one idempotency key.
 *
 * Uses `crypto.randomUUID()` when available (36 chars of `[0-9a-f-]`, inside the
 * server charset and length window). `prefix` must itself be charset-safe; it is
 * sanitized and truncated so the result can never be rejected as invalid.
 */
export function createIdempotencyKey(prefix?: string): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  const core =
    typeof cryptoObj?.randomUUID === "function" ? cryptoObj.randomUUID() : randomHex(18);

  if (!prefix) return core;

  const safePrefix = prefix.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 40);
  const candidate = safePrefix.length > 0 ? `${safePrefix}-${core}` : core;
  return candidate.slice(0, IDEMPOTENCY_KEY_MAX_LENGTH);
}

/**
 * A key bound to one logical attempt.
 *
 * ```ts
 * const attempt = beginIdempotentAttempt("checkout");
 * try {
 *   await api.orders.checkout(body, { attempt });   // uses attempt.key
 * } catch (e) {
 *   if (isConflict(e) && e.code === "checkout_retry_required") {
 *     await api.orders.checkout(body, { attempt }); // SAME key — correct
 *   }
 * }
 * // user edited the basket and starts over:
 * attempt.renew();
 * ```
 */
export interface IdempotentAttempt {
  readonly key: string;
  /** Mint a fresh key. Call only when the user genuinely starts a NEW attempt. */
  renew(): string;
}

export function beginIdempotentAttempt(prefix?: string): IdempotentAttempt {
  let key = createIdempotencyKey(prefix);
  return {
    get key() {
      return key;
    },
    renew() {
      key = createIdempotencyKey(prefix);
      return key;
    },
  };
}

/** Resolve the header value from either form the caller may pass. */
export function resolveIdempotencyKey(
  source: string | IdempotentAttempt | undefined,
): string | undefined {
  if (source === undefined) return undefined;
  return typeof source === "string" ? source : source.key;
}
