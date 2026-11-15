# Online checkout contract

Two calls: **review**, then **place**. An order can only be placed against a
quote this server issued.

---

## 1. Why the contract changed

The previous contract gated checkout on two client-supplied fields:

```
POST /orders  { address, confirmChanges?: boolean, expectedTotal?: number }
```

and the server's gate was:

```ts
if (changes.length > 0 && dto.confirmChanges !== true) { /* 409 */ }
```

`confirmChanges: true` therefore suppressed changes the server had detected in
**that same request** — including a mismatch against the `expectedTotal` the
client had just sent. Omitting `expectedTotal` reached the same place by
declaring no expectation at all. Either way the customer was charged whatever
the server computed at that instant.

The root cause is that "confirm" was a **boolean**, and a boolean cannot say
*which* basket the customer agreed to buy — so it authorises every later basket
equally well. A total cannot say it either: `2 × 500,000` and `1 × 1,000,000`
cost the same and are different purchases.

`confirmChanges` and `expectedTotal` are **removed**. The request validator runs
with `forbidNonWhitelisted`, so a client still sending either gets a **400**.
That is deliberate: failing closed on an old client is better than charging one.

---

## 2. `POST /orders/quote` — the review step

Roles: `site`. No body. No `Idempotency-Key` (it writes no order).

Prices the caller's **active** basket under the inventory locks and returns a
server-signed quote.

```jsonc
// 200 OK
{
  "data": {
    "quote": {
      "token": "kq1.eyJ2IjoxLCJ1c2VySWQiOjQyLC4uLn0.M8f_9xQ...",
      "basketVersion": "9f2c1e7a4b6d8035c1a2f4e6b8d0a2c4",
      "issuedAt": "2026-09-10T09:14:02.113Z",
      "expiresAt": "2026-09-10T09:29:02.113Z",
      "subtotal": 750000,
      "total": 750000
    },
    "basket": {
      "lines": [
        { "cartItemId": 88, "productId": 12, "variantId": 34,
          "productTitle": "Kettle", "quantity": 3,
          "unitPrice": 250000, "totalPrice": 750000 }
      ],
      "subtotal": 750000,
      "total": 750000
    },
    "notices": []
  }
}
```

The quote is bound to the **authenticated customer**, the exact **sellable SKUs**
(`variantId`), their **quantities**, their **unit prices**, the **subtotal and
total**, and a **bounded validity window** (`CHECKOUT_QUOTE_TTL_MS`, default 15
minutes, clamped to at most the 4-hour basket reservation TTL).

`notices` explains why the basket may differ from the last time the customer
looked — "some of these units were sold in one of our stores", "your 4-hour hold
expired". It is **informational**: the quote already prices the corrected
basket, so a notice never blocks checkout. Show it next to the total.

**A quote is not a hold.** Stock is held by the four-hour basket reservations,
and a quote confers no priority over an in-store sale. That is exactly why it
can go stale.

Prices are read under the inventory locks, and the validity window starts at
the **locked instant** — after any wait for a contended SKU — so a quote is
never handed out with a window that was already partly spent queueing.

Other responses: **400** if the basket is empty; **409
`checkout_contents_changed`** if nothing in it is still purchasable. Neither
carries a quote: there is nothing to price. Both mean "send the customer back to
the basket".

---

## 3. `POST /orders` — place the order

Roles: `site`. `Idempotency-Key` header **required**.

```jsonc
{ "address": 19, "quoteToken": "kq1....", "discount_code": "OPTIONAL" }
```

`quoteToken` is **optional in the DTO and mandatory in the contract**, and the
distinction is deliberate: omitting it does not place an order, it returns a
quote to review. Every quote problem — absent, expired, malformed, tampered,
belonging to someone else, or stale — is answered by a 409, so a client has
exactly **one** recovery path. (It was `@IsNotEmpty` until this was reconciled,
which meant a missing token got a bare 400 with nothing to show the customer
while an expired one got a 409 carrying everything needed to continue.)

