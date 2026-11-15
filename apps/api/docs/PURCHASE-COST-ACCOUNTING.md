# Purchase cost, inventory valuation and gross profit

Authoritative contract for purchase-cost accounting. Owned by the lead agent:
**no workstream changes a formula, a column, an error code or a lock rule here
unilaterally.** Everything below is integer Rial.

> **Gross profit is not net profit.** This system does not model operating
> expenses, salaries, rent, taxes, shipping costs, gateway fees or any other
> overhead. Every figure this feature produces is *gross* profit, and is
> labelled so in the API (`grossProfit`) and the UI («سود ناخالص»). Nothing may
> be labelled «سود خالص» / "net profit" until those costs are modelled.

---

## 1. Definitions

```
net sales revenue  = completed sales revenue − revenue reversed by voids/refunds/returns
COGS               = cost of the exact units recognised as sold
                     − COGS reversed for units genuinely returned to inventory
gross profit       = net sales revenue − COGS
gross margin %     = gross profit / net sales revenue × 100
                     (null when net sales revenue ≤ 0 — never Infinity, NaN or an invented 0)
```

"Completed sales revenue" keeps the existing order semantics exactly
(`ReportsService.ELIGIBLE_SALE_STATUSES` + voided-after-payment, dated by
`COALESCE(paidAt, soldAt)`). This feature does not redefine a sale.

---

## 2. Audited before-state (commit `3529d4e`)

| Concern | Where | Fact |
|---|---|---|
| Sellable unit | `product_variants` | The only sellable unit. A simple product has exactly one `isDefault` variant (0012). |
| Physical stock | `product_variants.stock` int | Changed only by `InventoryService.{decrement,increment}Stock` (conditional UPDATE, R2). **No `CHECK (stock >= 0)` existed.** |
| Ledger | `stock_movements` | Append-only; one row per (order, variant) for sales and restores; reasons `pos_sale`, `online_fulfillment`, `cancellation_restore`, `return_restore`, `manual_adjustment`, `initial_stock`. No cost columns. |
| Simple product opening stock | `ProductsService.create` → `recordInitialStock` | Ledgered (`initial_stock`), same transaction. |
| **Variant product opening stock** | `ProductsService.create` (`stock: variant.stock`) and `applyVariantContract` (PATCH creating a variant) | **Written straight onto the INSERT with no movement.** Closed by this feature. |
| Stock adjust | `POST /admin/inventory/variants/:id/adjust`, `POST /products/variants/:id/stock/adjust` → `InventoryService.adjustStock` | `set`/`delta`, either sign, `inventory.adjust`, writes `manual_adjustment`. |
| POS sale | `OrdersService.recordPosSale` | One tx: lock variants ASC → gates → order (PAID, FULFILLED, `paidAt = soldAt`) → `order_items` → `consumeForPosSale` → payment row → idempotency completion. |
| Web checkout | `OrdersService.create` | Order PENDING, `order_items` written, basket holds → ORDER allocations. **No stock moves.** |
| Web payment | `PaymentService` | Sets PAID + `paidAt`; **revenue is recognised here.** |
| Web fulfilment | `FulfilmentService.drive` → `consumeForOnlineFulfilment` | Order row `FOR UPDATE SKIP LOCKED`; idempotent by "an `online_fulfillment` movement exists for this order"; `AWAITING_STOCK` on shortfall; recovery worker re-drives the same method. |
| Line price snapshot | `order_items.unit_price/total_price` | Immutable; `orders.total_price = subtotal = Σ line totals` on every current write path (the discount code is stored, never applied). |
| Void | `OrdersService.reverseOrder('void')` | Whole order only. `restoreForOrder` (net ledger per variant), status CANCELED, `voidedAt`, payment → refunded. |
| Return | `reverseOrder('return')` | Whole order only. Restore, status REFUNDED, `refundedAt`. |
| External refund | `ReconciliationService.confirmExternalRefund` | Whole order; if the refunded receipt settled the order it **always** restores consumed stock and sets REFUNDED. |
| Partial return / refund without return / return without refund | — | **Did not exist.** |
| Reports | `ReportsService`, `DashboardService.financial` | super_admin role (not a permission), admin audience, order-level money, `profit: NOT REPORTED`. |
| Audit log | `admin_audit_log` | Readable with `audit.read`, **which is delegable** — so it must never carry cost figures. |

