# Verification: what is actually proven, and how

This document exists because "the code does X" and "X was observed to happen"
are different claims, and mixing them is how a review signs off on something
nobody ran. Every statement about this backend belongs in exactly one of the
tiers below, and each tier is worth something different.

---

## 1. Evidence tiers

**Current totals:** unit `7 suites / 46 tests, 0 skipped`; integration
`26 suites / 264 tests`, green in both provisioning modes.

| Tier | What it is | What it proves | What it does NOT prove |
|---|---|---|---|
| **T0 — code inspection / grep** | Somebody read the source, or a pattern matched | That a line of code exists | **Nothing about runtime.** A grep showing `FOR UPDATE` does not prove locks are acquired in the right order, that the transaction is the right one, or that the path is reachable. A grep showing no `variantId === null` does not prove no bypass — it proves that spelling is absent |
| **T1 — unit tests (mocked)** | Jest + hand-built mocks, no database | That a pure function or a pre-database guard behaves as specified | Nothing about SQL, locking, transactions, constraints or concurrency. A mocked `EntityManager` returns what the test told it to return, so it can only ever confirm the mock |
| **T2 — integration tests (real PostgreSQL)** | The real `AppModule` + real migrated PostgreSQL 17, via HTTP where a route exists | Schema, constraints, partial indexes, `FOR UPDATE` / `SKIP LOCKED` behaviour, transaction boundaries, concurrency outcomes, and the real guard/pipe/filter stack | Nothing about a third-party service. Nothing about production load, data volume, or a schema that differs from the migrations |
| **T3 — production integration** | Real external systems | — | **Nothing here has been exercised against a live system.** See §4 |

**Grep results are not proof of a runtime invariant.** Where this codebase makes
an invariant claim, the claim is backed by a T2 assertion or it is labelled as
unproven.

---

## 2. What tier each area sits at

| Area | Tier | Evidence |
|---|---|---|
| Migration set applies, fully reverts, re-applies; exactly 24 tables; zero leftover enum types | **T2** | `smoke.int-spec.ts` |
| Sales reporting: eligibility, event dates, cross-period refund, seller vs reversal actor | **T2** | `sales-reporting.int-spec.ts` |
| Online checkout: active-only basket, displacement, expiry, races, address ownership, address snapshot, retry safety | **T2** | `checkout.int-spec.ts` |
| POS idempotency: missing / replay / different payload / concurrent / attribution | **T2** | `pos-idempotency-contract.int-spec.ts`, `idempotency.int-spec.ts` |
| Payment receipt honesty, duplicate confirmation, late confirmation, post-cancellation, concurrent start | **T2** | `payment-fulfilment.int-spec.ts`, `payment-reconciliation.int-spec.ts` |
| Recovery fairness / starvation | **T2** | `recovery-starvation.int-spec.ts` |
| Auth: expiry, refresh-as-access, concurrent rotation, logout, password-change (incl. same second) | **T2** | `auth-session.int-spec.ts` |
| Realtime gateway authentication and room membership | **T2** | `realtime-auth.int-spec.ts` |
| Reservation lifecycle, POS displacement ordering, inventory concurrency | **T2** | `reservation-lifecycle`, `pos-displacement`, `inventory-concurrency`, `expiry-worker` |
| Idempotency-key shape validation, before any database work | **T1** | `order.service.spec.ts` › *create (pre-transaction validation)* |
| Provisional late-payment policy refusing to activate in production | **T1** | payment provisional-policy unit tests |
| **Zibal payment gateway** | **T3 — NOT EXERCISED** | Stub only. See §4 |
| **Redis** | **T2 with a substitute** | Integration tests bind an in-memory `RedisService`. Real Redis is unexercised by the suite |
| **MinIO / S3 object storage** | **T3 — NOT EXERCISED** | No test uploads a file |

---

## 3. Money units — confirmed, not assumed

Every monetary column is **`bigint`** in migration `0001`
(`products.basePrice`, `product_variants.price`, `orders.total_price`,
`orders.subtotal`, `order_items.unit_price`, `order_items.total_price`,
`payment.amount`, and `payment.gateway_amount` from `0010`). `bigint` cannot
hold a fractional currency amount, so the stored unit is a whole currency unit
throughout, and it is the **same** unit in every one of those columns.

