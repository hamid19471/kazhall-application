# Kazhal API — Backend Foundation Architecture

Authoritative spec for this work package. Owned by the lead agent.
**No workstream may change the schema or a shared contract signature unilaterally.**

## 0. Money, time, identity

| Concern | Decision |
|---|---|
| Money unit | **Integer Rial** in every `bigint` money column. The Zibal gateway is also Rial, so the existing `* 10` multiplier in `payment.service.ts` is **removed** (it assumed Toman storage). Display conversion to Toman is a frontend concern. |
| bigint typing | All money columns use `bigIntTransformer` (`src/common/transformers/bigint.transformer.ts`) so they are real JS `number`s, not strings. |
| Business timezone | `Asia/Tehran`, overridable via `REPORT_TIMEZONE`. Report date ranges are **inclusive local calendar days** converted to UTC instants at the boundary. `2026-09-01..2026-09-01` means `[2026-09-01T00:00+03:30, 2026-09-02T00:00+03:30)`. |
| Cashier identity | Always `req.user.sub` from the verified access token. `cashierId`/`branchId` in a request body are **ignored for authorization** — never trusted. |

## 1. Inventory model

Four separately tracked quantities — see `src/modules/inventory/inventory.types.ts` for the normative definition.

```
physicalStock   = product_variants.stock                    (never negative)
basketReserved  = Σ active reservations kind='basket'
orderAllocated  = Σ active reservations kind='order'

availableForBasket = physicalStock - basketReserved - orderAllocated
availableForPos    = physicalStock - orderAllocated
```

POS may displace **basket** reservations. POS may **never** displace **order** allocations.

### Reservation lifecycle

```
                 reserveForBasket
                        │
                        ▼
   ┌──────────── ACTIVE(basket) ───────────┐
   │              │            │            │
   │ expiry       │ user edits │ POS needs  │ checkout
   ▼              ▼            ▼            ▼
RELEASED       RELEASED     REVOKED    ACTIVE(order)
(expired)   (removed/       (sold_in_        │
             qty_reduced)    store)          │ ┌─ cancel/payment fail ─▶ RELEASED
                                             │ │
                                             ├─┤
                                             │ └─ allocation expiry ───▶ RELEASED
                                             │
                                             └─ payment fulfilled ────▶ CONSUMED
```

### Timer rules (owner requirement: 4 hours)

* `BASKET_RESERVATION_TTL_MS = 4h`. `expiresAt` is **immutable after insert**.
* Reads / refreshes / idempotent replays never touch `expiresAt`.
* **Quantity increase** ⇒ a **new tranche row** with its own 4h TTL. Existing tranches keep their expiry.
* **Quantity decrease** ⇒ release **newest tranche first**, so surviving units are the oldest. (Releasing oldest-first would leave later-expiring units and silently extend the hold.)
* API exposes `expiresAt` = **earliest** active tranche expiry (when the line first starts losing units), plus a per-tranche breakdown.

### Displacement ordering

`ORDER BY expiresAt ASC, id ASC` — soonest-to-expire first, ties by insertion order.
Deterministic and reproducible; explicitly **not** a customer-priority tier.

### Concurrency rules (R1–R7)

Normative text lives in `inventory.types.ts`. Summary:

* **R1** multi-variant ops lock `FOR UPDATE` in ascending `variantId`.
* **R2** stock changes only via `UPDATE … WHERE id=:id AND stock >= :q RETURNING stock`, affected rows asserted `=== 1`. `RETURNING` is the committed balance published in events.
* **R3** reservations leave ACTIVE only via `UPDATE … WHERE id=:id AND status='active'`, affected rows asserted `=== 1` ⇒ no double release.
* **R4** `expiresAt` immutable.
* **R5** lazy expiry inside the same transaction ⇒ correctness never waits for the sweeper.
* **R6** POS sale is one atomic transaction (displacement + basket mutation + decrement + order + snapshots + payment method + attribution + movements + idempotency row).
* **R7** notifications post-commit and advisory; next basket read re-derives truth.

