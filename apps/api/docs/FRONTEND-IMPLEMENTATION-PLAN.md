# Kazhal — Frontend Implementation Plan

Companion to `docs/FRONTEND-API-CONTRACT.md`. Both describe branch `Hamid`
@ `6d009d5`, which fast-forwards onto `develop`.

Both Next.js apps are bare `create-next-app` scaffolds today (`app/page.tsx`,
`app/layout.tsx`, `globals.css` and nothing else). `packages/` holds
`eslint-config`, `typescript-config` and an empty `ui`. **No frontend code has
been written, and none is written by this plan.**

---

## 1. Two decisions to take before the first screen

### 1.1 Both apps must be same-site with the API — this is not a preference

Auth cookies are `httpOnly; secure; sameSite=strict; path=/`
(`modules/auth/services/auth-cookie.service.ts`). Three consequences follow, and
they constrain the
whole architecture:

1. A cross-origin SPA calling `https://api.kazhal…` from `https://kazhal…`
   **never has the cookie attached**. `sameSite: strict` is stricter than CORS;
   setting `CORS_ORIGINS` does not rescue it.
2. **The payment return is a cross-site top-level navigation**, so the cookie is
   not sent on it. The gateway must redirect to a storefront page that is
   same-site with the API; that page loads first-party and *its own JavaScript*
   calls `POST /payment/verify`.
3. The websocket handshake authenticates from the same cookie, so it inherits
   the same constraint.

**Therefore: run each Next.js app behind a path/proxy that is same-origin with
the API** (Next `rewrites`, or a shared reverse proxy). Decide this first —
retrofitting it after the auth layer exists is expensive.

### 1.2 One generated client, not hand-written fetchers

The API now generates a complete, accurate OpenAPI document (81 operations,
verified against the live router). Generate the client and the types from it
into `packages/api-client` rather than hand-writing calls. Hand-written clients
are where the `total_price` vs `totalPrice` traps below become production bugs.

What the generator will **not** give you, and must be hand-written once in that
package: the response-envelope unwrapping (§2.1), the single-flight refresh
(§2.2), and the idempotency-key lifecycle (§2.3).

---

## 2. Shared packages to build first

### `packages/api-client`

- Generated types + operations from `/v1/api-json`.
- **Envelope unwrapping.** The interceptor *spreads* a plain object into the
  envelope and *nests* an array under `data`, so the shape differs per route.
  Encode the per-route shape once here; never let a screen guess.
- **Error normalisation.** Expose `code = body.error ?? body.details?.code` as a
  single field. Two subsystems put the machine-readable code in different places
  (§6 F-2 of the contract) — normalise it once, at the boundary.
- **Single-flight refresh.** Rotation allows exactly one concurrent winner; the
  losers get 401. A shared in-flight promise is mandatory, not an optimisation.
- **Idempotency-key lifecycle.** One key per *attempt*, reused across every
  retry including after a 409, discarded only on success or abandonment.
- **Money type.** A branded `Rial` number type so a component cannot pass a
  formatted string into a request.

### `packages/ui`

Currently empty. Populate with the primitives both apps need: money display,
quantity stepper, countdown, notice banner, data table, empty/error/loading
states. Keep POS-specific and storefront-specific components in their own apps.

### `packages/realtime`

Socket.IO client with: cookie handshake, reconnect-and-**re-read** (there is no
event backlog and no sequence number), and a subscription API that makes the
advisory nature explicit — every frame is droppable, the REST read is the truth.

---

## 3. Screen and component backlog

Priority: **P0** blocks a usable journey · **P1** completes the journey ·
**P2** valuable, not blocking.

### 3.1 apps/store — customer storefront

