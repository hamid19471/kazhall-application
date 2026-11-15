import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { BASKET_RESERVATION_TTL_MS } from '../inventory/inventory.types';

/**
 * ============================================================================
 * CHECKOUT QUOTE — the customer's accepted purchase, signed by the server
 * ============================================================================
 *
 * WHAT REPLACED WHAT, AND WHY.
 *
 * Checkout used to be gated by two client-supplied fields:
 *
 *     if (changes.length > 0 && dto.confirmChanges !== true) { ...409... }
 *
 * plus an optional `expectedTotal` that produced one of those `changes`. Both
 * were advisory, and the gate had a hole straight through it: `confirmChanges:
 * true` suppressed the 409 for changes the server had *just* detected —
 * including a mismatch against the `expectedTotal` the client had sent in the
 * same request. So a client that set the flag (and any client that hardcoded
 * it, which is the first thing a frontend does when a flag blocks a happy
 * path) was charged whatever the server computed at that instant. Omitting
 * `expectedTotal` had the same effect by a different route: no expectation
 * declared, nothing to contradict.
 *
 * The deeper problem is that "confirm" was a BOOLEAN. A boolean cannot say
 * WHICH basket the customer agreed to buy, so it authorises every future
 * basket equally well. The fix is to make confirmation refer to a specific,
 * server-authored snapshot.
 *
 * A quote binds, and is verified against, all of:
 *
 *   - the AUTHENTICATED CUSTOMER (`userId`) — one customer's acceptance can
 *     never authorise another's order;
 *   - the exact SELLABLE SKU LINES (`variantId`), their QUANTITIES and their
 *     UNIT PRICES;
 *   - the SUBTOTAL and TOTAL;
 *   - a BOUNDED VALIDITY PERIOD (`issuedAt`/`expiresAt`).
 *
 * TOTAL EQUALITY IS NOT ENOUGH, and this is the case the old code got wrong
 * even when `expectedTotal` was honoured: two baskets can cost the same and be
 * different purchases (2 × 500,000 is not 1 × 1,000,000, and neither is
 * "1 × A + 1 × B" the same as "2 × A" when A and B cost the same). The
 * fingerprint therefore covers the LINES, not just the money, so a previous
 * acceptance can never authorise a later change that happens to add up to the
 * same figure.
 *
 * SELF-CONTAINED AND SIGNED, not a database row. The payload is server-authored
 * and HMAC-signed, so a client cannot alter a price, a quantity, the owner or
 * the expiry without invalidating the signature — the server never trusts the
 * echoed content, it verifies it. That buys tamper-evidence and a bounded
 * lifetime with no table, no migration, no expiry sweep, and nothing to leak.
 *
 * WHAT A QUOTE IS NOT. It is not a hold. Stock is held by the four-hour basket
 * reservations, and those are still the only thing that reserves anything; a
 * quote merely records what the customer agreed to buy. It confers no priority
 * over a POS sale, which is why a quote can go stale and why confirmation is
 * revalidated under the inventory locks before any money or stock moves.
 */

/** One priced line of a quote. `variantId` is the sellable SKU. */
export interface CheckoutQuoteLine {
  variantId: number;
  /** Diagnostics only — deliberately NOT part of the fingerprint. See below. */
  cartItemId: number | null;
  quantity: number;
  /** INTEGER RIAL. */
  unitPrice: number;
  totalPrice: number;
}

/** The signed payload. Everything here is authored by the server. */
export interface CheckoutQuotePayload {
  /** Format version, so a future change can be rejected rather than misread. */
  v: 1;
  /** The customer this quote belongs to. */
  userId: number;
  lines: CheckoutQuoteLine[];
  subtotal: number;
  total: number;
  /** Epoch milliseconds. */
  issuedAt: number;
  /** Epoch milliseconds. Past this instant the quote is refused. */
  expiresAt: number;
  /**
   * Makes two quotes for an identical basket distinguishable. Without it the
   * token would be a pure function of the basket, so a token captured once
   * would keep working for every later identical basket for its whole TTL.
   */
  nonce: string;
}

export interface IssuedCheckoutQuote {
  token: string;
  /** Short digest of lines + totals. Stable identity of the priced basket. */
  basketVersion: string;
  payload: CheckoutQuotePayload;
}

/** Why a presented quote was refused. */
export type QuoteRejection =
  | 'missing'
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'wrong_customer'
  | 'unsupported_version';