The documented unit is **integer Rial**. Nothing in this round of work rescaled,
divided or multiplied a stored monetary value. One change went the other way: a
`amount * 10` in the payment gateway call, which assumed the database held
**Toman**, was **deleted** — Zibal is denominated in Rial and so is the database,
so the multiplier was inflating every gateway request tenfold. That is a removal
of a reinterpretation, not the introduction of one.

**Limitation, stated plainly.** This was confirmed from the schema and from the
code, which is enough to prove *internal consistency* and to prove that nothing
here changed the interpretation. It is **not** an inspection of the owner's
existing production data. Confirming that the real historical rows are Rial
rather than Toman requires looking at real values (a `SELECT` on a handful of
known sales), and no such database was available to this work — the review
PostgreSQL is empty by design, and the developer's own instance was
deliberately not touched. **Do this check before trusting any historical
revenue figure**, and note that if the existing data turns out to be Toman, the
correct fix is a data migration, never a silent change to how the code reads
the column.

---

## 4. Not exercised against real systems

These are **T3 — untested production integrations**. Nothing below has been run
against a live service, and no claim in this repository should be read as saying
otherwise.

* **Zibal payment gateway.** Every test binds `StubPaymentGateway`. The real
  `zibal.gateway.ts` has never issued a request. Its error mapping, its timeout
  behaviour and its response shapes are unverified.
* **Refunds.** No code path in this system moves money back, automatically or
  otherwise, and none was tested. Duplicate and overpaid receipts are *recorded*
  for a human to reconcile.
* **Redis.** The integration suite substitutes an in-memory implementation with
  matching semantics, including TTL. The real client's connection handling,
  reconnection and failure modes are unexercised.
* **MinIO / S3.** No test performs an upload or a signed-URL fetch.
* **Multi-instance deployment.** The concurrency protections are database
  primitives (`FOR UPDATE`, `SKIP LOCKED`, partial unique indexes, guarded
  conditional `UPDATE`s with asserted affected-row counts) and are tested with
  concurrent requests inside one process against one real database. That is
  strong evidence they hold across processes, because the enforcement is in
  PostgreSQL — but a genuine two-instance deployment has not been run.
* **Load and data volume.** Every test runs against a small fixture set. No
  statement about performance at scale is supported.

---

## 5. Acceptance criterion → test mapping

### The owner's four requirements

| Requirement | Proven by | Tier |
|---|---|---|
| **Reliable cashier attribution** — the seller is recorded once, from the token, and a later reversal never rewrites it | `pos-sale-attribution.int-spec.ts` (all); `sales-reporting.int-spec.ts` › *"keeps the seller and product snapshots after the cashier is renamed and deactivated"*, *"keeps the original cashier when someone else voids the sale, and records who did"*, *"keeps the sale on the original seller when a different user reverses it"*; `pos-idempotency-contract.int-spec.ts` › *"REFUSES a replay by a different cashier…"*, *"replays to the ORIGINAL cashier with the original attribution intact"* | T2 |
| **Reliable sales reporting** — only money actually taken counts, and each figure lands in the period its event happened | `sales-reporting.int-spec.ts` › *event-dated totals* (8 cases), incl. *"books a September sale in September and its October refund in October"*, *"excludes a PENDING online order from every sale figure"*, *"agrees between the money figures, the counts and the row list"* | T2 |
| **Four-hour ecommerce basket reservations** | `reservation-lifecycle.int-spec.ts`; `expiry-worker.int-spec.ts`; `cart-simple-product.int-spec.ts` › *"adding a simple product by productId alone takes a REAL 4-hour reservation"*, *"a simple product's hold expires at 4 hours like any other"*; `checkout.int-spec.ts` › *"a line whose hold expired is reported and excluded, never sold"* | T2 |
| **POS priority over basket reservations** — the till wins over baskets, but never over an order allocation | `pos-displacement.int-spec.ts`; `inventory-concurrency.int-spec.ts`; `cart-simple-product.int-spec.ts` › *"a POS sale DISPLACES a simple product basket line"*; `checkout.int-spec.ts` › *"a POS sale that displaced part of the basket forces confirmation and sells only the units still held"* | T2 |
| **Shared, authoritative inventory** — one sellable unit, one stock number, no bypass | `variant-default-sku.int-spec.ts`; `variant-backfill-migration.int-spec.ts`; `cart-simple-product.int-spec.ts`; `stock-adjust.int-spec.ts`; `inventory-concurrency.int-spec.ts` | T2 |