### 2.1 State-transition table

"Consumed" means a negative `stock_movements` row exists for (order, variant).

| Event | Revenue | Physical stock | COGS | Inventory value |
|---|---|---|---|---|
| POS sale | + line totals at `paidAt` (= `soldAt`) | − q, same tx | **recognised** in the same tx, under the same variant lock | − allocated COGS |
| Web checkout (PENDING) | none | none (allocation only) | none — line `pending` | none |
| Web payment confirmed | + line totals at `paidAt` | none yet | still `pending` (profit unavailable) | none |
| Web fulfilment | none (already recognised) | − q | **recognised**, same tx as the decrement | − allocated COGS |
| Fulfilment retry / recovery | none | none (idempotent marker) | none — marker + `costStatus <> 'pending'` trigger | none |
| Void before consumption | reversed if it was paid, else none | none | none | none |
| Void after consumption | reversed (`voidedAt`) | + consumed q | **reversed** — the exact original allocation | + exact original COGS |
| Whole-order return / external refund of a consumed order | reversed (`refundedAt`) | + q | **reversed** exactly | + exact original COGS |
| Line return with refund (new) | reversed for the returned q only | + q | reversed deterministically from the line's own COGS | + that amount |
| Line refund without return (new) | reversed for q | none | **not** reversed — visible economic loss | none |
| Line return without refund (new) | none | + q | reversed from the line's own COGS | + that amount |
| Stock receipt (new) | none | + q | none | + q × unit cost |
| Negative correction / legacy negative adjust | none | − q | **never sales COGS** — reported as inventory loss | − proportional amount |
| Positive correction (new) | none | + q | none | + q × explicit unit cost, or units recorded **unvalued** by explicit choice |
| Legacy valuation initialisation (new) | none | none | none | + entered value; unvalued units → valued |

---

## 3. The valuation pool (per variant)

Cost belongs to a **sellable variant**. A simple product's cost lives on its
default variant; every option variant has its own.

```
stock               int     physical units (existing column)
unvaluedQuantity    int     units whose purchase cost is NOT known (legacy stock,
                            explicit unknown-cost corrections, returns of unknown-cost units)
valuedQuantity      =  stock − unvaluedQuantity           (derived, never stored)
inventoryCostValue  bigint  Rial value of the VALUED units — exact, never a rounded average
lastPurchaseUnitCost bigint NULL  last receipt's unit cost, or the remembered default; display/prefill only
costStatus          'valued' | 'unvalued'   generated: unvaluedQuantity = 0 ? valued : unvalued
```

Enforced by CHECK constraints (the database refuses what the service must never write):

```
stock ≥ 0
0 ≤ unvaluedQuantity ≤ stock
inventoryCostValue ≥ 0
valuedQuantity = 0  ⇒  inventoryCostValue = 0          (so stock = 0 ⇒ value = 0)
lastPurchaseUnitCost IS NULL OR lastPurchaseUnitCost ≥ 0
```

Unknown cost is **never** zero. `unvaluedQuantity` is how "we do not know what
these units cost" is represented; `inventoryCostValue` only ever describes units
whose cost is known, and an explicit zero-cost receipt is a known cost of 0.

### 3.1 Operations — the one pure module

`src/modules/inventory/valuation/valuation.ts` implements every operation as a
pure function over `{ stock, unvaluedQuantity, value: bigint }`. It is the only
place cost arithmetic happens; SQL only stores its result.

**Allocation** (the single rounding rule used everywhere):

```
allocate(poolValue, poolUnits, takeUnits):
  takeUnits == poolUnits  →  poolValue                      (the whole remainder)
  otherwise               →  floor(poolValue × takeUnits / poolUnits)   (BigInt)
```

Consequences, all asserted by unit tests: no Rial is created or lost
(`allocated + remaining = before`); selling every remaining unit consumes the
entire remaining value; the remaining pool never goes negative; the remainder of
every floor stays in the pool and is carried to the next sale, so it is never
lost — the last unit out takes it.