### 201 Created

```jsonc
{
  "message": "Order created successfully",
  "data": {
    "id": 501, "orderNumber": "WEB-20260910-000501",
    "status": "pending", "fulfillmentState": "not_required",
    "paymentMethod": "online_gateway",
    "subtotal": 750000, "totalPrice": 750000,
    "address": { "addressId": 19, "city": "Tehran", "postalCode": "1234567890",
                 "capturedAt": "2026-09-10T09:15:44.001Z" },
    "items": [ { "id": 900, "variantId": 34, "quantity": 3,
                 "unitPrice": 250000, "totalPrice": 750000 } ],
    "acceptedQuote": {
      "basketVersion": "9f2c1e7a4b6d8035c1a2f4e6b8d0a2c4",
      "issuedAt": "2026-09-10T09:14:02.113Z",
      "expiresAt": "2026-09-10T09:29:02.113Z",
      "subtotal": 750000, "total": 750000
    }
  }
}
```

`acceptedQuote` is the receipt for *how the order was authorised*. Its
`basketVersion` equals the fingerprint of the order's own `order_items`
snapshots by construction — the order exists only because the two matched — so
`order_items` is the durable record of what the customer accepted.

### Every non-201 response, and whether it carries a quote

**Not every 409 carries a fresh quote.** Three do; two cannot, because a basket
that has nothing purchasable in it — or that could not be priced under a lock —
cannot be priced into a quote. The recovery differs accordingly.

On the two that carry none, `details.quote` is `null` for
`checkout_contents_changed` and **absent** for `checkout_retry_required`. Branch
on `error`; if you must test the field, a falsy check (`if (details?.quote)`)
covers both.

| Status | `error` | Carries `details.quote`? | Meaning | Client recovery |
|---|---|---|---|---|
| 409 | `checkout_quote_required` | **yes** | No quote presented. The ordinary **first step**. | Show `details.basket` + `details.notices`; on accept, resend with `details.quote.token`. |
| 409 | `checkout_quote_invalid` | **yes** | Expired, malformed, tampered, or issued to another customer — one code for all four. Also raised when a quote lapses **while the request waits for a variant lock** (see §4). | Same as above. Re-review and resend. |
| 409 | `checkout_quote_stale` | **yes** | Authentic quote, but the basket no longer matches. `details.changes` is the was/now diff. | Show the diff and **wait for the customer**; on accept, resend with the new token. |
| 409 | `checkout_contents_changed` | **no** (`quote: null`) | Nothing purchasable is left in the basket. `details.changes` carries the notices explaining why. | Send the customer **back to the basket**. Do not re-confirm — there is nothing to confirm. |
| 409 | `checkout_retry_required` | **no** (also no `changes`/`basket`; `retryable: true`) | A transient race **inside one request**: a basket line for a SKU outside the locked set appeared between the discovery read and the locked read, so its price could not be read authoritatively. Nothing was decided or charged. | **Retry with the SAME accepted token**, bounded (2–3). Do **not** fetch a new quote. See §4.1 — the cause may be a new SKU, and the retry is what surfaces it as `checkout_quote_stale`. |
| 400 | — | **no** | Empty basket (`BASKET_EMPTY`). Decided **before** the quote gate, so it wins over a missing or bad token. | Send the customer to the basket. |
| 400 | — | **no** | Missing or malformed `Idempotency-Key`; `quoteToken` over 8192 chars; `confirmChanges`/`expectedTotal` sent (rejected by `forbidNonWhitelisted`). | Fix the client. |
| 404 | — | **no** | `address` is not one of the caller's own. | Re-fetch `GET /me/addresses`. |