| P | Screen / component | Endpoints | Notes |
|---|---|---|---|
| P0 | App shell + session provider | `GET /auth/storefront/me` | Call on mount and after every login/refresh. 401 = signed out, not an error. The storefront reads **only** its own audience route — `/auth/admin/me` and `/auth/pos/me` answer for other surfaces. |
| P0 | OTP sign-in (2 steps) | `POST /auth/storefront/send-otp`, `POST /auth/storefront/verify-otp` | **There is no signup screen.** The account is created on the **first successful `verify-otp`**, not by `send-otp`; the same two calls serve sign-in and sign-up. OTP TTL 120 s. |
| P0 | Product list + search + filters | `GET /products`, `GET /categories` | Pagination is **top level** here. `sort` ∈ newest/price_asc/price_desc. |
| P0 | Product detail + variant picker | `GET /products/:id` | `variants[].availability` is **indicative**, never a hold. Only active variants are returned. |
| P0 | Basket drawer / page | `GET /cart`, `POST /cart`, `PATCH /cart/:id`, `DELETE /cart/:id` | **Dedupe `items` and `notices` by `id`** — they overlap. Prefer `PATCH` (absolute quantity) over repeated `POST` (not idempotent). |
| P0 | Reservation countdown | `GET /cart` | Drive from `expiresAt`/`tranches[]`; re-read rather than counting down from a cached value. |
| P0 | Displacement notice banner | `GET /cart` | **Poll-only** — no push exists. Refetch on basket open and window focus. Says *what*, never *who*. Client-side dismissal keyed on `(cartItemId, lastChangeAt)`. |
| P0 | Address book + checkout address picker | `/me/addresses` CRUD | Note nested pagination and the `totalPage` / `reciver_mobile` spellings. |
| P0 | Checkout review | `POST /orders/quote` | Show `basket` + `notices` + the quote's `expiresAt`. This is the only screen where a quote is adopted without a diff. |
| P0 | Place order + 409 recovery | `POST /orders` | Implements §4.4/§4.5 of the contract: one key per attempt; `retry_required` → same token; every other 409 → show diff and **wait for a human**. |
| P0 | Payment redirect + return page | `POST /payment/start`, `POST /payment/verify` | The return page must be **same-site**; its own JS calls verify. Branch on `applied && !fulfilmentBlocked`. |
| P1 | Order confirmation | `POST /orders` response, `GET /me/orders/:id` | Render `acceptedQuote` as the receipt of what was authorised. |
| P1 | My orders + order detail | `GET /me/orders`, `/me/orders/:id` | ⚠ returns **raw entities** including internal ops fields — see F-4; whitelist fields in the client. |
| P1 | Sign out / sessions | `POST /auth/storefront/logout`, `POST /auth/storefront/logout-all` | `logout` ends **this surface only** and clears only the storefront cookie pair; `logout-all` revokes every audience on every device. |
| P2 | Wishlist | `POST /products/bookmark` | **Blocked**: toggle-only, no read endpoint and no `isBookmarked` flag — see F-5. Ship the button only once that exists. |

### 3.2 apps/web — admin + POS

| P | Screen / component | Endpoints | Notes |
|---|---|---|---|
| P0 | App shell + role-based nav | `GET /auth/admin/me` (console) · `GET /auth/pos/me` (till) | `roles`, `permissions` and `branchId` drive the whole navigation. Never decode the cookie. The console and the till hold **separate** sessions and each calls its own route. |
| P0 | Staff login | `POST /auth/admin/login` (console) · `POST /auth/pos/login` (till) | Username + password; storefront customers have no password. Eligibility is checked **before any cookie is issued** — an account without `admin.access` / `pos.access` is refused 401 `AUDIENCE_NOT_PERMITTED` and receives nothing. |
| P0 | **POS till** — scan, basket, charge | `GET /inventory/lookup`, `GET /inventory/availability`, `POST /orders/pos` | Show `availableForPos`, not `availableForBasket` — a POS sale may take units from ecommerce baskets. Availability is indicative; the sale is the authority. One Idempotency-Key per sale attempt, generated by the app — **cashiers never see or type it**. |
| P0 | POS receipt / sale result | `POST /orders/pos` response | `data.stock[].balanceAfter` and `displacedBasketLines` are the post-sale truth. |
| P0 | POS returns & voids | `GET /reports/sales`, `GET /orders/:id`, `POST /orders/:id/void`, `POST /orders/:id/return` | Voids and returns are **whole-order only** — no partial/line-level return exists. Use the reports list to find the sale; `GET /orders` is administrator-only (`orders.read`) and a cashier holds no `orders.*` permission — the till reprints its own sale via `GET /orders/:id` (`pos.receipt.read_own`). |
| P0 | Branch/shift dashboard | `GET /reports/sales/summary`, `/by-cashier` | `filters.branchId` echoes the resolved scope. **Never sum `data` and `reversalsByActor`.** Treat gross/net as provisional until D-3 is answered. |
| P1 | Sales list + sale detail + audit trail | `GET /reports/sales`, `/reports/sales/:id`, `GET /orders/:id/actions` | Sale detail renders immutable sale-time snapshots, stable after catalogue edits. |
| P1 | Product editor (create/update) | `POST /products`, `PATCH /products/:id`, `GET /products/admin/:id`, `GET /categories`, `GET /attributes` | Simple products get a default variant automatically. Understand replace-vs-merge semantics before wiring the form. |
| P1 | Variant & stock management | `POST /products/variants/:variantId/stock/adjust` | Opening stock is entered here; backfilled default variants start at **0** and nothing invents a number. |
| P1 | Image upload | `POST /products/uploadImage` | |
| P1 | Categories & attributes | `POST /categories`, `GET /categories/admin`, `PATCH /categories/:id`, `DELETE /categories/:id`, `/attributes*` | `DELETE /categories/:id` needs `categories.delete` and deletes **only an empty category**: it answers **409 `CATEGORY_IN_USE`** with `details.productCount` while any product is attached, and never detaches products for you. Move products out through the product endpoints first. See FRONTEND-API-CONTRACT §2.8.1. |
| P1 | Staff, roles, branches | `/users*`, `/roles*`, `/branch*` | Deactivate ≠ delete; deactivation and password change invalidate live sessions and disconnect sockets. |
| P2 | Operations console | `POST /inventory/admin/sweep-reservations`, `/payment/admin/fulfilment/recover`, `/payment/admin/reverify` | Surface `RecoveryReport.blocked` / `blockedOrderIds` — a blocked order is **paid and deliberately not shipped**, awaiting a human. |
| P2 | Customers | `GET /customer`, `/customer/:id` | super_admin only; a cashier cannot look a customer up — see F-7. |