export type QuoteVerification =
  | { ok: true; payload: CheckoutQuotePayload }
  | { ok: false; rejection: QuoteRejection; detail: string };

const TOKEN_PREFIX = 'kq1';
const DEFAULT_TTL_MS = 15 * 60 * 1000;
/** A quote is a review step, not a hold; a very long one is a footgun. */
const MIN_TTL_MS = 30 * 1000;

@Injectable()
export class CheckoutQuoteService {
  private readonly logger = new Logger(CheckoutQuoteService.name);
  private readonly signingKey: Buffer;
  readonly ttlMs: number;

  constructor(private readonly configService: ConfigService) {
    /**
     * Derived from JWT_SECRET_KEY rather than used directly, with a domain
     * separator: a quote signature and an access token must not be
     * interchangeable, and a key committed to one purpose should never be
     * usable for another. JWT_SECRET_KEY is already required and
     * length-validated at boot (src/configs/env.validation.ts), so there is no
     * second secret to forget to set.
     */
    this.signingKey = createHmac(
      'sha256',
      this.configService.getOrThrow<string>('JWT_SECRET_KEY'),
    )
      .update('kazhal.checkout.quote.v1')
      .digest();

    this.ttlMs = this.resolveTtl();
  }

  private resolveTtl(): number {
    const raw = this.configService.get<string | number>(
      'CHECKOUT_QUOTE_TTL_MS',
    );
    const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_MS;

    /**
     * Clamped, not trusted. A quote that outlives the basket reservations
     * behind it would let a customer confirm a purchase whose stock was
     * released hours earlier — the revalidation below would catch it, but the
     * customer would have been shown a price we could never honour. Below the
     * floor it is unusable rather than strict.
     */
    if (parsed > BASKET_RESERVATION_TTL_MS) {
      this.logger.warn(
        `CHECKOUT_QUOTE_TTL_MS=${parsed} exceeds the ${BASKET_RESERVATION_TTL_MS}ms basket ` +
          `reservation TTL; clamping to it. A quote must never outlive the hold it prices.`,
      );
      return BASKET_RESERVATION_TTL_MS;
    }
    if (parsed < MIN_TTL_MS) {
      this.logger.warn(
        `CHECKOUT_QUOTE_TTL_MS=${parsed} is below the ${MIN_TTL_MS}ms floor; clamping.`,
      );
      return MIN_TTL_MS;
    }
    return parsed;
  }

  // =========================================================================
  // Issue
  // =========================================================================

  /**
   * Signs a quote for a basket the caller has ALREADY computed under the
   * inventory locks. This method does no pricing of its own on purpose: the
   * prices it signs must be the ones read under the lock, not a second,
   * unlocked read that could disagree.
   */
  issue(input: {
    userId: number;
    lines: CheckoutQuoteLine[];
    subtotal: number;
    total: number;
    now: Date;
  }): IssuedCheckoutQuote {
    const payload: CheckoutQuotePayload = {
      v: 1,
      userId: input.userId,
      lines: [...input.lines].sort((a, b) => a.variantId - b.variantId),
      subtotal: input.subtotal,
      total: input.total,
      issuedAt: input.now.getTime(),
      expiresAt: input.now.getTime() + this.ttlMs,
      nonce: randomBytes(9).toString('base64url'),
    };

    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString(
      'base64url',
    );
    const token = `${TOKEN_PREFIX}.${body}.${this.sign(body)}`;

    return {
      token,
      basketVersion: CheckoutQuoteService.basketVersion(
        payload.lines,
        payload.subtotal,
        payload.total,
      ),
      payload,
    };
  }

  // =========================================================================
  // Verify
  // =========================================================================

  /**
   * Signature, format, version, expiry and ownership. Says nothing about
   * whether the basket still matches — that is the caller's job, under the
   * locks, because it is a fact about the database and not about the token.
   *
   * Every failure mode is returned rather than thrown so the caller can log the
   * precise reason server-side while answering the client with one
   * indistinguishable code. A response that distinguished "expired" from "not
   * yours" would confirm to a prober that a captured token was genuine.
   */
  verify(
    token: string | undefined,
    userId: number,
    at: Date = new Date(),
  ): QuoteVerification {
    const raw = (token ?? '').trim();
    if (raw.length === 0) {
      return { ok: false, rejection: 'missing', detail: 'no quote presented' };
    }

    const parts = raw.split('.');
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
      return {
        ok: false,
        rejection: 'malformed',
        detail: `expected ${TOKEN_PREFIX}.<payload>.<signature>`,
      };
    }
    const [, body, signature] = parts;