```jsonc
// 409 checkout_quote_stale
{
  "success": false, "statusCode": 409,
  "error": "checkout_quote_stale",
  "message": "Your basket changed after you reviewed it. …",
  "details": {
    "code": "checkout_quote_stale",
    "confirmationRequired": true,
    "howToConfirm": "Show `basket` and `changes` … resend with `quoteToken` set to `quote.token` and the SAME Idempotency-Key.",
    "quote": { "token": "kq1....", "basketVersion": "…", "total": 360000, "expiresAt": "…" },
    "changes": [
      { "kind": "price_changed", "variantId": 34, "productTitle": "Kettle",
        "previousQuantity": 2, "currentQuantity": 2,
        "previousUnitPrice": 100000, "currentUnitPrice": 180000,
        "message": "The price of one or more items changed…" },
      { "kind": "total_changed",
        "previousTotal": 200000, "currentTotal": 360000,
        "message": "The total changed after you reviewed your order" }
    ],
    "notices": [],
    "basket": { "lines": [ … ], "subtotal": 360000, "total": 360000 }
  }
}
```

```jsonc
// 409 checkout_retry_required — no quote, no diff, nothing to show a customer
{
  "success": false, "statusCode": 409,
  "error": "checkout_retry_required",
  "message": "We could not confirm your basket just now. Please try again.",
  "details": { "code": "checkout_retry_required",
               "confirmationRequired": false, "retryable": true }
}
```

`changes[].kind` is one of `sold_in_store`, `reservation_expired`,
`not_sellable`, `stock_not_counted`, `price_changed`, `line_added`,
`quantity_changed`, `total_changed`. `previousTotal`/`currentTotal` are
populated **only** for `total_changed`, where the figures are basket totals and
not per-unit prices.

**`total_changed` is reported alongside the per-line changes, never instead of
them.** A basket can change materially with the total unmoved — swap one SKU for
another at the same price, halve one line and double another — and a customer
told only "the total is the same" has been told nothing.

---

## 4. Expiry is decided *after* the lock wait

`InventoryService.lockVariants` issues a plain `SELECT … FOR UPDATE`, so
checkout **blocks** while a concurrent in-store sale or another customer's
checkout holds the same SKU row. Two expiry questions used to be decided against
a clock read *before* that lock was requested — the quote's window, and which
basket reservations were still alive — so anything that lapsed while the request
was queued was still treated as live.

Both are now decided at the **locked instant**, a clock read after the lock is
held:

* a quote that lapses during the wait is refused with **409
  `checkout_quote_invalid`** carrying a fresh quote — the same response as any
  other unusable quote, so the client needs no special case;
* a reservation that lapses during the wait is released, and the line is
  reported through the ordinary `checkout_quote_stale` diff;
* `orders."soldAt"` and the order allocation's TTL are both measured from that
  instant.

For anyone reading the code: PostgreSQL's `now()` would **not** work here — it
is the transaction-start timestamp and is at least as stale as the pre-lock
reading (`clock_timestamp()` is the statement-time equivalent). The
implementation uses a JS `new Date()` because that is the same clock that writes
`stock_reservations."expiresAt"` and the quote's `expiresAt`, so all three
comparisons stay within one clock.

A client sees no new failure mode: a lock wait can turn an otherwise valid
attempt into a 409 with a fresh quote, which is already the case it handles.

### 4.1 `checkout_retry_required` must be retried with the SAME token

`retryable: true` invites a client to fetch a fresh quote and resubmit
automatically. **Do not.** This document previously said to do exactly that,
and it was unsafe.

The transient race has more than one cause, and one of them is **a new basket
line appearing during the lock wait**. A fresh quote prices the basket *as it is
now* — including the SKU the customer has never seen on a review screen.
Submitting it automatically charges them for it. That is the
`confirmChanges: true` defect rebuilt on the client, where the server cannot
stop it.

The safe sequence:

1. **Retry `POST /orders` with the SAME `quoteToken`** the customer accepted,
   and the same `Idempotency-Key`. On the retry the SKU is inside the lock set,
   so the server can price it authoritatively.
2. The server then answers honestly:
   * **201** — nothing material changed (the race was a genuine transient), the
     order is placed against the quote the customer accepted;
   * **409 `checkout_quote_stale`** — the basket really did change. The response
     carries the was/now `changes` diff and a fresh quote.