| Operation | Effect |
|---|---|
| `receive(q, c)` | `stock += q`, `value += q × c` |
| `receiveUnvalued(q)` | `stock += q`, `unvalued += q` (explicit unknown-cost correction only) |
| `consume(q)` | `u = min(q, unvalued)` (**unknown-cost units leave first**), `k = q − u`, `cogs = allocate(value, valued, k)`; `stock −= q`, `unvalued −= u`, `value −= cogs` → returns `{ knownQuantity: k, unknownQuantity: u, cogs }` |
| `restore(k, cost, u)` | `stock += k + u`, `value += cost`, `unvalued += u` |
| `initialise(v)` | requires `unvalued > 0`; `value += v`, `unvalued = 0` |

**Moving weighted average** is never stored. It is derived for display only:
`averageUnitCost = floor(value / valuedQuantity)` (null when `valuedQuantity = 0`).
Worked example:

```
receive 3 @ 10 000       pool: 3 units, 30 000
receive 2 @ 13 001       pool: 5 units, 56 002        average ⌊56 002/5⌋ = 11 200
sell 2                   cogs = ⌊56 002 × 2 / 5⌋ = 22 400   pool: 3 units, 33 602
sell 1                   cogs = ⌊33 602 × 1 / 3⌋ = 11 200   pool: 2 units, 22 402
sell 2 (all)             cogs = 22 402 (whole remainder)    pool: 0 units, 0
Σ cogs = 22 400 + 11 200 + 22 402 = 56 002 = Σ receipts ✓
```

### 3.2 Why "unknown-cost units leave first"

A variant can hold legacy stock of unknown cost and newly received stock of
known cost at the same time. When a sale takes units, the system must decide
which. It takes the **unknown-cost units first**: they are the older units on
the shelf, draining them first ends the unknown state soonest, and it can only
ever *understate* reported profit coverage — it can never attach a known cost to
a unit whose cost was unknown. A returned mixed line gives back its
unknown-cost units first, by the same rule. (Owner decision B-1 below.)

### 3.3 Overflow

`MAX_STOCK_UNITS × MAX_RIAL ≈ 4.8 × 10¹⁹` exceeds PostgreSQL `bigint`
(9.22 × 10¹⁸). Every pool result is therefore checked in BigInt against
`INT8_MAX` before it is written; exceeding it is a 400
`PURCHASE_COST_OUT_OF_RANGE`, never a 22003 → 500. Cost columns are read as
strings (`rialStringTransformer`) and never pass through a JavaScript `number`.

---

## 4. Order-line cost snapshots

`order_items` gains:

| Column | Meaning |
|---|---|
| `costStatus` | `pending` (stock not yet consumed) · `known` (every unit valued) · `unknown` (≥1 unit of unknown cost, or legacy) |
| `cogsTotal` bigint NULL | **Authoritative** COGS of the *known* units. NULL while pending and for legacy lines. |
| `costKnownQuantity`, `costUnknownQuantity` int NULL | How the line's quantity split at consumption. |
| `costAllocatedAt` timestamptz NULL | When COGS was recognised. NULL for pending and legacy. |

`unit_price`, `total_price`, `productCodeSnapshot`, `variantCodeSnapshot` and
`quantity` already exist and are already immutable.

A trigger (`trg_order_items_cost_snapshot_immutable`) refuses any change to the
four cost columns once `costStatus <> 'pending'`, and refuses a transition out of
`pending` that is not to a complete `known`/`unknown` shape. Allocating twice is
therefore a database error, not a convention.

A display unit cost (`floor(cogsTotal / costKnownQuantity)`) may be shown; it
never replaces `cogsTotal`.

### 4.1 Where COGS is recognised

Inside `InventoryService.consumeForPosSale` and `consumeForOnlineFulfilment` —
the **same two methods** that decrement stock, in the **same transaction**, under
the **same variant row lock**, written by one shared helper
(`allocateOrderLineCosts`). For each variant (ascending id) the order's lines of
that variant are consumed from the pool **in ascending `order_items.id`**,
sequentially, and the variant row is written once with a compare-and-set:

```sql
UPDATE product_variants
   SET stock = $newStock, "unvaluedQuantity" = $newUnvalued, "inventoryCostValue" = $newValue
 WHERE id = $id AND stock = $oldStock AND "unvaluedQuantity" = $oldUnvalued
   AND "inventoryCostValue" = $oldValue AND stock >= $q
RETURNING stock
```

