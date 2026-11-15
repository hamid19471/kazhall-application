# Monthly cost-recovery pricing plans

Authoritative contract for `/admin/pricing-plans/*` (migration 0038). Everything
is integer Rial; rates are integer basis points (1 bp = 0.01 %). This feature
**reads** the purchase-cost accounting of `PURCHASE-COST-ACCOUNTING.md` and never
changes it: it never writes a cost, a stock figure, an order or a report.

> **A plan is a pricing target, not a forecast.** The configured monthly costs
> are covered only if actual monthly revenue reaches the target. Nothing here
> predicts or guarantees sales or profit. Saving inputs or calculating a
> preview never changes a price; only an explicit, confirmed **apply** does.

---

## 1. Method `TARGET_REVENUE`, formula version 1

Inputs: monthly costs `C` (the sum of the plan's **active** cost entries), target
monthly revenue `R`, tax rate `t`, target profit margin `p`, rounding step `s`.

```
operatingCostRate = C / R
denominator       = 1 − C/R − t − p
rawPrice          = weightedAverageCost / denominator
proposedPrice     = ⌈rawPrice / s⌉ × s                     (rounded UP)
```

`C/R`, `t` and `p` are all **shares of the final selling price (of revenue)**,
not mark-ups on cost. The price is one exact rational number computed in BigInt:

```
rawPrice = cost × 10000·R / (10000·R − 10000·C − (t + p)·R)     (t, p in bp)
```

and rounding happens once, upward, from that rational — never from a rounded
intermediate — so rounding can only increase the covered share. The stored raw
price (`numeric(30,4)`) is rounded up at 4 decimal places for display only.

### Worked example

| Input | Value |
|---|---|
| monthly costs | 1 000 000 000 |
| target monthly revenue | 5 000 000 000 |
| operating cost rate | 20 % |
| tax | 10 % |
| target profit margin | 20 % |
| denominator | 50 % |
| weighted-average cost | 1 000 000 |
| **proposed price** | **2 000 000** |

The 2 000 000 splits as 400 000 operating cost (20 %) + 200 000 tax (10 %) +
400 000 profit (20 %) + 1 000 000 purchase cost (50 %).

With a step of 10 000, a cost of 1 000 001 gives raw 2 000 002 → **2 010 000**.
Receipts of 3 @ 1 000 000 and 2 @ 1 500 000 give the exact average
⌊6 000 000 / 5⌋ = 1 200 000 → **2 400 000** (asserted end to end in
`pricing-apply.int-spec.ts` through the real receipt endpoint).

### Validation (400, stable codes)

| Code | When |
|---|---|
| `PRICING_INPUTS_INCOMPLETE` | revenue, tax or profit not entered |
| `PRICING_TARGET_REVENUE_NOT_POSITIVE` | `R ≤ 0` |
| `PRICING_AMOUNT_NEGATIVE`, `PRICING_AMOUNT_INVALID`, `PRICING_AMOUNT_TOO_LARGE` | any amount negative, fractional or > 10¹⁵ |
| `PRICING_TAX_RATE_OUT_OF_RANGE`, `PRICING_PROFIT_MARGIN_OUT_OF_RANGE` | outside `[0, 100 %)` or more than two decimals |
| `PRICING_ROUNDING_STEP_INVALID` | step outside 1 … 10 000 000 |
| `PRICING_DENOMINATOR_NOT_POSITIVE` | `C/R + t + p ≥ 100 %`; the Persian message tells the manager to raise the revenue target, cut costs or lower tax/profit |
| `PRICING_NO_ELIGIBLE_VARIANTS` | no active, offered variant with a fully known cost |

Percent inputs are **text** (`"12.5"`), parsed digit by digit; money inputs are
a JSON integer or a base-10 string. No rate or Rial passes through a float.

### Future methods

Every plan, calculation run and preview row stores `calculationMethod` and
`formulaVersion`; the calculation run stores an **immutable** `inputsSnapshot`
(amounts, rates, step, review rules, the full cost-entry list and the derived
operating-cost rate). A later `PRODUCT_SALES_FORECAST` method is a new CHECK
value and a new evaluator; historical plans keep their meaning. No forecast
table or UI exists yet, deliberately.

---

## 2. Eligibility (per variant, independently)

The price written is `product_variants.price` — the price every checkout, quote
and POS sale charges under the variant lock. A simple product is priced through
its default variant. `products.basePrice` is **not** changed (it is the admin
form's display "from" price; the code's stated direction is that the variant
price is the only charging authority).

The cost basis is the existing exact moving weighted average
(`valuation.ts#averageUnitCost`: ⌊inventoryCostValue / valuedQuantity⌋). The last
purchase price is never used.

| Status | Reason codes | Meaning |
|---|---|---|
| `BLOCKED` | `VARIANT_INACTIVE`, `PRODUCT_NOT_OFFERED`, `COST_UNKNOWN`, `COST_PARTIALLY_UNKNOWN`, `NO_COST_BASIS` (no valued stock), `ZERO_COST_BASIS`, `PRICE_OUT_OF_RANGE`, and `STALE` (set at apply) | The **data** is the problem. Never applied. Fix it and recalculate. |
| `NEEDS_REVIEW` | `CURRENT_PRICE_MISSING`, `CURRENT_PRICE_ZERO`, `PRICE_DECREASE` (plan rule, default on), `LARGE_INCREASE` (above the plan's threshold, default 20 %, exclusive) | The **change** is unusual. A super_admin may approve it (include the row). |
| `READY` | — | Included by default. |
| `UNCHANGED` | — | Proposed = current. Included only with a different manual price. |

A manual price (`overridePriceRial`) must be ≥ 1, ≤ `MAX_RIAL` and not below
the variant's cost basis; setting it includes the row. The **final price** is
`override ?? proposed`. A row is **applicable** when it is included, not stale,
not blocked, and its final price differs from its snapshot current price.

---

## 3. Data (migration 0038, additive and reversible)

| Table | Purpose |
|---|---|
| `pricing_plans` | inputs (`bigint` Rial, `integer` bp), review rules, `status`, method/version, lifecycle stamps |
| `pricing_plan_cost_entries` | title, `amountRial`, `scope` general/branch (+ `branchId`), note, `isActive`, `sortOrder` |
| `pricing_plan_runs` | one durable row per calculate/apply/rollback: idempotency key + request hash, progress, heartbeat, `inputsSnapshot` (calculate only), result, error code. Partial unique index: **one active run per plan** |
| `pricing_plan_items` | the persisted preview: identity + channel + category snapshots, pool snapshot, `costBasisRial`, `currentPriceRial`, `rawPrice`, `proposedPriceRial`, review decisions; generated `finalPriceRial`, `changeRial`, `changePercent` |
| `pricing_price_changes` | append-only history: plan, run, item, variant, old → new price, `revertsChangeId`, method, version, actor, time |

Triggers: the item **snapshot half** is immutable (only include / override /
review / stale may change); a run's identity and input snapshot are immutable;
the price history is append-only. States are `varchar` + CHECK, so `down()`
leaves no type behind (asserted by the smoke spec's up → down → up).

---

## 4. Lifecycle

```
DRAFT ──calculate──▶ CALCULATING ──▶ READY_FOR_REVIEW ──approve──▶ APPROVED ──apply──▶ APPLYING ──▶ APPLIED ──rollback──▶ ROLLED_BACK
  ▲                      │                 │   ▲                       │                  │
  └──── edit ────────────┴──── FAILED ◀────┘   └──── unapprove ────────┘                  │
                                   ▲                                                      │
                                   └──────────── stale → READY_FOR_REVIEW ◀───────────────┘
```

* Inputs and cost entries are editable in `DRAFT`, `READY_FOR_REVIEW` and
  `FAILED`; an edit discards the preview and returns the plan to `DRAFT`.
* `APPROVED` freezes the rows. `unapprove` returns to review.
* A failed apply keeps its approval (nothing was written), so it can be retried
  with a new key. `APPLIED` and `ROLLED_BACK` plans are never edited or deleted.
* Illegal transitions are refused with `PRICING_PLAN_STATE_CONFLICT` (409).

---

## 5. Preview API

`GET /items` is server-side paginated (limit ≤ 100), filtered and sorted:
`view` (`exceptions` default | `all` | `applicable`), `search` (title, product
code, variant code, SKU — `%`/`_` are literals), `status`, `categoryId`,
`channel` (site | branches | both | none), `direction`, `min/maxChangePercent`,
`included`, `stale`; `sort` product | changePercent | changeRial | currentPrice |
finalPrice | costBasis | status with an id tiebreaker. `POST /items/bulk` takes
**the same filters** and applies to every matching row, not to a page;
approving `NEEDS_REVIEW` rows in bulk needs `approveNeedsReview: true`.
`GET /summary` returns counts by state, included/applicable counts and the
min/average/max percent change over non-blocked rows. CSV export is not
provided: the project has no export pattern to follow yet.

---

## 6. Apply and rollback

Kazhal has no queue system; background work is DB-backed rows claimed with
`FOR UPDATE SKIP LOCKED` by an in-process worker. `PricingRunnerService`
follows that pattern: the HTTP call commits a `queued` run and returns **202**;
`kick()` drains it immediately; an unref'd interval (`PRICING_RUNNER_INTERVAL_MS`,
default 15 s) picks up anything a crashed process left, and a run whose
heartbeat is older than 5 minutes is marked `PRICING_RUN_ABANDONED`. Progress is
written on a separate connection so the console can poll it.

**Idempotency.** Calculate, apply and rollback require `Idempotency-Key`. The
same key + same body returns the same run; the same key + a different body is
`PRICING_IDEMPOTENCY_KEY_REUSED` (409). A second concurrent request with another
key is refused (`PRICING_PLAN_STATE_CONFLICT` / `PRICING_RUN_ACTIVE`): the plan
row lock serialises requests and the partial unique index allows one active run.

**Apply** (one transaction, `lock_timeout = 10s`):

1. lock the plan; re-select the applicable rows; the count must equal the
   `expectedChangeCount` the person confirmed (`PRICING_APPLY_COUNT_MISMATCH`);
2. lock the variants **by ascending id** `FOR UPDATE` — the global order
   checkout, POS and the product editor use, so nothing can deadlock;
3. compare each live variant with its snapshot: price, active/offered,
   unvalued units, weighted average. **Any** difference marks those rows
   `stale`, withdraws the approval, commits that, and writes **no price**
   (`PRICING_PREVIEW_STALE`);
4. otherwise update the prices (price-only UPDATE; the valuation pool guard is
   never involved), insert the history rows, set `APPLIED`, audit — in 500-row
   chunks inside the same transaction. Any error rolls the whole batch back;
5. after commit: invalidate the catalogue caches and publish the advisory
   `availability:invalidated` frame (ids and reason only).

**Rollback** (one transaction): for every change the plan applied and has not
reverted, restore the old price **only if the live price is still the one the
plan wrote**. A later legitimate change (by hand or by another plan) is never
overwritten; it is returned as a conflict. `NULL` prices are restored exactly.

Orders are never touched: `order_items.unit_price`, `total_price` and the cost
snapshots are written at sale time and stay as they were, so historical sales,
COGS and profit reports do not change. Only later sales use the new prices.

---

## 7. Authorization and privacy

The fourth non-delegable class, like sales reports, profit reports and purchase
cost: `@Roles(super_admin)` + `@Audiences('admin')` on the controller, the same
role check repeated in the service, and **no** permission in `PERMISSION_CATALOG`.

| Surface | super_admin | delegated admin (every grant) | cashier / customer / anonymous | super_admin on POS or storefront |
|---|---|---|---|---|
| `/admin/pricing-plans/*` | ✓ | 403 `ROLE_REQUIRED` (generic) | 401 | 401 |

Nothing about a plan appears in public product APIs, the POS catalogue, carts,
quotes, WebSocket frames (ids and a reason only), error bodies or logs (codes and
ids only). `admin_audit_log` is readable with the delegable `audit.read`, so the
`pricing.plan.*` rows carry **ids, counts and field names only** — never a cost,
target, rate or price. Prices live in the super_admin-only history table.

---

## 8. Error codes

| Code | HTTP |
|---|---|
| input codes of §1 | 400 |
| `PRICING_OVERRIDE_INVALID`, `PRICING_OVERRIDE_BELOW_COST`, `PRICING_RATE_INVALID`, `PRICING_BRANCH_NOT_FOUND`, `PRICING_REORDER_INVALID`, `PRICING_IDEMPOTENCY_KEY_REQUIRED` | 400 |
| `PRICING_PLAN_NOT_FOUND`, `PRICING_COST_ENTRY_NOT_FOUND`, `PRICING_ITEM_NOT_FOUND`, `PRICING_RUN_NOT_FOUND`, `PRICING_COPY_SOURCE_NOT_FOUND` | 404 |
| `PRICING_PLAN_NOT_EDITABLE`, `PRICING_PLAN_STATE_CONFLICT`, `PRICING_PLAN_NOT_DELETABLE`, `PRICING_ITEM_BLOCKED`, `PRICING_ITEM_UNCHANGED`, `PRICING_NOTHING_TO_APPLY`, `PRICING_APPLY_COUNT_MISMATCH`, `PRICING_RUN_ACTIVE`, `PRICING_IDEMPOTENCY_KEY_REUSED` | 409 |
| run outcomes: `PRICING_PREVIEW_STALE`, `PRICING_LOCK_TIMEOUT`, `PRICING_RUN_ABANDONED`, `PRICING_RUN_FAILED`, `PRICING_NO_ELIGIBLE_VARIANTS` | stored on the run |

---

## 9. Owner decisions still open

* **P-1** A variant with **no valued stock** (sold out) has no weighted average and
  is blocked (`NO_COST_BASIS`), even if a last purchase price is remembered.
  Alternative: price it from `lastPurchaseUnitCost`, flagged for review.
* **P-2** A manual price below the cost basis is refused. Alternative: allow it
  as an explicit, reviewed loss-leader.
* **P-3** Branch-scoped costs count toward the one global monthly total, because
  prices are global. Branch-level pricing does not exist and is not invented.
* **P-4** `products.basePrice` is left unchanged for simple products; the charged
  price is the default variant's.
* **P-5** Default review rules: any decrease, and any increase above 20 %.

---

## 10. Disposable browser / end-to-end database

Browser and end-to-end journeys for this feature **never** run against the
shared `kazhal_review` database or the shared dev services. `scripts/pricing-e2e/run.sh`
gives each run its own database inside the existing `kazhal-review` PostgreSQL
container (no new Compose project):

```sh
sh scripts/pricing-e2e/run.sh up       # database + migrations + minimal seed + API/Web/POS on 18000/18001/18002
#   … run the browser journey against http://localhost:18001 / 18002 …
sh scripts/pricing-e2e/run.sh status   # what is running (secrets are not printed)
sh scripts/pricing-e2e/run.sh down     # stop those services, drop that database
sh scripts/pricing-e2e/run.test.sh     # the cleanup guards' own tests (stubbed docker; touches nothing)
```

`up`:

1. refuses to start if a run is already recorded, if 18000–18002 are taken,
   or if Redis database 15 is not empty;
2. creates `kazhal_pricing_e2e_<timestamp>_<pid>` and records its name first;
3. runs every migration and `pnpm seed` (roles + a bootstrap owner with a
   random password);
4. starts the API from `apps/api/dist` with `DB_DATABASE` pointed at that
   database, `REDIS_DB=15`, fresh random JWT/OTP secrets and CORS for
   18001/18002;
5. seeds only the journey's records through `seed.mjs`, which reads the owner's
   and cashier's passwords from the mode-600 state file (never from its command
   line, and never prints them): one branch, one cashier,
   one simple product whose 15 opening units are costed through the real
   product API (1 066 666 Rial each, price 1 500 000), and one real POS sale —
   the "old order";
6. builds Web and POS into `.next-pricing-e2e` (`KAZHAL_NEXT_DIST_DIR`, so the
   running dev servers' output is untouched) with
   `NEXT_PUBLIC_API_BASE_URL=http://localhost:18000`, and starts them with the
   workspace's own `pnpm exec next` (nothing is ever downloaded).

`down` reads the state file as data (it is never sourced), stops only the
recorded process trees, drops only a database whose name matches
`^kazhal_pricing_e2e_\d+_\d+$`, and removes the two build directories. It
issues `FLUSHDB` only when the recorded Redis database is present, all decimal
digits, exactly the configured `15` (never `0`) and the recorded container is
the running `kazhal-review-redis`; otherwise it refuses, flushes nothing and
keeps the state file for inspection. The fixture ids and generated credentials
are written to `$PRICING_E2E_STATE_DIR` (default `$TMPDIR/kazhal-pricing-e2e`,
mode 600), never to the repository.

The browser driver itself (Playwright against the installed Chrome) is not a
repository dependency; the journey reads the fixture and credentials from the
state directory. Nothing in this workflow reads or writes product 43,
variant 50, orders 95/96 or any other row of the shared database.

**Shared-database plan 10.** Before this workflow existed, one local browser
verification ran against the shared `kazhal_review` database and left plan 10
(`آزمون مرورگر — اعمال و بازگردانی`, status `ROLLED_BACK`). It applied one
price and rolled it back, so it has no live price effect: the variant's price
is back to its original value. The plan, its runs, price changes and audit
rows are kept on purpose — they are append-only history, and removing them
would mean disabling the triggers that protect it. It is a local
verification record only and does not exist in any other environment.