3. **Only on that 409** do you show the customer the diff and the new total, and
   **wait for explicit confirmation** before sending the new token.
4. **Bound the retries** (2–3) and fall back to the basket. A `retry_required`
   that never resolves is a stuck SKU, not something to hammer.

The accepted token cannot place an order containing a SKU it never priced —
the fingerprint covers the lines, so `1 × 100,000` cannot authorise
`1 × 100,000 + 1 × 300,000` no matter how often it is retried. Asserted by
*"a new SKU appearing during the wait cannot enter an order without renewed
confirmation"*, which retries the accepted token three times and checks
`order_items` contains no row for the late SKU.

**Never replace an accepted quote with a fresh one and submit it without the
customer.** The only thing that may turn a fresh quote into an order is a person
agreeing to it.

---

## 5. Retry and replay

* **A refused confirmation rolls everything back.** The 409 is thrown inside the
  checkout transaction, so no order, no order allocation, no basket mutation and
  **no idempotency claim** survive it. Retry with the **same** `Idempotency-Key`
  and the new token. (If the claim survived a 409, one refusal would wedge that
  checkout forever — asserted by *"a REFUSED confirmation can be retried with the
  SAME Idempotency-Key"*.)
* **A successful request replays.** The same key returns the same order, with
  `acceptedQuote` unchanged, and allocates stock exactly once. `quoteToken` is
  deliberately **not** part of the idempotency request hash — it is a control
  field for one attempt, so retrying after a 409 with a *new* token is not
  treated as key reuse. The hash covers the order-defining fields (`address`,
  `discount_code`); changing those with the same key is a **409
  `IDEMPOTENCY_KEY_REUSED`**.
* **The rollback also undoes the lazy expiry the request performed.** A refused
  attempt may leave a reservation row still marked `active` even though it is
  past `expiresAt`. That is the pre-existing lazy-expiry design, not a leak: a
  row past its expiry is counted by no read, and the next *committing* read (a
  quote, `GET /cart`, or the background sweeper) releases it for good. The
  durable guarantee is that lapsed units are never sold, not that the row is
  tidied inside a transaction that rolled back.
* **A quote is not single-use.** Two quotes for an unchanged basket share a
  `basketVersion`, and an older one still works while the basket is genuinely
  unchanged — the customer accepted exactly that purchase. What a quote cannot
  do is authorise a *changed* basket. Once an order is placed the basket is
  empty (its holds became the order's allocation), so the same quote cannot
  place a second order under a new key.

---

## 6. Frontend flow

```js
const idempotencyKey = crypto.randomUUID();      // ONE per checkout attempt
const MAX_TRANSIENT_RETRIES = 3;

const post = (path, body) =>
  fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

async function requestQuote() {
  const { status, body } = await post('/orders/quote');
  if (status === 200) return body.data;            // { quote, basket, notices }
  return null;                                     // 400 empty / 409 nothing purchasable
}

// 1. Review. This is the ONLY place a quote is adopted without a diff, because
//    it is the first thing the customer is shown.
const review = await requestQuote();
if (!review) return backToBasket();
let accepted = review.quote;                       // the customer-accepted quote
showOrderReview(review.basket, review.notices, accepted.expiresAt);

// 2. Place.
await onCustomerAccepts(async () => {
  let transient = 0;

  for (;;) {
    // ALWAYS submit the quote the customer accepted. It is only ever replaced
    // below, and only after they have seen and approved the difference.
    const { status, body } = await post('/orders', {
      address: addressId,
      quoteToken: accepted.token,
    });

    if (status === 201) return showConfirmation(body.data);

    const code = body.error;

    // Transient in-request race. Retry the SAME accepted token — do NOT fetch a
    // new quote here. The cause may be a new SKU in the basket, and the retry
    // is what makes the server surface it as checkout_quote_stale below.
    if (code === 'checkout_retry_required') {
      if (++transient > MAX_TRANSIENT_RETRIES) return backToBasket();
      continue;                                    // same token, same key
    }

    // Nothing purchasable left. No quote, nothing to confirm.
    if (code === 'checkout_contents_changed') {
      return backToBasket(body.details.changes);
    }

    // The three quote codes carry a fresh quote. Show the customer what
    // changed and WAIT. Adopting the fresh quote without them is the
    // `confirmChanges: true` bug rebuilt in the client.
    if (body.details?.quote) {
      const approved = await showChangesAndAsk(
        body.details.changes ?? [],
        body.details.basket,
      );
      if (!approved) return backToBasket();
      accepted = body.details.quote;               // adopted ONLY on approval
      transient = 0;
      continue;                                    // same idempotencyKey
    }

    return showError(body);                         // 400 / 404
  }
});
```

Rules for a client:

1. **One `Idempotency-Key` per checkout attempt**, reused across every retry of
   that attempt, including after a 409. Never per HTTP request.
2. **A quote is adopted only by a person.** The initial review screen and an
   explicit approval of a diff are the only two ways `accepted` may change.
   Anything else is the removed `confirmChanges: true` bypass, moved to where
   the server cannot see it.
3. **`checkout_retry_required` is retried with the SAME token**, bounded. It is
   *not* a signal to re-quote — see §4.1.
4. Treat `checkout_quote_required` as the normal first step, not an error.
5. Do not assume a 409 has `details.quote`. Branch on `error`, and check for the
   field before using it.
6. `expiresAt` is a hint for the UI; the server is the authority, and it
   re-checks the window after any lock wait (§4).
7. Do not parse or construct a `quoteToken`. It is signed; a modified one is
   refused on the signature, before its contents are read.

---

## 7. Known limitation: discount codes

`discount_code` is **accepted, stored on the order, and never priced.** Nothing
in this codebase computes a discount — grep for it: the only writers are
`orders.service.ts:300` and `:515`, both of which just persist the string, and
`orders.total_price` is set to the line subtotal. So today `total === subtotal`
on every order and the quote's total is complete.

That means the quote does **not** currently bind the discount code, and
`POST /orders/quote` does not accept one. **Before discount logic ships, the
discount must be computed inside `priceBasketUnderLock` and its code included
in the quote payload and the fingerprint** — otherwise a customer could accept a
quote priced without a discount and submit a different code, and the
fingerprint would not notice, which is the same class of hole this task closed.
No customer can be over- or under-charged by it today, because the field has no
effect on any figure.

---

## 8. Deliberate decisions worth an owner's attention

* **A price drop is also refused.** The guarantee is "you are charged the basket
  you accepted", not "you are never charged more". A total that silently moves in
  either direction means the review screen was fiction. Cost: one extra round
  trip on a favourable repricing.
* **Basket-row identity is not part of the fingerprint.** A line removed and
  re-added with the same SKU, quantity and price is the same purchase, so it does
  not invalidate a quote. Everything a customer could be over- or under-charged
  for *is* in the fingerprint.
* **The delivery address is not bound to the quote.** A quote prices the basket;
  shipping cost is not modelled anywhere, so changing address does not change the
  total. Address *ownership* is enforced separately, on every attempt.
* **15-minute default validity** is a judgement, not a requirement from the
  owner. It is the window in which a reviewed price stays honourable.
* **Rotating `JWT_SECRET_KEY` invalidates outstanding quotes.** The signing key
  is derived from it (with a domain separator, so a quote signature and an
  access token are not interchangeable). After a rotation, in-flight customers
  get one `checkout_quote_invalid` carrying a fresh quote and re-review. No
  order is at risk; it is one extra round trip for anyone mid-checkout. Worth
  knowing before rotating during trading hours.
* **A notice on a still-active line is reported on every quote** until the line
  changes again, because `GET /cart` only clears the reason for soft-removed
  rows. It is informational and never blocks checkout, so the cost is a
  repeated message rather than a stuck customer — but a frontend may want to
  de-duplicate it in the UI.