The row is already held `FOR UPDATE` by `lockVariants`, so the CAS cannot lose;
if it ever affects ≠ 1 row the transaction aborts with
`COST_ALLOCATION_INVARIANT_VIOLATION`. This is R2 extended to cost ("R2c").

Idempotency is structural and inherited: a POS retry replays the stored
response and never reaches `consumeForPosSale`; a fulfilment retry or recovery
pass finds the `online_fulfillment` marker under the order lock and returns
`alreadyFulfilled`; and a stray second allocation hits the immutability trigger.

---

## 5. Reversals — `order_item_adjustments`

Append-only (trigger-enforced), one row per (event, order line):

| Column | Meaning |
|---|---|
| `orderId`, `orderItemId` | the line |
| `kind` | `void` · `return_refund` · `refund_only` · `return_only` |
| `scope` | `order` (written by a whole-order void/return/refund) · `line` (the new line endpoint) · `legacy` (migration backfill) |
| `revenueQuantity`, `revenueReversed` | units whose revenue is reversed, and the Rial amount |
| `restockedKnownQuantity`, `restockedUnknownQuantity` | units physically returned, split by cost knowledge |
| `cogsReversed` bigint NULL | exact known COGS put back into the pool; NULL only for `legacy` rows |
| `eventAt` timestamptz NULL | reporting date; NULL only for legacy refunds whose date migration 0009 could not recover |
| `actorUserId`, `actorDisplaySnapshot`, `reason`, `idempotencyKey`, `stockMovementId`, `createdAt` | attribution and evidence |

**Revenue reversed for r units** = `allocate(line.total_price − alreadyReversedRevenue, line.quantity − alreadyReversedQuantity, r)`.

**COGS reversed for r restocked units** (unknown-cost units first):
```
ru = min(r, costUnknownQuantity − alreadyRestockedUnknown)
rk = r − ru
cogsBack = allocate(cogsTotal − alreadyReversedCogs, costKnownQuantity − alreadyRestockedKnown, rk)
pool.restore(rk, cogsBack, ru)
```
Never the current average. Never more than was recognised: cumulative
`revenueQuantity ≤ quantity`, cumulative restocked `≤ quantity`, cumulative
`cogsReversed ≤ cogsTotal` — asserted under the order row lock and re-asserted
by a trigger.

### 5.1 Coexistence with whole-order reversals

* Whole-order void / return / external refund keep their current behaviour and
  status semantics, and additionally write `scope = 'order'` rows for every line
  (restoring cost through the same `restore` path).
* A line adjustment never changes `orders.status`, `voidedAt` or `refundedAt`.
* **Once an order has any `line` adjustment, whole-order void/return/refund is
  refused** (409 `ORDER_HAS_LINE_ADJUSTMENTS`); the remaining units are reversed
  with the line endpoint. Conversely the line endpoint refuses a canceled,
  voided, refunded or never-paid order (409 `ORDER_NOT_ADJUSTABLE`), and a line
  that was never consumed (409 `ORDER_LINE_NOT_FULFILLED`) — an unfulfilled web
  order is cancelled, not partially refunded.
* The existing sales summary and dashboard stay order-level and add
  `lineRefundedTotal` (Σ `scope='line'` `revenueReversed` in range), subtracted
  in `netSales`. Because of the refusal above no sale is ever counted twice.

---

## 6. Stock entering and leaving outside a sale