## 2. Active-payment boundary  ⚠ contains one open owner decision

**Transition.** At checkout, the user's `basket` reservations for the ordered variants are converted in-transaction into `order` allocations bound to `orderId`, with a fresh allocation TTL. Shortfalls (from displacement/expiry) are topped up from free stock; if that fails, checkout fails **before** any payment is started.

**POS races checkout.** Whoever commits first wins. Once the checkout transaction commits, the stock is `order`-allocated and POS can no longer take it (`availableForPos` excludes it). Before that commit, the units are only `basket`-reserved and POS may displace them.

**Payment succeeds after allocation expired.** Two committed phases:

* **Phase 1** — record `payment.status=SUCCESS`, `order.status=PAID`, `order.fulfillmentState=PENDING`. **Commit.** A confirmed payment is *never* rolled back.
* **Phase 2** — separate transaction: consume allocations, decrement stock, `fulfillmentState=FULFILLED`. If stock is unavailable ⇒ `fulfillmentState=AWAITING_STOCK` (a recorded, queryable recovery state) — not a silent failure, not a rollback.

If the process dies between phases, `FulfilmentRecoveryService` re-drives any `PAID` order whose `fulfillmentState ∈ {PENDING, AWAITING_STOCK}`. Phase 2 is idempotent per order.

Double-fulfilment across payment attempts is blocked by a **partial unique index** `uq_payment_one_success_per_order ON payment(orderId) WHERE status='success'`.

> **OPEN OWNER DECISION D-2.** (a) allocation TTL — provisional default **30 min** (`ORDER_ALLOCATION_TTL_MS`); (b) what to do in `AWAITING_STOCK` — auto-refund vs back-order vs manual. Implemented as: record the state, expose it in reports, alert admins, take **no** automatic financial action. Isolated in `FulfilmentRecoveryService`; **not production-ready until D-2 is answered.**

## 3. Seller attribution & retention

* `orders.cashierUserId` → `users(id)` **ON DELETE RESTRICT** (staff with sales cannot be hard-deleted).
* `users.deactivatedAt` — soft deactivation is the supported way to retire staff; deactivated users fail login.
* `orders.cashierDisplaySnapshot`, `orders.branchNameSnapshot` — survive renames.
* `order_items.productTitleSnapshot / variantSkuSnapshot / attributesSnapshot` — immutable line snapshots.
* `order_actions` — append-only; every later void/return/status change records its **own** actor. The original seller is never overwritten.

## 4. Schema changes (single source of truth for the migration owner)

**New tables**

| Table | Purpose |
|---|---|
| `stock_reservations` | basket + order holds |
| `stock_movements` | append-only physical-stock ledger with `balanceAfter` |
| `idempotency_keys` | `UNIQUE(scope,key)` request replay protection |
| `order_actions` | post-creation audit with actor |
| `product_branch_visibility` | (0030) which branches sell a `selected`-mode product. **Visibility only — NOT per-branch stock.** |

**Altered — `orders`**: `cashierUserId` (FK RESTRICT), `cashierDisplaySnapshot`, `branchNameSnapshot`, `paymentMethod` enum(`cash`,`card_terminal`,`online_gateway`,`other`), `orderNumber` UNIQUE, `soldAt`, `fulfillmentState` enum(`not_required`,`pending`,`fulfilled`,`awaiting_stock`,`failed`), `voidedAt`, `subtotal` bigint.

**Altered — `order_items`**: `productTitleSnapshot` NOT NULL, `variantSkuSnapshot`, `attributesSnapshot` jsonb, `productCodeSnapshot` varchar(32) and `variantCodeSnapshot` varchar(64) (0032). The two codes are snapshotted for a reason the SKU does not have: a code is EDITABLE by a super_admin, so without a snapshot correcting a typo would rewrite what every past receipt says was sold. Both stay NULLABLE — a legacy line whose catalogue row was already deleted has no recoverable code, and a NULL says "not recorded" rather than inventing one.