### The review findings

| Finding | Proven by | Tier |
|---|---|---|
| **A** Compose + reviewer database access | `docs/REVIEW-DATABASE.md` §4–§6: host-side `psql`, full suite in external mode, `docker` shim invocation count 0, fail-closed refusal on an unmarked server | T2 + executed evidence |
| **B** Unpaid orders counted as revenue; refund-period contradiction; seller vs reversal actor | `sales-reporting.int-spec.ts` (23 cases) | T2 |
| **C** Checkout: removed rows, partial displacement, expiry, concurrent checkout, another user's address | `checkout.int-spec.ts` (11 cases) | T2 |
| **D** Variant-less inventory bypass | `variant-default-sku.int-spec.ts` (6), `cart-simple-product.int-spec.ts` (10), `variant-backfill-migration.int-spec.ts` (9) | T2 |
| **E** Payment facts vs fulfilment idempotency | `payment-fulfilment.int-spec.ts` (9), `payment-reconciliation.int-spec.ts` (11) | T2 |
| **F** Recovery starvation | `recovery-starvation.int-spec.ts` (4), incl. F1 which was confirmed to FAIL against the pre-fix selection before being accepted as proof | T2 |
| **G** POS retry protection | `pos-idempotency-contract.int-spec.ts` (19), `idempotency.int-spec.ts` (8), `pos-sale-integrity.int-spec.ts` (7) | T2 |
| **H** Auth/session verification | `auth-session.int-spec.ts` (13), `realtime-auth.int-spec.ts` (13) | T2 |
| **I** Documentation claims | `smoke.int-spec.ts` asserts the 20/24 table counts and that the applied migration list equals the files on disk | T2 |

---

## 6. Skipped-test replacement mapping

**There are now zero skipped tests.** `pnpm test` reports `46 passed`, previously
`32 skipped, 46 passed`.

All twelve skipped blocks asserted the *previous* shape of services that have
since been reshaped, so none could be un-skipped as written. Each was **removed
and replaced**, with the mapping recorded as a comment in place of the deleted
block. Removing rather than leaving them skipped matters: a `describe.skip` is
reported in the test count and reads as coverage while testing nothing.

| Removed block | What it proved | Replacement (passing) |
|---|---|---|
| `product.service.spec.ts` `create` | product creation with categories/variants/images | `admin-coverage.int-spec.ts` › POST /products (3 cases) |
| `product.service.spec.ts` `findAll` | list + cache behaviour | `catalog-public.int-spec.ts` › anonymous list + search/filter/sort/paginate |
| `product.service.spec.ts` `it.skip` detail read | product by id | `catalog-public.int-spec.ts` › anonymous detail + cache-leak case |
| `product.service.spec.ts` `update` | field/category/variant update, NotFound | `product-update-contract.int-spec.ts` (4) + `product-variant-integrity.int-spec.ts` › foreign variant id |
| `product.service.spec.ts` `bookmark` | toggle on/off, NotFound | `product-bookmark.int-spec.ts` (6) |
| `order.service.spec.ts` `create` (3 `it.skip`) | checkout from cart, stock shortfall, missing variant | `checkout.int-spec.ts` › place-order, partial displacement, expiry |
| `order.service.spec.ts` `findAll` | staff order list | `admin-coverage.int-spec.ts` › GET /orders and GET /orders/:id (4 cases). The unbounded `OrdersService.findAll` it drove has since been **deleted**; `GET /orders` is served by the paginated, filtered, projected `AdminOrdersService.list`. |
| `order.service.spec.ts` `findOne` | order detail, missing order | `admin-coverage.int-spec.ts` › 404 + branch boundary; `checkout.int-spec.ts` › owner-scoped detail |
| `order.service.spec.ts` `updateStatus` | status transition, missing order | `sales-reporting.int-spec.ts` › state machine + void-by-another-user |
| `categories.service.spec.ts` `findAll` | category list | `catalog-public.int-spec.ts` › categories with product count |
| `categories.service.spec.ts` `findOne` | category by id, not found | `admin-coverage.int-spec.ts` › CategoriesService findOne (2 cases) |
| `categories.service.spec.ts` `removeOnlyCategory` | detach then delete | **The route and the behaviour are both gone.** `DELETE /categories/removeOnlyCategory/:id` detached every product and then deleted the category, answering 200; it was replaced by `DELETE /categories/:id`, which deletes **only an empty category** and otherwise refuses with **409 `CATEGORY_IN_USE`** (`details.productCount`), detaching nothing. Covered by `admin-coverage.int-spec.ts` › DELETE /categories/:id (4 cases: empty delete, 409 in-use with nothing deleted, 404, cache invalidation). |
| `categories.service.spec.ts` `safeRemove` | refuse while products attached | `admin-coverage.int-spec.ts` › CategoriesService safeRemove (3 cases) |