| Operation | Endpoint | Rule |
|---|---|---|
| Initial stock, simple | `POST /products` `initialStock` + `purchasePrice` | `purchasePrice` required when `initialStock > 0`; movement `initial_stock` with cost evidence; one transaction with the product. |
| Initial stock, variants | `POST /products` `variants[].stock` + `variants[].purchasePrice`; `PATCH /products/:id` creating a variant | Same, per variant. Stock is **no longer written onto the INSERT**. |
| Zero stock + price | same | Stores `lastPurchaseUnitCost` only. No value, no movement. |
| Receipt | `POST /admin/costing/variants/:id/receipts` | `quantity > 0`, `unitCost`, optional `supplierReference` (≤120) and `note` (≤500), `Idempotency-Key`. Movement `stock_receipt`. |
| Correction | `POST /admin/costing/variants/:id/corrections` | `quantityDelta ≠ 0`, `reason` (4..500), `Idempotency-Key`, `allowBelowReserved`. Positive: exactly one of `unitCost` or `costUnknown: true`. Negative: neither; cost removed = `consume` allocation, reported as inventory loss. Movement `inventory_correction`. |
| Legacy valuation | `POST /admin/costing/variants/:id/valuation` | exactly one of `unitCost` / `totalValue`, `expectedUnvaluedQuantity` must equal the current count (409 `INVENTORY_VALUATION_STALE`), `Idempotency-Key`. Movement `valuation_initialization` with `delta = 0` (the only reason allowed a zero delta). 409 `INVENTORY_ALREADY_VALUED` when nothing is unvalued. |
| Remembered price | `PUT /admin/costing/variants/:id/purchase-price` | Sets `lastPurchaseUnitCost` only. Audited. Never changes value. |
| Legacy adjust (both routes) | unchanged URLs | A resulting **increase** is refused 409 `STOCK_INCREASE_REQUIRES_RECEIPT`. A decrease is a negative correction (cost removed proportionally), still recorded as `manual_adjustment`. |

`PATCH /products/:id` can change neither stock nor cost.

### 6.1 Movement cost evidence

`stock_movements` gains `unitCost`, `costDelta` (signed pool value change),
`inventoryValueAfter`, `unvaluedQuantityDelta`, `unvaluedQuantityAfter`,
`supplierReference`. All NULL on legacy rows; all of `costDelta`,
`inventoryValueAfter`, `unvaluedQuantityAfter` present (together) on every row
written after 0037. For every variant created after 0037,
`Σ costDelta = inventoryCostValue` (tested).

---

## 7. Locks

Unchanged global order: **idempotency key → orders → product_variants (ASC id)
→ stock_reservations → cart_items**. New writes fit into it without a new lock:

* `order_items` cost columns and `order_item_adjustments` are written only while
  the parent `orders` row is locked by the same transaction.
* Costing endpoints take the idempotency key, then the single variant row via
  `lockVariants`.
* `allocateOrderLineCosts` runs after `lockVariants` in both consume paths.

---

## 8. Authorization

Cost is **super_admin only, by role, not by a delegable permission** — the same
rule the reports use. (Owner decision B-2: a delegable
`inventory.cost.manage` is possible later; it is deliberately not created now.)

| Surface | super_admin | delegated admin (any grants) | cashier | customer / anonymous |
|---|---|---|---|---|
| `/admin/costing/*` | ✓ | 403 | 403 | 401/403 |
| `/reports/profit/*` | ✓ | 403 | 403 | 401/403 |
| `POST /admin/orders/:id/line-adjustments` | ✓ | 403 | 403 | 401/403 |
| `purchasePrice` on `POST/PATCH /products` | ✓ | 403 `PURCHASE_COST_FORBIDDEN` | — | — |
| Product, inventory, movement, order, receipt, catalogue, cart, quote, WebSocket payloads | no cost fields | no cost fields | no cost fields | no cost fields |
| `admin_audit_log` summaries | quantities and ids only — **never Rial cost** (audit.read is delegable) | | | |

Every cost route is admin-audience only and repeats the role check in its
service (defence in depth, like `ReportsService.assertReportViewer`).

---

## 9. Reporting — `/reports/profit/*`

Line-based, super_admin, Asia/Tehran inclusive local days. Filters:
`from`, `to`, `channel`, `branchId`, `cashierUserId`, `productId`, `variantId`,
`categoryId`.

* **Sale events**: eligible-sale lines whose order revenue date is in range →
  gross revenue, units sold, and (for `known` lines) `cogsTotal`.
  **COGS is matched to the revenue period of its line**, even when a web order is
  fulfilled days after payment; until then the line is `pending` and its revenue
  is reported as profit-unavailable.
* **Reversal events**: `order_item_adjustments` whose `eventAt` is in range.
* **Inventory losses**: negative `inventory_correction` / `manual_adjustment`
  movements with cost evidence in range — reported separately, never COGS.

```
grossSalesRevenue, revenueReversed (void | refund split), netSalesRevenue
knownCost:   netRevenue, cogs, cogsReversed, netCogs, grossProfit, grossMarginPercent
unknownCost: netRevenue, pendingFulfilmentRevenue, unvaluedOrLegacyRevenue, lineCount
coveragePercent = known gross revenue / gross revenue × 100     (null when gross = 0)
```