**Altered — `cart_items`**: `status` enum(`active`,`removed`), `lastChangeReason`, `lastChangeAt`, `lastChangeQtyDelta`.
Replace `UNIQUE(user,product,variant)` with **partial unique** on `(userId, productId, variantId) WHERE status='active'` (soft-removed lines must not block re-adding).

**Altered — `product_variants`** (added by WS-B, ratified by lead): `isActive` boolean NOT NULL DEFAULT true, plus index `idx_variant_product_active ON product_variants(productId, isActive)`. Deactivation rather than deletion, because `order_items` reference variants and history must survive.
Also `variantCode` varchar(64) NOT NULL (0031), unique `uq_product_variants_variant_code`, CHECK `ck_product_variants_variant_code_format` (`^[A-Z0-9]+(-[A-Z0-9]+)*$`). **`sku` is untouched** — a SKU is the warehouse's (often a vendor's) string, a code is the store's own business identifier; two jobs, two columns.

**Altered — `products`** (0030, 0031):
- `productCode` varchar(32) NOT NULL, unique `uq_products_product_code`, CHECK `ck_products_product_code_format` (same pattern).
- `visibleOnSite` boolean NOT NULL DEFAULT false — the WEBSITE channel.
- `branchVisibility` enum `products_branchvisibility_enum('none','all','selected')` NOT NULL DEFAULT `'none'` — the RETAIL channel.
- partial index `idx_products_visible_on_site ON products(id) WHERE "visibleOnSite" = true`, and `idx_products_branch_visibility ON products("branchVisibility")`.

The two visibility dimensions are INDEPENDENT, not one six-valued enum: the owner's six cases are the product of two smaller decisions, and one enum makes the seventh case unrepresentable.

| case | `visibleOnSite` | `branchVisibility` |
|---|---|---|
| website only | true | `none` |
| all retail branches | false | `all` |
| selected retail branches | false | `selected` |
| website + selected | true | `selected` |
| website + all («همه کانال‌ها») | true | `all` |
| hidden / draft | false | `none` |

`'all'` is a MODE evaluated at read time, never a materialised row set, so a branch opened next month inherits it with no catalogue replay. `'selected'` is the deliberate opposite.

Two states are made UNREPRESENTABLE by a DEFERRABLE constraint trigger (`trg_product_branch_visibility_consistent`) rather than by the service remembering: mode `'selected'` with zero mapping rows, and mapping rows under any other mode. A CHECK cannot express either — both span two tables. `DEFERRABLE INITIALLY DEFERRED` is load-bearing: switching `'all'` → `'selected'` is necessarily two statements and one order is always momentarily invalid, so only the COMMITTED pair has to be valid. Duplicate mappings are impossible by the composite primary key.

⚠ **THIS IS VISIBILITY, NOT INVENTORY.** No column above splits stock. `product_variants.stock` remains one global number, `stock_reservations` stays branch-less, order allocations stay global and POS displacement priority is unchanged. Two selected branches selling the last unit race for the same row and exactly one wins — exactly as two cashiers in one shop do. `test/integration/product-channel-visibility.int-spec.ts` pins this.

**Sequences** (0031): `product_code_seq` and `variant_code_seq`, both `setval` past `max(id)` at migration time so a generated code can never collide with a backfilled one. `nextval` is the allocator because it is atomic across API instances; `max(id)+1`, timestamps and in-process counters are all rejected in that migration's header. Gaps from abandoned codes are accepted and deliberately not chased.

**Altered — `users`**: `deactivatedAt`, `passwordChangedAt`, `mustChangePassword` (0023), `passwordVersion` (0027 — the session epoch every token carries as `pv`; `passwordChangedAt` is now a record, not an authorisation input).

**Altered — `payment`**: partial unique `(orderId) WHERE status='success'`; unique `track_id` where not null.