Every replacement runs against real PostgreSQL, and most through the real HTTP
route — strictly stronger evidence than the mocked originals, which asserted
that a mocked repository had been called with a particular options object.

---

## 7. A note on "flaky"

One intermittent failure surfaced during final verification: roughly one full
run in eight failed a single test, in a **different, unrelated suite each time**,
with `426 Upgrade Required` from a business route.

It was not retried away. `426` is the fixed response of the HTTP server the `ws`
package stands up on a port of its own, which no business route can produce —
so the request had reached a different listener entirely. Cause: supertest opens
`server.listen(0)` for **every** request and closes it afterwards, resolving the
URL from `server.address().port` and only then dialling it. Across several
hundred requests, an ephemeral port could be released and reassigned inside that
window. The harness now binds one listener per suite
(`test/integration/setup/test-app.ts`), which removes the class of failure
rather than reducing its frequency. Twelve consecutive full runs have been green
since.

The reason to record this: "unrelated suites failing at random" is the exact
shape that gets labelled flaky and re-run, and doing that here would have left a
real race in the harness — and, worse, established that a red run is something
to re-roll rather than explain.

---

## 8. Docker socket and host security

No host security control was weakened at any point. Specifically: the Docker
socket was not `chmod`-ed, no unauthenticated Docker TCP API was enabled, and no
authentication or TLS protection was disabled. The reviewer-access problem was
solved by removing the *need* for Docker rather than by widening access to it —
see `docs/REVIEW-DATABASE.md` §5–§6.

---

## 8. Final correctness pass — what was added, and what it proves

Added after the acceptance above, in the pass that closed the remaining
correctness issues. Every entry is a NEW spec file or a NEW block in an
existing one; nothing listed in §5 was removed or weakened.

### Reporting money is precision-safe

| Claim | Proven by |
|---|---|
| Every monetary value on `/reports/sales*` is a base-10 integer STRING, and stays exact above `Number.MAX_SAFE_INTEGER` | `reports-money-precision.int-spec.ts` (11 cases) — gross, refunded, voided, net, per-cashier, reversal actors, row list, sale detail, and a negative net, all at 2^53+1 |
| `netSales` is computed in `BigInt`, so a one-Rial difference between two values a float cannot hold survives | `reports-money-precision.int-spec.ts` › *"keeps netSales exact when the difference is one Rial"* |
| The dashboard and the report return **identical strings** for identical concepts, from one shared `subtractRial` helper | `reports-money-precision.int-spec.ts` › *"returns IDENTICAL strings to the dashboard…"*; `dashboard-date-semantics.int-spec.ts`; `admin-control-plane.int-spec.ts` |
| The sale-detail route no longer loads money through `bigIntTransformer`, which THREW above 2^53 rather than rounding | `reports-money-precision.int-spec.ts` › *"keeps every monetary field of the sale detail exact"* |

### The intermittent reporting failure