Percentages are strings with two decimals, computed in BigInt, half away from
zero. A row with any unknown-cost revenue carries `costCoverage: 'partial' |
'none'` and the message «اطلاعات قیمت خرید این فروش ناقص است؛ سود قابل محاسبه
نیست.»; breakdowns sort complete rows first, then partial, then none, so an
unknown-cost product is never ranked as highly profitable.

---

## 10. Legacy data (migration 0037)

* Variants with `stock = 0`: `unvaluedQuantity = 0`, value `0` — the value of
  zero units is a proven fact, not an invention.
* Variants with `stock > 0`: `unvaluedQuantity = stock`, value `0` → `unvalued`.
* Existing order lines: `unknown` where a consumption movement exists for their
  (order, variant); otherwise `pending` (a paid web order still awaiting stock is
  valued normally when it is fulfilled).
* Existing voided-after-payment and refunded orders: one `legacy` adjustment row
  per line (`revenueReversed = total_price`, restocked and COGS NULL).
* Nothing is backfilled with zero. The migration refuses to run on negative
  stock rather than guessing.

---

## 11. Stable error codes

| Code | HTTP |
|---|---|
| `PURCHASE_COST_REQUIRED`, `INITIAL_STOCK_REQUIRES_PURCHASE_COST` | 400 |
| `PURCHASE_COST_INVALID`, `PURCHASE_COST_OUT_OF_RANGE` | 400 |
| `PURCHASE_COST_FORBIDDEN` | 403 |
| `PURCHASE_COST_NOT_UPDATABLE` (cost on an existing variant in a product PATCH) | 400 |
| `INVENTORY_COST_UNVALUED`, `INVENTORY_ALREADY_VALUED`, `INVENTORY_VALUATION_STALE` | 409 |
| `STOCK_INCREASE_REQUIRES_RECEIPT` | 409 |
| `STOCK_RECEIPT_IDEMPOTENCY_CONFLICT` | 409 (same key, different body) |
| `ORDER_HAS_LINE_ADJUSTMENTS`, `ORDER_NOT_ADJUSTABLE`, `ORDER_LINE_NOT_FULFILLED`, `ADJUSTMENT_EXCEEDS_LINE` | 409 |
| `COST_ALLOCATION_INVARIANT_VIOLATION` | 500 (a genuine invariant breach — must be unreachable) |

---

## 12. Owner decisions still open

* **B-1** Unknown-cost units leave first (§3.2). Alternative: known first.
* **B-2** Cost is super_admin-only; no delegable cost permission yet.
* **B-3** Unvalued legacy stock remains sellable; its profit is reported as
  unknown. Alternative: block sales until valued.
* **B-4** Positive corrections may be recorded as explicitly *unvalued*.
  Alternative: require a unit cost always.
* **B-5** COGS is matched to the line's revenue period (§9).

---

## 13. API contracts

All money is an integer-Rial **string** in responses (`"125000"`). Input money
(`unitCost`, `totalValue`, `purchasePrice`) is a JSON integer or a base-10
integer string. Percentages are strings with two decimals, or `null`. Every
route below is `@Audiences('admin')` + `@Roles(super_admin)`, and every
mutation requires an `Idempotency-Key` header (same shape rule as POS: 8..200
chars `[A-Za-z0-9._:-]`). Same key + same body replays the stored response;
same key + different body is 409 — `STOCK_RECEIPT_IDEMPOTENCY_CONFLICT` on
receipts, `IDEMPOTENCY_KEY_REUSED` (in `error`) on the others.

```
PoolView = { stock, unvaluedQuantity, valuedQuantity,            // numbers
             inventoryCostValue, averageUnitCost | null,          // strings
             costStatus: 'valued' | 'unvalued' }
```

**`GET /admin/costing/variants/:variantId`** → `{ variantId, productId,
productTitle, productCode, variantCode, sku, isDefault, isActive,
sellingPrice, lastPurchaseUnitCost | null, ...PoolView, recentMovements: [{ id,
reason, delta, balanceAfter, unitCost|null, costDelta|null,
inventoryValueAfter|null, unvaluedQuantityAfter|null, supplierReference|null,
reasonText|null, orderId|null, actorDisplaySnapshot|null, createdAt }] }`
(latest 20, newest first).