### 3.3 Suggested sequencing

1. **Foundation** — proxy/same-site topology, `packages/api-client`, session provider, both logins.
2. **POS vertical slice** — till → charge → receipt → void/return. Highest business value and it exercises idempotency, attribution and inventory end to end.
3. **Storefront browse → basket** — catalog, basket, reservations, displacement polling.
4. **Storefront checkout → payment** — quote, 409 recovery, payment return. Do this only after the basket is solid; the 409 contract is the subtlest part of the system.
5. **Admin catalog & identity.**
6. **Reporting dashboards** — last, because D-3 may change the numbers.

---

## 4. Unresolved owner decisions

None of these are approved. Do not present any of them as settled.

| # | Decision | Frontend impact |
|---|---|---|
| **D-2** | Order-allocation TTL (provisionally 30 min) and what happens to a paid order that cannot be fulfilled (`AWAITING_STOCK`). No automatic refund, cancellation or back-order exists. | A customer can sit in "payment succeeded, order being prepared" indefinitely. No UI can resolve it. Needs a support workflow. |
| **D-3** | Whether a void is "revenue that was reversed" (shipped default: `net = gross − refunded − voided`) or "never revenue" (`net = gross − refunded`). | **Different dashboard numbers.** Build reporting last and label totals provisional. |
| **D-4** | Whether online revenue is dated by payment instant (current) or order date. | Changes every period boundary in reporting. |
| **New-1** | Should a `sale` cashier see colleagues' totals? `by-cashier` is branch-scoped only, so today they see every cashier in their branch. | Shift-report screen design. |
| **New-2** | Should "Void" be offered on an unpaid/`pending` order? A void is legal from any status except `refunded`; reports handle it correctly either way, but the button-level rule is unstated. | POS void button enablement. |
| **New-3** | Should any authenticated user be able to list every branch's name, address and phone? `GET /branch` has no role restriction. | Branch picker exposure. |
| ~~**New-4**~~ | **ANSWERED BY IMPLEMENTATION.** `POST /auth/storefront/send-otp` no longer creates a `users` row; the account is created on first successful `verify-otp`, and both send limits are enforced. The remaining question — whether an *unverified* mobile should ever produce a row — is now moot. | Storefront signup is safe to build. |
| **New-5** | `RealtimeGateway.handleConnection` joins `branch:<id>` for **anyone** whose `users.branchId` is set, regardless of role. Branch is staff-only in practice, but a `site` customer given a `branchId` would receive exact stock on `stock:updated`. | Either restrict the branch room to staff roles, or guarantee `site` users never carry a `branchId`. Left as-is because changing it alters behaviour asserted by `realtime-auth.int-spec.ts`. |
| **New-6** | OTP policy numbers (cooldown 60 s, 5 sends/mobile/hour, 20 sends/IP/hour, 5 attempts, 120 s TTL) are **compile-time constants**, not env vars, because promoting them means adding validated entries to `env.validation.ts`. | Fine for one deployment; needs a decision before per-environment tuning (e.g. a looser limit in staging). |
| **New-7** | Pre-existing `users` rows created by the OLD send-otp behaviour (a mobile, no session, no orders) are **untouched**. They are not a live hole — the new flow adopts an existing row on verification, i.e. the same person as before — but they inflate customer counts. | A vetted audit query ships in the migration's doc comment. Deletion must stay a deliberate operator action: `orders.cashierUserId` is `ON DELETE RESTRICT`. |
| **New-8** | **Deployment prerequisite, not a preference.** The per-IP OTP limit uses `req.ip` and deliberately ignores every forwarded header, because no `trust proxy` is configured. Behind a reverse proxy it degrades into **one global 20/hour bucket for the entire internet**. | Before going behind a proxy: set `trust proxy` in `main.ts` to the number of hops you operate (never `true`), and make the proxy **overwrite** inbound `X-Forwarded-For`. |