    // SIGNATURE FIRST, always. Parsing attacker-controlled JSON before
    // authenticating it means every branch below runs on unverified input.
    if (!this.signatureMatches(body, signature)) {
      return {
        ok: false,
        rejection: 'bad_signature',
        detail: 'signature does not verify',
      };
    }

    let payload: CheckoutQuotePayload;
    try {
      payload = JSON.parse(
        Buffer.from(body, 'base64url').toString('utf8'),
      ) as CheckoutQuotePayload;
    } catch {
      return {
        ok: false,
        rejection: 'malformed',
        detail: 'payload is not JSON',
      };
    }

    if (payload?.v !== 1) {
      return {
        ok: false,
        rejection: 'unsupported_version',
        detail: `version ${String(payload?.v)}`,
      };
    }
    if (!Array.isArray(payload.lines)) {
      return { ok: false, rejection: 'malformed', detail: 'lines missing' };
    }
    if (this.isExpiredAt(payload, at)) {
      return {
        ok: false,
        rejection: 'expired',
        detail: `expiresAt ${String(payload.expiresAt)}`,
      };
    }
    if (payload.userId !== userId) {
      return {
        ok: false,
        rejection: 'wrong_customer',
        detail: `quote belongs to user ${String(payload.userId)}, presented by ${userId}`,
      };
    }

    return { ok: true, payload };
  }

  /**
   * Whether a quote is past its window AT A GIVEN INSTANT.
   *
   * EXISTS BECAUSE "NOW" IS NOT ONE MOMENT DURING A CHECKOUT. `verify()` runs
   * before the inventory locks are taken, and `lockVariants` issues a plain
   * `SELECT ... FOR UPDATE` that BLOCKS — a concurrent POS sale or another
   * checkout holding the same variant row can stall it arbitrarily. A quote
   * checked only before that wait can therefore expire *during* it and still be
   * honoured, which is the whole point of having an expiry.
   *
   * So the decision is re-made at the locked instant, with a clock taken after
   * the wait. Note that PostgreSQL's `now()` would NOT do here: it is the
   * TRANSACTION START timestamp and is exactly as stale as the pre-lock reading
   * (`clock_timestamp()` is the statement-time equivalent). A JS `new Date()`
   * is used instead because it is the same clock that writes
   * `stock_reservations."expiresAt"` and this payload's `expiresAt`, so all
   * three comparisons are made against one another rather than across clocks.
   */
  isExpiredAt(payload: CheckoutQuotePayload, at: Date): boolean {
    return (
      !Number.isFinite(payload.expiresAt) || at.getTime() >= payload.expiresAt
    );
  }

  // =========================================================================
  // Fingerprint
  // =========================================================================

  /**
   * Stable digest of a PRICED BASKET: every line's SKU, quantity and unit
   * price, plus the totals.
   *
   * `cartItemId` is deliberately excluded. It identifies the basket ROW, not
   * the purchase: a line that was removed and re-added with the same SKU,
   * quantity and price is the same purchase from the customer's point of view,
   * and rejecting it would cost them a round trip for no economic difference.
   * Everything a customer could be over- or under-charged for IS included.
   */
  static basketVersion(
    lines: Array<{ variantId: number; quantity: number; unitPrice: number }>,
    subtotal: number,
    total: number,
  ): string {
    const canonical = [...lines]
      .sort((a, b) => a.variantId - b.variantId)
      .map((l) => `${l.variantId}:${l.quantity}:${l.unitPrice}`)
      .join('|');

    return createHash('sha256')
      .update(`v1;${canonical};${subtotal};${total}`)
      .digest('hex')
      .slice(0, 32);
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private sign(body: string): string {
    return createHmac('sha256', this.signingKey)
      .update(body)
      .digest('base64url');
  }

  /** Constant-time, and length-safe: timingSafeEqual throws on a length gap. */
  private signatureMatches(body: string, presented: string): boolean {
    const expected = Buffer.from(this.sign(body), 'utf8');
    const actual = Buffer.from(presented, 'utf8');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }
}