**`GET /admin/costing/products/:productId`** → `{ productId, productTitle,
productCode, variants: [the variant view without recentMovements], totals: {
stock, unvaluedQuantity, inventoryCostValue } }`.

**`GET /admin/costing/unvalued?page&limit`** → paginated variants with
`unvaluedQuantity > 0` (the legacy-valuation work list).

**`POST /admin/costing/variants/:variantId/receipts`** body `{ quantity
(1..MAX_STOCK_UNITS), unitCost, supplierReference? (≤120), note? (≤500) }` →
201 `{ movementId, variantId, quantity, unitCost, incomingValue, before:
PoolView, after: PoolView }`.

**`POST /admin/costing/variants/:variantId/corrections`** body `{ quantityDelta
(≠0, |x| ≤ MAX_STOCK_UNITS), reason (4..500), unitCost?, costUnknown?: true,
allowBelowReserved?: boolean }` → 201 `{ movementId, variantId, quantityDelta,
costPolicy: 'valued' | 'unvalued' | 'removed', costRemoved | null, before,
after }`. Positive: exactly one of `unitCost` / `costUnknown`. Negative: neither.

**`POST /admin/costing/variants/:variantId/valuation`** body `{
expectedUnvaluedQuantity, unitCost? | totalValue?, note? }` (exactly one of the
two) → 201 `{ movementId, variantId, valuedUnits, totalValue, before, after }`.

**`PUT /admin/costing/variants/:variantId/purchase-price`** body `{ unitCost |
null }` → 200 `{ variantId, lastPurchaseUnitCost | null }`.

**`POST /admin/orders/:orderId/line-adjustments`** body `{ kind:
'return_refund' | 'refund_only' | 'return_only', reason (4..500), lines: [{
orderItemId, quantity ≥ 1 }] (1..200, unique) }` → 201 `{ orderId, kind,
adjustments: [{ id, orderItemId, revenueQuantity, revenueReversed,
restockedKnownQuantity, restockedUnknownQuantity, cogsReversed }], totals: {
revenueReversed, cogsReversed, unitsRestocked } }`.

**`GET /reports/profit/summary`** — filters `from, to, channel, branchId,
cashierUserId, productId, variantId, categoryId` →
```
{ timezone, range: { from, to, startUtc, endUtc }, filters,
  totals: {
    grossSalesRevenue, revenueReversed, voidedRevenue, refundedRevenue, netSalesRevenue,
    unitsSold, unitsReturned, unitsRefundedWithoutReturn,
    knownCost:   { grossRevenue, revenueReversed, netRevenue, cogs, cogsReversed,
                   netCogs, grossProfit, grossMarginPercent, lineCount },
    unknownCost: { grossRevenue, revenueReversed, netRevenue,
                   pendingFulfilmentRevenue, unvaluedRevenue, lineCount },
    coveragePercent,
    inventoryLosses: { units, knownCostRemoved, unknownCostUnits } },
  semantics }
```

**`GET /reports/profit/breakdown?groupBy=day|branch|channel|cashier|product|variant|category`**
(+ the same filters, `page`, `limit`) → `{ ..., data: [{ key, label,
grossSalesRevenue, revenueReversed, netSalesRevenue, unitsSold, unitsReturned,
knownNetRevenue, unknownNetRevenue, netCogs, grossProfit | null,
grossMarginPercent | null, coveragePercent, costCoverage:
'complete'|'partial'|'none', warning | null }] }`. `grossProfit` is null when
coverage is `none`.

**`GET /reports/profit/orders`** (filters, `page`, `limit`) → per-order rows
with the same money fields as a breakdown row plus `orderId, orderNumber,
channel, branchNameSnapshot, cashierDisplaySnapshot, revenueAt`.

**`GET /reports/profit/orders/:orderId`** → `{ order header, lines: [{
orderItemId, productTitle, productCode, variantCode, variantId, quantity,
unitPrice, totalPrice, costStatus, cogsTotal | null, unitCostDisplay | null,
costKnownQuantity | null, costUnknownQuantity | null, remaining: {
revenueUnits, restockUnits }, adjustments: [...] }], totals }` — also what the
Admin line-adjustment form reads.