| Claim | Proven by |
|---|---|
| `pos.harness.ts` returned an UNBOUND HTTP server, so supertest opened and closed an ephemeral listener per request — the port-reuse race `setup/test-app.ts` had already diagnosed and fixed in the other harness only | The failure was captured as `socket hang up` (a transport error with no HTTP response) in a full run under `KAZHAL_INT_SHUFFLE_SEED=7919`, five minutes before the fix was written |
| Both harnesses now bind once, through one shared `bindTestServer`, and a harness that forgets fails immediately | `setup/test-app.ts` › `bindTestServer` / `assertBound`; `support/pos.harness.ts` |
| Suite order is stateable and replayable rather than cache-derived | `setup/shuffle-sequencer.js` (opt-in, `KAZHAL_INT_SHUFFLE_SEED`) |
| The harness can record login status, error codes, Set-Cookie NAMES, audience, database target, fixture identifiers and shared-table fingerprints — and never a credential | `support/diagnostics.ts`, `setup/diagnostics.setup.ts` (opt-in, `KAZHAL_INT_DIAG_FILE`) |

### Delegation

| Claim | Proven by |
|---|---|
| A user manager holding `users.create` and NO `rbac.read` can complete a user creation end to end, and is still refused every `rbac.read` route | `assignable-roles.int-spec.ts` (22 cases) |
| `users.create` implies no other user-management power — read, update, reset, deactivate, session-revoke and role assignment are each separately gated | `assignable-roles.int-spec.ts` › *"users.create implies no other user-management power"* |
| 22 delegated personas each see exactly their own sections and are refused every other one, make no unauthorised background request, and cannot escalate | `delegated-role-matrix.int-spec.ts` (80 cases) — the former "report reader" persona is gone, because no capability confers reporting |
| A `products.read`-only viewer cannot mutate anything through ANY route, including both stock-adjustment routes | `permission-enforcement-gaps.int-spec.ts` › *"a products.read-only viewer, calling the API directly"* |
| **Sales reports are the main administrator's alone.** A delegated administrator holding EVERY capability the catalogue publishes — with or without a branch — is refused all four reporting routes; so is a branch manager, a catalogue manager, a cashier, a customer and an anonymous caller | `pos-catalog-and-report-authz.int-spec.ts` › *"every principal that is not a super_admin"*, `delegated-role-matrix.int-spec.ts` › *"reporting and the money are nobody to delegate"* |
| A stale `role_permissions` row naming the retired `reports.read` — the state an upgraded database is actually in — opens nothing, and never appears in `/auth/admin/me` | `pos-catalog-and-report-authz.int-spec.ts` › *"is not opened by a STALE reports.read grant left in the database"* |
| A `super_admin` on a POS or storefront session is refused reporting at the AUDIENCE layer, before the role is consulted | `pos-catalog-and-report-authz.int-spec.ts` › *"refuses a super_admin holding a POS-audience session"* |
| Today's money is not reachable through the dashboard: `/admin/dashboard/summary` contains no money field at any depth, and `/admin/dashboard/financial` is `super_admin`-only | `delegated-role-matrix.int-spec.ts` › *"gives a dashboard.read holder counts and queues but no money, at any depth"* |
| Neither the order list nor the reconciliation desk is a side channel to the day's takings | `delegated-role-matrix.int-spec.ts` › *"leaves an orders.read holder with rows but no aggregate"*, *"leaves a reconciliation.read holder with the desk but no takings"* |

### Schema and sessions

| Claim | Proven by |
|---|---|
| `orders."orderNumber"` is `varchar(40)`, its UNIQUE constraint survives, and migration 0026 REFUSES rather than truncating a longer value | `order-number-length.int-spec.ts` (8 cases), incl. the up/down/up round trip on a scratch database |
| A password change ends every session immediately, with no same-second ambiguity and no retry | `auth-password-change.int-spec.ts`, `auth-session.int-spec.ts`, `audience-isolation.int-spec.ts`, `realtime-auth.int-spec.ts` |
| Concurrent password changes do not lose an increment | `auth-password-change.int-spec.ts` › *"does not lose an increment when two password changes race"* |
| Every catalogue permission is enforced by a real server-side path, read from the live container rather than from a source regex | `permission-coverage.int-spec.ts` (13 cases) |