---

## 5. Backend follow-ups

### 5.1 Resolved by the security-hardening task

These were behaviour changes, so they were deliberately NOT touched when this
plan was first written. They have since been implemented and tested. Contract
details are in `docs/FRONTEND-API-CONTRACT.md` §8.

| # | Was | Now |
|---|---|---|
| **A-1** | `DELETE /roles/:id` cascaded — deleting `super_admin` stripped it from every user and returned 200. | 409 `ROLE_BUILTIN_PROTECTED` / `ROLE_IN_USE`; every last-admin path refuses with `LAST_SUPER_ADMIN`. **The roles screen is unblocked.** |
| **A-2** | *Claimed* a password change did not revoke refresh tokens. | **RETRACTED — the claim was false.** Refresh rotation already rejects pre-change tokens (`auth.service.ts:194`). Enforced on access tokens, refresh rotation and websockets. **No `deactivate` chaining needed; the advice to do so is withdrawn.** |
| **F-8** | `POST /payment/verify` was not owner-scoped. | Owner-scoped; foreign/unknown `trackId` both answer an identical non-enumerating 404. `super_admin` exempt. **Unknown `trackId` is now 404, not 400.** |
| **F-3** | `order.status.updated` broadcast to every socket. | Staff rooms + the owning customer's own room, with a narrower customer payload. No order event is global. |
| **F-10** | `send-otp` unthrottled and account-creating. | Cooldown, per-mobile and per-IP limits, bounded attempts, one-time consumption, enumeration-safe responses, account created only on verification. |
| **F-4** | `GET /me/orders` returned raw entities incl. `fulfillmentLastError`. | Bounded allow-list view models. **Breaking: fields removed and renamed to camelCase** — see §8.5. |
| **F-15** | `POST /orders` could answer a bare 500 on insufficient stock. | 409 `INSUFFICIENT_STOCK` with `variantId`/`sku`/`requested`/`available`. |
| **F-2** | Stock errors carried no machine-readable code. | `error` and `details.code` both set. POS *idempotency* still needs the `??` fallback. |
| **F-1** | `RolesGuard` resolved `[class, handler]`, silently overriding handler roles. | Handler-first, matching `JwtAuthGuard` and NestJS convention. Provably zero access delta: 81 routes, no drift. |
| **F-9** | No per-customer realtime at all. | **Partly resolved** — order status now reaches `user:<id>`. Basket displacement is still poll-only by design. |
| *new* | Exact stock was broadcast to every socket. | `stock:updated` is staff-only; storefronts use the new boolean `availability:updated`. |

### 5.2 Still open

**None of these were changed.** Evidence is in
`docs/FRONTEND-API-CONTRACT.md` §6.

| # | Issue | Blocks |
|---|---|---|
| **F-5** | Bookmarks are write-only — no list endpoint, no `isBookmarked` flag. | Wishlist screen and a correctly-lit heart icon are unbuildable. |
| **F-6** | `GET /branch`, `GET /branch/:id` have no role restriction. | See New-3. |
| **F-7** | A cashier cannot look up a customer by mobile, nor list cashiers to populate the `cashierUserId` report filter. | Degrades POS and shift reporting. |
| **F-11** | `PaymentConfig.callbackUrl` defaults to `/v1/payment/callback` — a `/v1` prefix that does not exist and a route that does not exist. | Must be set to a real storefront page (§4.6). |
| **A-3** | Duplicate username → generic **500** on `POST /users` / `PATCH /users/:id`; `POST /auth/register` returns 400. | Use `/auth/register` for the staff form. |
| **A-4** | `DELETE /branch/:id` and `DELETE /address/:id` return generic 500s when referenced; `PATCH /branch/:id` 500s on a rename collision. | Branches and admin-address screens need pre-checks the API does not provide. |
| **A-5** | No category detail/update endpoint; no stock-ledger read; `isDefault` absent from the admin variant view. | Category rename, adjustment history and the documented "retire the default" flow are all unbuildable as specified. |
| **F-12** | Field-name inconsistency for the same order across shapes: `totalPrice` (POS, report detail) vs `total_price` (entity reads, report rows); `unitPrice` vs `unit_price`. Pagination: top-level vs nested; `totalPages` vs `totalPage` vs `tatalPage` (typo). | Handle in the generated client; do not paper over it in components. |