**Money columns** gain `bigIntTransformer`: `products.basePrice`, `product_variants.price`, `orders.total_price`, `orders.subtotal`, `order_items.unit_price`, `order_items.total_price`, `payment.amount`.

**Baseline and table count.** Migration `0001` (`BaselineSchema`) creates the **20 application tables** of the existing schema, including the join tables `user_roles`, `product_category`, `bookmark_products`, `variant_product_attribute_value`. Migration `0002` (`InventoryAuditTables`) adds **4**. Five later migrations add one each: `0017` `otp_challenges`, `0018` `payment_actions`, `0020` `permissions` and `role_permissions` (two), `0022` `admin_audit_log`, `0030` `product_branch_visibility`. The total after every migration is **30**.

(This paragraph previously said "no later migration adds a table" and claimed **24**. That stopped being true at 0017 and the sentence was never corrected; the smoke spec's number has been the truth throughout. It is restated here so the two agree.)

Those numbers are not a claim, they are an assertion: `test/integration/smoke.int-spec.ts` names all 20 baseline tables, names the later ones, and asserts `listTables(ds)` has exactly `APPLICATION_TABLE_COUNT = 30` — "and nothing else". The same spec applies every migration, reverts every one of them, asserts **zero** tables and **zero** leftover enum types survive, and re-applies the whole set. It also asserts the applied migration list equals the migration files on disk, so a migration that exists but never ran fails the suite.

`synchronize` becomes `NODE_ENV !== 'production'` and is **false** under test (tests run migrations).

### Migrations 0009 – 0015 (this round)

| # | Name | What it changes | Backfill / compatibility |
|---|---|---|---|
| 0009 | `OrderMoneyEventTimestamps` | `orders."paidAt"`, `orders."refundedAt"` (both `timestamptz`); expression index on `COALESCE("paidAt","soldAt")`; partial indexes on `refundedAt`/`voidedAt`; a `BEFORE INSERT OR UPDATE OF status` trigger that fills either column only while it is still NULL | POS rows: `paidAt := soldAt` (exact — `recordPosSale` writes `soldAt = paid_at = now` with status PAID). Online rows: from `paid_at` where non-NULL. `refundedAt := MIN(order_actions."createdAt")` for `return`/`refund`. **Cannot know:** an online order whose money was taken but `paid_at IS NULL`, and a refund with no audit row — both left NULL rather than dated from the sale, which is the bug being fixed |
| 0010 | `PaymentConfirmedUnapplied` | `payment_status_enum` gains `confirmed_unapplied` (type recreated, not `ALTER TYPE ... ADD VALUE`, which cannot be used in the same transaction); `ref_number`, `gateway_amount` (integer Rial), `requires_reconciliation`, `reconciliation_reason`, `reconciled_at`, `reverify_attempts`, `last_reverified_at`, `next_reverify_at`; two indexes | None needed — every column defaults or is nullable. **`down()` is lossy and says so:** the old enum cannot express "confirmed but unapplied", so those rows map back to `pending`. Export before rolling back |
| 0011 | `OrderFulfilmentRetrySchedule` | `orders."fulfillmentAttempts"`, `"fulfillmentLastAttemptAt"`, `"fulfillmentNextAttemptAt"`, `"fulfillmentLastError"`; partial index `idx_orders_fulfillment_due` | None. **`fulfillmentNextAttemptAt IS NULL` means "due now"** — the state of every pre-existing row, so nothing recoverable becomes invisible |
| 0012 | `ProductDefaultVariant` | Default-variant model for option-less products (workstream D) | See §7 |
| 0013 | `CartItemsRequireVariant` | Closes the variant-less basket bypass (workstream D) | See §7 |
| 0014 | `IdempotencyKeyShapeConstraint` | `CHECK (btrim("key") <> '')` on `idempotency_keys`, added `NOT VALID` | `NOT VALID` skips the table scan, so one legacy row cannot turn a hardening step into a failed deployment. Still enforced on every INSERT/UPDATE. `VALIDATE CONSTRAINT` can be run later by hand |
| 0015 | `OrderAddressSnapshot` | `orders."addressSnapshot"` jsonb | Backfilled from the address each order still points at, stamped `capturedAt: null, backfilled: true`. That is **not** a claim about what the address said at order time — it is what it says today, which is the only thing knowable now. Orders whose address was already deleted stay NULL |

**Altered — `addresses`**: `userId` is now an explicit column on the entity rather than an implicit relation column, because every customer-facing read is scoped by it and an ownership check that requires remembering to join is one that eventually gets forgotten.

## 5. Totals semantics (reporting)

**Rewritten after the independent review found that the code and this document
disagreed.** The previous text promised "a return in October of a September sale
reduces October", while every figure in `ReportsService` — refunds included —
was ranged on `orders."soldAt"`. A September sale refunded in October landed
entirely in September, in both directions. The document was right and the code
was wrong; migration `0009` added the columns that make the documented rule
expressible, and the code now implements it.

### What counts as a sale

A figure counts as a **completed sale** only when **the money was actually
taken**. That is a whitelist, not a blacklist:

```
ELIGIBLE_SALE_STATUSES = paid, processing, shipped, delivered, refunded
NON_SALE_STATUSES      = pending, canceled, failed
```

plus voided sales, which carry `status = canceled` but **did** have money taken
(`paidAt IS NOT NULL AND voidedAt IS NOT NULL`).

The old rule was `status NOT IN (canceled, failed)`. `pending` is neither, and
**every online order is `pending`** from checkout until the gateway confirms — so
every abandoned basket was being counted as revenue and as units sold. A
blacklist also silently admits any status added later; the whitelist refuses
what it was not told about.

### Event dates — each figure is placed by its own

| Figure | Dated by |
|---|---|
| revenue (`grossSales`, `unitsSold`, `salesCount`) | `COALESCE(orders."paidAt", orders."soldAt")` |
| `refundedTotal`, `refundedCount`, `unitsRefunded` | `orders."refundedAt"` |
| `voidedTotal`, `voidedCount`, `unitsVoided` | `orders."voidedAt"` |

For a POS sale the revenue date is the instant it was rung up. For an online
sale it is the **gateway confirmation**, not the checkout click — `soldAt` on an
online order is stamped while the order is still `pending`, so dating revenue by
it books an abandoned basket's would-be money on the day the customer clicked.
The `soldAt` fallback applies only to rows whose payment instant is
unrecoverable.

`netSales = grossSales − refundedTotal − voidedTotal`, each from the same range
but from its own event date. **No profit metric** — cost of goods is not
modelled anywhere, so any "profit" figure would be revenue with a misleading
label.

### Worked cross-period example

One order, 6,000,000 IRR, 3 units. Sold and paid **2026-09-15**, returned
**2026-10-20** (Asia/Tehran calendar days).

| | September | October | Sept–Oct combined |
|---|---|---|---|
| `orderCount` | 1 | 0 | 1 |
| `salesCount` | 1 | 0 | 1 |
| `grossSales` | **6,000,000** | **0** | 6,000,000 |
| `unitsSold` | 3 | 0 | 3 |
| `refundedCount` | 0 | 1 | 1 |
| `refundedTotal` | **0** | **6,000,000** | 6,000,000 |
| `netSales` | 6,000,000 | **−6,000,000** | **0** |

Nothing is counted twice: the sale is in September's gross only, the refund is in
October's `refundedTotal` only. Asserted by
`sales-reporting.int-spec.ts` › *"books a September sale in September and its
October refund in October"*.

### Consistency and attribution

* `salesCount`, `unitsSold` and `grossSales` come from **one shared SQL
  predicate**, as do the refund trio and the void trio, so they cannot drift
  apart. `unitsSold` is a per-order scalar subquery, not a `JOIN order_items`,
  so it cannot double count and a zero-item order scores 0 instead of vanishing.
* **Seller attribution is never rewritten by a reversal.** `by-cashier` groups by
  `orders."cashierUserId"`, which is written once from the authenticated
  principal. Who *reversed* a sale is a different question with a different
  answer: `reversalsByActor`, a separate query over `order_actions` grouped by
  `actorUserId`. The two are siblings in the response and are never merged.
* Refunds whose event date was never recorded (refunded before the audit trail
  existed, or by a direct data fix) are reported as
  `dataQuality.refundsWithUnknownEventDate` — deliberately **outside** `totals`
  so nobody sums it across periods. They are excluded from a ranged
  `refundedTotal` and included in an all-time one, where no date is needed.

### API

```
GET /reports/sales/summary?from=2026-09-01&to=2026-09-30&cashierUserId=4
GET /reports/sales?from=2026-09-01&to=2026-09-30&cashierUserId=4&page=1&limit=20
GET /reports/sales/by-cashier?from=2026-09-01&to=2026-09-30
GET /reports/sales/123
```

`from`/`to` are inclusive `YYYY-MM-DD` local days in `REPORT_TIMEZONE`.
`cashierUserId` filters by the **seller**, never by the reversal actor.
`branchId` is super-admin only; a `sale` user is pinned to their own branch by
the token and asking for another branch is a 403, not a quietly rewritten
filter.

> **OPEN OWNER DECISION D-3.** A defensible alternative reading is "a void was
> never revenue": exclude it from gross, make `voidedTotal` informational, and
> define `net = gross − refunded`. Both readings are internally consistent and
> produce different dashboard numbers. The shipped default is the one above.
> **Needs owner confirmation before these figures are reported to the business.**

> **OPEN OWNER DECISION D-4 (new).** Online revenue is dated by the **payment
> instant**. If the business accounts on order date instead, `REVENUE_DATE_SQL`
> in `reports.service.ts` and the matching expression index in migration 0009
> are the only two places to change.

## 6. Workstream ownership (no file is owned by two agents)

| WS | Owns | Must not touch |
|---|---|---|
| **A** auth/bootstrap/config/test-infra | `modules/auth/**`, `modules/realtime/**`, `database/seeder/**`, `configs/**`, `common/interceptors/**`, `common/exceptions/**`, `common/services/idempotency.service.ts`, `migrations/**`, `test/**`, all 7 existing `*.spec.ts` repairs, `.env.example` | everything else |
| **B** catalog | `modules/products/**`, `modules/categories/**`, `database/cache*.ts`, `database/redis.service.ts` | orders, cart, payment, inventory impl |
| **C** POS/attribution/reporting | `modules/orders/**` (except `entities/order-action.entity.ts` which is lead-authored), `modules/reports/**`, `modules/customer/**`, `modules/user/**` | inventory impl, cart, payment |
| **D** reservations/stock/payment | `modules/inventory/**` (except `inventory.types.ts` + entities, lead-authored), `modules/cart/**`, `modules/payment/**` | orders, products, auth |

**Lead-owned, no agent edits:** `app.module.ts`, `main.ts`, `package.json`, `inventory.types.ts`, the four new entity files, `common/transformers/**`, this document.

## 7. Sellability: raw stock versus what may be sold

**One rule, everywhere:**

> Raw physical availability remains visible for inventory management, but
> `isActive = false` makes the variant unsellable through both Storefront and
> POS.

| Surface | What it reports | Why |
|---|---|---|
| `GET /inventory/availability` | RAW `physicalStock`, `basketReserved`, `orderAllocated`, `availableForBasket`, `availableForPos`, **plus `isActive`** | An administrator reconciles what is on the shelf. The quantities are unclamped and `isActive`-blind, so a retired SKU reports its true stock — and therefore a **positive `availableForPos` that must not be sold**. |
| `GET /inventory/lookup` | the same raw snapshot, **plus `sellableInStore` / `sellableOnline` / `unsellableReason`** | A cashier holding the box needs to identify a retired SKU rather than see "unknown SKU". The sellability answer is stated so no client has to reconstruct the rule from a number. |
| POS catalogue (`GET /inventory/catalog`) | excludes inactive variants entirely | Nothing that cannot be sold should be offerable. There is no `products.isActive` column: retiring every variant is how a product is withdrawn. |
| Admin inventory | shows retired variants with their stock (opt-in flag) | Their history and their units both still exist. |
| Public catalogue / detail | omits retired variants | `deriveAvailability` returns zero for them. |

**Derivation** lives in exactly one function, `inventory/availability.projection.ts`
→ `deriveAvailability()`. **Enforcement** lives in exactly one function,
`InventoryService.assertSellableUnderLock()`, called from every sell path
after `lockVariants` and before anything is written:

| Path | Refusal |
|---|---|
| `POST /orders/pos` → `recordPosSale` | 409 `VARIANT_INACTIVE`, before the order, its lines, the payment row, the stock decrement, any reservation displacement and any realtime frame |
| `POST /orders` → `convertBasketToOrderAllocation` | 409 `VARIANT_INACTIVE` (the storefront sale boundary) |
| `POST /cart`, `PATCH /cart/:id` → `reserveForBasket` | 409 `VARIANT_INACTIVE` (a retired SKU takes no new hold) |
| `consumeForPosSale` | asserts again — it is the one primitive that moves physical stock, so a future caller inherits the rule |

Restore paths (void, return, stock adjustment) deliberately do **not** gate on
`isActive`: retiring a SKU must not trap units inside a mistaken sale. They put
the units back, and the units remain unsellable.

**The race is resolved by the row lock, not by a re-read.** Deactivation is
`UPDATE product_variants SET "isActive" = false WHERE id = $1`, which needs the
same row `lockVariants` takes `FOR UPDATE`. Either the sale holds the lock
first (the deactivation waits; the sale was valid when it committed) or the
deactivation commits first (the sale's locked read returns `false` and answers
409). Both observing a stale active state is not reachable. Evidence:
`test/integration/pos-inactive-variant.int-spec.ts`.

## 8. Realtime deployment limitation (single node)

Socket.IO runs with the **in-memory adapter**. There is no Redis adapter, by
owner decision, and the deployment is single-node.

**What is node-local, and would silently go partial on a second node** — these
read like security features, which is why they are named here rather than left
to be discovered:

- `RealtimeGateway.disconnectUser()` — session revocation, deactivation and
  password change end a user's live sockets through it.
- `RealtimeGateway.reconcileUser()` — re-decides one principal's sockets after
  a role or branch change.
- `RealtimeGateway.reconcileAll()` — re-decides every socket after a
  permission-model change (`setRolePermissions`, `setRoleActive`).
- The periodic sweep, `revalidateAll()`.

All four resolve sockets through `fetchSockets()`, which reaches only this
process without a cluster adapter. **Multi-node Socket.IO delivery is
unsupported in this deployment.**

### When an immediate reconciliation fails

An authorization change that has committed is **never rolled back** because the
push to live sockets failed — the committed change is the half that matters.
Instead:

1. The failure is reported as one structured line,
   `logger.error(JSON.stringify(…))` with
   `event: "realtime.reconciliation.failed"`, carrying `scope`, `stage`,
   `reason`, `userId`, `audience`, `examined`, `failed`, a redacted `error`
   and `backstopWithinMs`. It never touches the handshake; `safeErrorText`
   redacts JWTs and `kz_*` cookies so the guarantee is code, not convention.
2. A per-socket failure **fails closed** — the socket is disconnected, because
   we could not establish that it is still entitled.
3. The periodic sweep is the backstop, so the **maximum temporary exposure
   window on this single-node deployment is one sweep interval
   (`REVALIDATION_INTERVAL_MS` = 60 s) after the change commits**, plus the
   time one sweep takes to walk the sockets. On multiple nodes this bound does
   not hold, per the limitation above.

Evidence: `test/integration/rbac-socket-reconciliation.int-spec.ts` (group F)
and `src/modules/realtime/realtime.gateway.spec.ts`.
