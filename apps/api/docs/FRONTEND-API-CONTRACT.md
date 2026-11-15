# Kazhal — Frontend API Contract

Audited against branch `Hamid` @ `6d009d5`, which fast-forwards onto `develop`
(`git rev-list --count Hamid..develop` = 0), so this is the post-merge state.

**How the role column was produced.** Not by reading decorators. The app was
booted and every controller method was walked through `ModulesContainer`, with
roles resolved by `Reflector.getAllAndOverride(ROLES_KEY, [handler, class])` —
the same call the guard makes. The generated OpenAPI document was diffed against
the live router: **81 routes, 81 OpenAPI operations, zero missing, zero extra.**

> **One caveat on that, verified and currently harmless.** `RolesGuard` actually
> resolves `[getClass(), getHandler()]` — **class first**
> (`roles.guard.ts:17-20`), the opposite order to `JwtAuthGuard`
> (`jwt-auth.guard.ts:31-34`) and to Nest's convention. A class-level `@Roles`
> therefore **overrides** a handler-level one. I checked every controller: none
> currently declares both, so the two orderings agree and this table is correct
> today. The first handler-level `@Roles` added to a class that already has one
> — exactly what frontend-driven work tends to add — will be **silently
> ignored**. See §9 F-1.

---

## 1. Wire format — read this before anything else

### Success envelope (`response-format.interceptor.ts:28-46`)

```ts
isPlainObject(data) ? { ...envelope, ...data }      // SPREAD
                    : { ...envelope, data: data ?? null }
envelope = { success: true, timeStamp: <ISO> }
```

**A handler returning a plain object is spread into the envelope, not nested.**
So a handler returning `{ data: x, total: 9 }` produces
`{ success, timeStamp, data: x, total: 9 }`, while a handler returning an
**array** produces `{ success, timeStamp, data: [...] }`. Both shapes exist in
this API. Per-route shapes are given below; do not assume `data`.

Note the capital **S** in `timeStamp` on success — errors use lowercase
`timestamp`.

### Error envelope (`global.exception.ts:96-121`)

```jsonc
{ "success": false, "statusCode": 409, "message": "…",
  "error": "checkout_quote_stale",   // ONLY if the thrower set a string `error`
  "details": { /* every OTHER key the thrower supplied */ },
  "timestamp": "…", "path": "/orders" }
```

**Machine-readable codes live in two different places.** The checkout path sets
both `error` and `code`, so the code is at the top level. The POS idempotency
helper and the insufficient-stock path set only `code` (or nothing), so their
codes arrive at **`details.code`** and top-level `error` is Nest's generic
reason phrase (`"Conflict"`, `"Bad Request"`).

**Always read `body.error ?? body.details?.code`.** See §9 F-2.

A validation failure is a **400** whose `message` is a **string array**.
`ValidationPipe` runs with `forbidNonWhitelisted: true` (`main.ts:28-34`), so
**any unknown body or query key is a 400** — never send speculative fields.

### Other global facts

- **No route prefix.** `main.ts` never calls `setGlobalPrefix`. Paths are as written.
- **`@Post` without `@HttpCode` returns 201**, including `/auth/{audience}/login`, `/auth/{audience}/refresh`, `/cart`, `/payment/start` and `/payment/verify`. Only `/orders/quote`, `/auth/{audience}/logout`, `/auth/{audience}/logout-all`, `/auth/{audience}/change-password` and the admin POSTs are 200.
- **Money is INTEGER RIAL everywhere.** No minor units, no Toman, no decimals. Divide by 10 only at the point of display, and **never append or remove a zero** to convert between the two.

  **AGGREGATE money is a base-10 STRING; per-item catalogue money is still a number.**

  | Where | Type | Why |
  |---|---|---|
  | `/admin/dashboard/financial`, `/reports/sales*`, `/payment/admin/reconciliation*`, `/orders` admin projections | `string` | `bigint` columns and `SUM()`s over them. node-postgres returns them as strings so the driver never rounds, and the API no longer converts them back. |
  | catalogue prices, basket lines, checkout quotes, POS sale responses | `number` | bounded by what one product costs; a person typed them. |

  A JSON number is exact only to 2^53 − 1 = 9 007 199 254 740 991 Rial, and a year
  of turnover at these prices is already in the 10^12 range. `netSales`, being a
  subtraction of two such values, goes wrong **before either operand does** —
  which is why the subtraction is performed in `BigInt` on the server and the
  result is serialised as a string.

  **Do not `Number()` a string amount and do not `+` two of them** (`"a" + "b"`
  concatenates). Render with `formatRialString` / `<Money>` from `@kazhal/ui`,
  which groups the digit string without parsing it, and add with
  `addRialStrings`, which is `BigInt` arithmetic. Counts and unit quantities stay
  JSON numbers: they are bounded by the number of rows and were never at risk.
- **Auth is an httpOnly cookie, never a bearer header** (`jwt.strategy.ts:31-33`). Every call needs `credentials: 'include'`.

---

## 2. Endpoint matrix

Legend — **Idem**: `REQ` = `Idempotency-Key` required, `—` = header not read.
**RT**: realtime events emitted. Screens: `store` = apps/store (customer),
`web` = apps/web (admin + POS).

### 2.1 Session & authentication

| Method | Path | Role | Request | Success | Errors | Idem | RT | Screen |
|---|---|---|---|---|---|---|---|---|
**There is no shared `/auth/login`, `/auth/me`, `/auth/refresh-token` or
`/auth/logout` any more.** A session belongs to exactly one **audience** —
`storefront`, `admin` or `pos` — carried in a signed `aud` claim, in the
`refresh_tokens.audience` column, and in a per-audience cookie pair
(`kz_storefront_*`, `kz_admin_*`, `kz_pos_*`). Every route below is mounted once
per audience under `/auth/{audience}/…` from a single generated class
(`controllers/surface-auth.controller.ts`, registered in `auth.module.ts`), so
the three cannot drift. A token minted for one audience is refused by the other
two. Full model: `docs/AUTH-AUDIENCES.md`.

`{audience}` below is literally one of `storefront` | `admin` | `pos`.

| Method | Path | Role | Request | Success | Errors | Idem | RT | Screen |
|---|---|---|---|---|---|---|---|---|
| GET | `/auth/{audience}/me` | any auth **of that audience** | — | 200 `{data:{userId,identifier,roles[],branchId,audience,permissions[],mustChangePassword}}` | 401 signed out / invalidated | — | — | store: header (`storefront`) · web: shell (`admin`), POS till header (`pos`) |
| POST | `/auth/storefront/send-otp` | PUBLIC | `{mobile}` — normalized, many spellings accepted | 201 `{message}` (identical whether or not the number is registered) | 400 · **429** `OTP_COOLDOWN` / `OTP_SEND_RATE_LIMITED` + `details.retryAfterSeconds` | — | — | store: OTP step 1 |
| POST | `/auth/storefront/verify-otp` | PUBLIC | `{mobile,code:4–6}` | 201 `{message}` + the storefront cookie pair; **creates the account on first success** | 400 · **401 `OTP_INVALID`** for no-challenge / wrong / expired / exhausted / replay (one identical body) · 401 `ACCOUNT_DEACTIVATED` | — | — | store: OTP step 2 |
| POST | `/auth/admin/login` | PUBLIC | `{username:3–30,password:8–64}` | 201 `{message}` + `kz_admin_*` cookies | 400 · 401 bad credentials · 401 deactivated · **401 `AUDIENCE_NOT_PERMITTED`** (lacks `admin.access`; no cookies issued) | — | — | web: admin console login |
| POST | `/auth/pos/login` | PUBLIC | `{username:3–30,password:8–64}` | 201 `{message}` + `kz_pos_*` cookies | 400 · 401 bad credentials · 401 deactivated · **401 `AUDIENCE_NOT_PERMITTED`** (lacks `pos.access`; no cookies issued) | — | — | web: POS till login |
| POST | `/auth/storefront/review-login` | PUBLIC, **review builds only** | `{username:3–30,password:8–64}` | 201 `{message}` + `kz_storefront_*` cookies | **403 unless `NODE_ENV !== 'production'` and `KAZHAL_ENABLE_REVIEW_LOGIN=true`** · 400 · 401 | — | — | store: reviewer sign-in (production door is OTP) |
| POST | `/auth/{audience}/refresh` | PUBLIC | — (reads only that audience's refresh cookie) | 201 `{message}` + that audience's cookie pair re-set | 401 (5 distinct messages) | — | — | all three: silent refresh |
| POST | `/auth/{audience}/logout` | PUBLIC | — | 200 `{message,revoked}` + that audience's cookies cleared | never errors | — | — | all three: sign out (this surface only) |
| POST | `/auth/{audience}/logout-all` | any auth | — | 200 `{message,revoked}` — revokes **every** audience on every device | 401 | — | — | store: security · web: security |
| POST | `/auth/{audience}/change-password` | any auth | `{currentPassword,newPassword}` | 200 `{message}`; kills every session incl. the caller's | 400 · 401 wrong current password | — | — | all three: forced/voluntary password change |
| POST | `/auth/register` | super_admin | `RegisterDto` | 201 | 400 · 403 | — | — | web: staff admin |
| POST | `/auth/users/:userId/revoke-sessions` | super_admin | — | 200 | 403 · 404 | — | — | web: staff admin |

### 2.2 Catalog (public storefront)

| Method | Path | Role | Request | Success | Errors | Idem | RT | Screen |
|---|---|---|---|---|---|---|---|---|
| GET | `/products` | PUBLIC | `page,limit,search,categoryId,minPrice,maxPrice,inStockOnly,sort` | 200 `{data[],total,page,limit,totalPages}` **top level** | 400 `minPrice>maxPrice` | — | listens `stock:updated` | store: product list, search, category |
| GET | `/products/:id` | PUBLIC | `id` int | 200 `{data:PublicProductView}` | 400 · 404 | — | — | store: product detail |
| GET | `/categories` | PUBLIC | — | 200 `{data:[{id,title,productCount}]}` | — | — | — | store: nav · web: product editor |
| GET | `/attributes` | PUBLIC | — | 200 `{data[]}` | — | — | — | store: facets · web: variant editor |
| GET | `/attributes/:id` | PUBLIC | `id` int | 200 `{data}` | 404 | — | — | web: variant editor |
| POST | `/products/bookmark` | any auth | `{productId}` | 201 `{message,data:{bookmarked}}` | 401 · 404 | — | — | store: wishlist toggle |

Public views never expose `stock` — only `inStock` and an **indicative**
`availability.availableForBasket` (`product.view.ts:29-45`).

### 2.3 Basket

| Method | Path | Role | Request | Success | Errors | Idem | RT | Screen |
|---|---|---|---|---|---|---|---|---|
| POST | `/cart` | any auth | `{productId,variantId?,quantity≥1}` | 201 `{message,data:CartLineView}` | 401 · 404 · 400 not-sellable / wrong variant / insufficient stock | **—, and NOT idempotent** | — | store: add to basket |
| GET | `/cart` | any auth | — | 200 `{data:CartLineView[],notices:CartLineView[]}` | 401 | — | — | store: basket, and the **only** displacement channel |
| PATCH | `/cart/:id` | any auth | `{quantity≥0}` **absolute**; `0` removes | 200 `{message,data:CartLineView\|null}` | 401 · 404 · 400 | — (naturally idempotent) | — | store: quantity stepper |
| DELETE | `/cart/:id` | any auth | `id` int | 200 `{message}` | 401 · 404 | — | — | store: remove line |

### 2.4 Customer account

| Method | Path | Role | Request | Success | Errors | Idem | RT | Screen |
|---|---|---|---|---|---|---|---|---|
| GET | `/me/addresses` | site,sale,super_admin | `page,limit` | 200 `{data:{data[],total,page,limit,totalPage}}` **nested, singular `totalPage`** | 401 · 403 | — | — | store: address book, checkout |
| POST | `/me/addresses` | site,sale,super_admin | `{province,city,address,postal_code(10),reciver_mobile}` *(spelling as-is)* | 201 `{message,data}` | 400 · 401 · 403 | — | — | store: add address |
| GET | `/me/addresses/:id` | site,sale,super_admin | `id` | 200 `{data}` | 404 (also when it is someone else's) | — | — | store: address book |
| PATCH | `/me/addresses/:id` | site,sale,super_admin | partial | 200 `{message,data}` | 400 · 404 | — | — | store: edit address |
| DELETE | `/me/addresses/:id` | site,sale,super_admin | `id` | 200 `{message}` | 404 | — | — | store: delete address |
| GET | `/me/orders` | site,sale,super_admin | `page,limit` | 200 `{data:{data[],total,page,limit,totalPages}}` **nested** | 401 · 403 | — | — | store: my orders |
| GET | `/me/orders/:id` | site,sale,super_admin | `id` | 200 `{data:Order}` | 404 (also for another customer's) | — | — | store: order detail |

### 2.5 Checkout & payment

| Method | Path | Role | Request | Success | Errors | Idem | RT | Screen |
|---|---|---|---|---|---|---|---|---|
| POST | `/orders/quote` | **site** | — | 200 `{data:{quote,basket,notices}}` | 400 empty basket · 409 `checkout_contents_changed` | — | — | store: checkout review |
| POST | `/orders` | **site** | header `Idempotency-Key` **required**; `{address,discount_code?,quoteToken?}` | 201 `{message,data:CheckoutResponse}` | see §4.4 | **REQ** `online_order` | — | store: place order |
| POST | `/payment/start` | any auth | `{orderId}` | 201 `{message,data:{paymentId,orderId,trackId,amount,paymentUrl,reused}}` | 401 · 404 · 400 not owner / not payable / too many attempts / gateway down | — (de-facto per order) | — | store: pay |
| POST | `/payment/verify` | any auth | `{trackId}` | 201 `{message,data:VerifyPaymentResult}` | 401 · 400 not found / payment failed | — | `stock:updated`, `order.status.updated` **(global)**, `order.created`→admins | store: payment return |

### 2.6 POS

| Method | Path | Role | Request | Success | Errors | Idem | RT | Screen |
|---|---|---|---|---|---|---|---|---|
| GET | `/inventory/lookup` | **sale**,super_admin | `?sku=` | 200 `{data:{productId,productTitle,variantId,sku,unitPrice,isActive,isDefault,availability}}` | 400 missing sku · 404 unknown sku | — | — | web/POS: scan line |
| GET | `/inventory/availability` | **sale**,super_admin | `?variantIds=1,2,3` (≤100) | 200 `{data:AvailabilitySnapshot[]}` | 400 empty/oversized · **404 if ANY id is unknown** | — | — | web/POS: basket refresh |
| POST | `/orders/pos` | sale,super_admin | header `Idempotency-Key` **required**; `{paymentMethod,items[{productVariantId,quantity}],mobile?,name?}` | 201 `{message,data:PosSaleResponse}` | 400 key required/invalid, no branch · 404 variant · 409 stock / key reused / foreign cashier / in progress / deactivated | **REQ** `pos_sale` | `order.created`→admins+branch, `stock:updated` **(global)** | web/POS: charge |
| GET | `/orders` | `orders.read` | `page,limit,search,channel,status,fulfillmentState,paymentState,branchId,cashierUserId,customerId,userId,reconciliationState,from,to,dateField,sort` | 200 `{data:AdminOrderRowView[], total, page, limit, totalPages}` **spread at top level** — one bounded page, `soldAt DESC, id DESC` | 400 validation · 403 lacks `orders.read` | — | — | web: admin orders list |
| GET | `/orders/:id` | `orders.read` **or** `pos.receipt.read_own` | `id` | 200 `{data:AdminOrderDetailView}` for `orders.read`; a cashier holding `pos.receipt.read_own` gets the **receipt projection of their own sale only** | 403 neither permission · 404 absent **or** not this cashier's sale (deliberately indistinguishable) | — | — | web: order detail · POS: reprint own receipt |
| GET | `/orders/:id/actions` | `orders.actions.read` | `id`, `page,limit` (default 50, max 100) | 200 `{data:AdminOrderActionListView}` — one page, **oldest first**; an order with no action answers an empty array, not 404 | 400 validation · 403 · 404 unknown order | — | — | web: audit trail |
| PATCH | `/orders/status/:id` | super_admin,sale | `{status}` | 200 `{message,data:Order}` | 404 · 403 · 409 frozen · **409 `ORDER_FULFILMENT_INCOMPLETE`** · 400 invalid transition | — | `order.status.updated` | web: order detail |
| POST | `/orders/:id/void` | super_admin,sale | `{reason?}` | 200 `{message,data:Order}` | 404 · 403 · 409 already voided / refunded | — (self-guarding) | `stock:updated`, `order.status.updated` | web/POS: void |
| POST | `/orders/:id/return` | super_admin,sale | `{reason?}` | 200 `{message,data:Order}` | 404 · 403 · 409 already returned / wrong status | — (self-guarding) | same | web/POS: return |

### 2.7 Reporting

| Method | Path | Role | Request | Success | Errors | Idem | RT | Screen |
|---|---|---|---|---|---|---|---|---|
| GET | `/reports/sales/summary` | **`super_admin`** | `from,to,cashierUserId,branchId,channel,status` | 200 `{timezone,range,filters,totals,dataQuality,semantics}` **spread** — `totals.grossSales/refundedTotal/voidedTotal/netSales` and `dataQuality.refundsWithUnknownEventDate.total` are **decimal integer STRINGS** | 403 not `super_admin` · 401 wrong audience · 400 | — | — | web: dashboard, X/Z report |
| GET | `/reports/sales` | **`super_admin`** | + `page,limit` | 200 `{…,page,limit,total,totalPages,data[]}` **spread** — each row's `subtotal` / `total_price` are **STRINGS** | same | — | — | web: sales list, returns desk lookup |
| GET | `/reports/sales/by-cashier` | **`super_admin`** | as summary | 200 `{…,data[],reversalsByActor[]}` **spread** — every money field on both lists is a **STRING**; ordered by gross DESC, `cashierUserId` ASC | same | — | — | web: shift report |
| GET | `/reports/sales/:id` | **`super_admin`** | `id` | 200 `{timezone,data,semantics}` **spread** — `subtotal`, `totalPrice` and each item's `unitPrice` / `totalPrice` are **STRINGS** | 404 · 403 | — | — | web: sale detail |

**AUTHORISATION — the owner's rule, and it is not a capability.** Every route in
this section carries `@Roles(super_admin)` **and** `@Audiences('admin')`. There
is deliberately **no reports capability in `PERMISSION_CATALOG`**: the code
`reports.read` was removed from the catalogue and retired in the database by
migration **0028**, so a custom role cannot be created or edited to carry it and
a stale `role_permissions` row naming it resolves to nothing. A delegated
administrator holding *every* grantable capability is still `403` here. A
`super_admin` signed in at the till (POS audience) is `401`, because the
audience is checked before the role.

Branch scoping no longer participates: there is no principal who may read *some*
reports, so `filters.branchId` is `null` unless the caller passes one.

`from`/`to` are inclusive **local calendar days** `YYYY-MM-DD` in
`REPORT_TIMEZONE` (default `Asia/Tehran`), converted to a half-open UTC range by
PostgreSQL.

### 2.7.1 The dashboard — two routes, two rules

| Method | Path | Authorisation | Carries |
|---|---|---|---|
| GET | `/admin/dashboard/summary` | `dashboard.read` (delegatable) | counts, work-queue depths, stock alerts, eight recent orders — **no money field of any kind** |
| GET | `/admin/dashboard/financial` | **`super_admin`** + `admin` audience | today's `money.{grossSales,refundedTotal,voidedTotal,netSales}`, `byChannel[]`, `byBranch[]`, `topVariants[]` — every money value an integer-Rial **STRING** |

**BREAKING (pre-first-commit).** `/admin/dashboard/summary` previously carried
`totals.grossSales/refundedTotal/voidedTotal/netSales`, `byChannel`, `byBranch`,
`topVariants` and `recentOrders[].totalPrice`. All of those moved to
`/admin/dashboard/financial`. The summary route no longer *runs* the money
queries, so the figures are not computed and discarded — they are never
produced for a caller who may not have them. The sidebar badge counts read the
summary, so a delegated administrator's console makes no financial request at
all. In-repo client updated: `apps/web/lib/admin-api.ts`
(`DashboardSummary`, new `DashboardFinancial` + `fetchDashboardFinancial`) and
`apps/web/components/admin/dashboard.tsx` (`FinancialSection`).

### 2.8 Administration

| Method | Path | Role | Screen |
|---|---|---|---|
| POST `/products` · PATCH `/products/:id` · GET `/products/admin/:id` · POST `/products/uploadImage` | super_admin | web: product editor |
| POST `/products/variants/:variantId/stock/adjust` | super_admin | web: variant & stock |
| POST `/attributes` · DELETE `/attributes/:id` · DELETE `/attributes/values/:id` | super_admin | web: attributes |
| POST `/categories` (`categories.create`) · GET `/categories/admin` (`categories.read`) · PATCH `/categories/:id` (`categories.update`) · DELETE `/categories/:id` (`categories.delete`, **empty categories only** — see §2.8.1) | admin audience, per-route permission | web: categories |
| POST `/users` · GET `/users` · PATCH `/users/:id` · DELETE `/users/:id` · PATCH `/users/:id/activate` · PATCH `/users/:id/deactivate` | super_admin | web: staff |
| GET `/roles` · POST `/roles/assign` · DELETE `/roles/remove` · DELETE `/roles/:id` · GET `/roles/users/:userId` | super_admin | web: roles (**`POST /roles` is GONE** — see §8.6) |
| POST `/branch` · PATCH `/branch/:id` · DELETE `/branch/:id` | super_admin | web: branches |
| GET `/branch` · GET `/branch/:id` | **any authenticated** | web: branch picker (see §9 F-6) |
| GET `/customer` · GET `/customer/:id` | super_admin | web: customers |
| GET/POST/PATCH/DELETE `/address*` | super_admin | web: admin address CRUD (prefer `/me/addresses`) |
| POST `/inventory/admin/sweep-reservations` · POST `/payment/admin/fulfilment/recover` · POST `/payment/admin/reverify` | super_admin | web: operations console |
| GET `/payment/admin/reconciliation` · GET `/payment/admin/reconciliation/:orderId` | super_admin | web: reconciliation queue (§8.7) |
| POST `/payment/admin/reconciliation/:orderId/retry-fulfilment` · `/mark-refund-required` · `/confirm-refund` · `/mark-backorder` · `/resolve` | super_admin, **`Idempotency-Key` required** | web: reconciliation case (§8.7) |
| GET `/health` | PUBLIC | uptime probe |

#### 2.8.1 Deleting a category — the full contract

`DELETE /categories/removeOnlyCategory/:id` **no longer exists.** It detached
every product from the category and then deleted it, answering 200: the
`product_category` rows it dropped are the catalogue's navigation structure,
nothing recorded what was removed, and no administrator could reconstruct which
products used to be in a category. It was replaced by a delete that **refuses**
instead.

| | |
|---|---|
| **Audience** | `admin` only (`@Audiences('admin')` on `CategoriesController`) — an `admin` cookie pair, not storefront and not POS |
| **Permission** | **`categories.delete`** (`@RequirePermissions`). Not a role name: any role carrying the capability passes, and one that does not is 403 |
| **Method + path** | `DELETE /categories/:id` |
| **Params** | `id` — numeric `categories.id`, `ParseIntPipe` |
| **Body** | none |
| **Success** | **200** `{ success, timeStamp, message: "Category deleted successfully" }`. No `data`. |

**Delete succeeds ONLY when the category is unused.** `CategoriesService.safeRemove`
opens a transaction, loads the category, counts the products attached to it, and
deletes only when that count is `0`. **No product is ever silently detached** —
if you want the category gone, move its products out first, deliberately,
through the product endpoints that own membership (`categoryIds` on product
create/update is the complete desired set).

Errors:

| Status | Body | Meaning |
|---|---|---|
| **409** | `error: "CATEGORY_IN_USE"`, `message: "This category has products and cannot be deleted"`, `details: { categoryId, productCount }` | **The stable refusal.** Products are still attached; `details.productCount` is how many. Branch on `error`, never on `message`. |
| 404 | `message: "Category not found"` | No category has that id |
| 403 | — | Authenticated, but the caller lacks `categories.delete` |
| 401 | — | No valid `admin` session |
| 400 | — | `id` is not an integer (`ParseIntPipe`) |

A successful delete also writes a `CATEGORY_DELETED` audit row (actor, target id
and title) inside the same transaction, and invalidates the cached public
category list.

---

## 2.9 Product channel visibility and business codes (0030–0032)

### ⚠ Read this first: visibility is NOT per-branch inventory

Selecting branches for a product decides **where it may be sold from**. It does
**not** give each branch its own stock. `product_variants.stock` remains one
global number, basket reservations and order allocations remain global, and POS
displacement priority is unchanged. Two branches that both carry a product sell
out of the same single quantity — two cashiers in two shops racing for the last
unit resolve exactly as two cashiers in one shop do.

Do not build a per-branch stock display. There is no such number to display.

### The model — two independent dimensions

| case | `visibleOnSite` | `branchVisibility` |
|---|---|---|
| website only | `true` | `none` |
| all retail branches | `false` | `all` |
| selected retail branches | `false` | `selected` + `branchIds` |
| website + selected | `true` | `selected` + `branchIds` |
| website + all («همه کانال‌ها») | `true` | `all` |
| hidden / draft | `false` | `none` |

`"all"` covers branches that **do not exist yet**; `"selected"` deliberately
does not. An empty `branchIds` under `"selected"` is refused by the API *and*
by a database trigger.

### Who may change it

**`super_admin` only** — including NARROWING. A delegated catalogue editor may
create and edit products and may not publish, unpublish, or assign branches. A
product a delegated editor creates is born hidden/draft. This is enforced in the
service, not only by a route decorator; do not rely on hiding the controls.

A `PATCH` whose visibility fields are IDENTICAL to the stored configuration is
not a change and is allowed for anyone, so a form may safely round-trip them.

### Endpoints

| Method | Path | Role | Request | Success | Errors | Idem | RT | Screen |
|---|---|---|---|---|---|---|---|---|
| POST | `/products/admin/codes/product` | `super_admin`, admin audience | — | `{ productCode }` | 401/403 | — | — | web |
| POST | `/products/admin/codes/variant` | `super_admin`, admin audience | `{ productCode }` | `{ productCode, variantCode }` | 400 `CODE_*`, 401/403 | — | — | web |

`POST /products` now REQUIRES `productCode`, and every entry of `variants[]`
requires `variantCode`. `PATCH /products/:id` accepts both optionally, plus
`visibleOnSite` / `branchVisibility` / `branchIds`. `GET /products/admin/:id`
returns `visibility` — the ONLY projection that does; neither the storefront nor
the POS ever receives it.

### Codes

`productCode` identifies a product family (`KZ-P-000001`); `variantCode`
identifies one exact variant and must begin with its parent's code
(`KZ-P-000001-V000001`). **`sku` is unchanged and unrelated** — it is the
warehouse's string, often a vendor's. Both are shown; the POS searches either.

Normalisation is server-side and total: outer whitespace trimmed, Latin
upper-cased, Persian/Arabic digits folded to ASCII. So `«kz-p-۱۲۳»` and
`KZ-P-123` are the SAME code and the second is a 409. Internal whitespace,
non-`[A-Z0-9-]` characters, and leading/trailing/doubled hyphens are refused.

Generation is concurrency-safe (a PostgreSQL sequence) and works across API
instances. A generated code is **not reserved** — abandoning the form leaves a
harmless gap. Uniqueness is guaranteed by the database index, not by generation.

Codes are **editable**, because `order_items` snapshots `productCodeSnapshot`
and `variantCodeSnapshot` at sale time. Editing a code changes the catalogue and
never a historical receipt.

### Refusal codes

| `error` | Status | Field | Meaning |
|---|---|---|---|
| `CODE_REQUIRED` / `CODE_INVALID` / `CODE_HAS_WHITESPACE` / `CODE_TOO_LONG` | 400 | `details.field` | malformed code |
| `VARIANT_CODE_UNRELATED` | 400 | `variantCode` | child does not begin with its parent's code |
| `PRODUCT_CODE_TAKEN` / `VARIANT_CODE_TAKEN` | 409 | `details.field` | duplicate; names the field, never the other product |
| `VISIBILITY_FORBIDDEN` | 403 | `visibility` | not `super_admin` |
| `BRANCHES_REQUIRED` / `BRANCHES_NOT_ALLOWED_FOR_MODE` / `BRANCHES_UNUSABLE` | 400 | `branchIds` | mode/branch mismatch, or unknown/inactive branch |
| `channel_unavailable` | 409 | — | `POST /orders/quote` and `POST /orders`: a basket line is no longer on the website. `retryable: false` |
| `PRODUCT_NOT_AVAILABLE_IN_BRANCH` | 409 | — | `POST /orders/pos`: the cashier's branch does not carry it. `retryable: false` |

Every refusal carries `details.field` where a form can use it. None of them
discloses which OTHER branches carry a product, the mode, or the selected list.

### What the storefront sees

`GET /products`, `GET /products/:id`, search and category filtering return only
`visibleOnSite = true` products. A withdrawn product's detail route answers
**404, not 403** — a distinguishable refusal would let a client enumerate the
private catalogue. `POST /cart` refuses to ADD one, also as a 404.

A line ALREADY in a basket when the product is withdrawn **stays**, with
`change.reason = "channel_unavailable"`, `at: null`, `quantityDelta: null`, and
its units still held. It BLOCKS checkout at both `POST /orders/quote` and
`POST /orders`. It is deliberately **not** `not_sellable`/`VARIANT_INACTIVE`:
the variant may be active and selling briskly in the shops, and telling the
customer it is discontinued would be false.

### What the POS sees

`GET /inventory/catalog` and `GET /inventory/lookup` are scoped to the
authenticated cashier's branch, which must be ACTIVE (an inactive branch is a
409, not an empty grid). Lookup matches a SKU **or** a variant code, and a code
the branch does not carry answers 404 — not 403 — so a cashier cannot map a
neighbouring shop's range by probing.

A `pos` session with NO branch is refused `400 USER_NOT_IN_BRANCH`, matching
`POST /orders/pos`. **This is a behaviour change**: such a cashier used to be
able to browse everything and fail only at the point of sale. An `admin`
session with no branch is not scoped — it is entitled to the whole catalogue
through `GET /products/admin` anyway.

`POST /orders/pos` re-checks branch availability **inside the sale transaction**
under a share lock on the product rows, so a visibility change racing a sale
resolves to one definite order. A refusal writes nothing at all: no order, no
items, no payment, no stock movement, no displaced reservation, no realtime
frame — and the same Idempotency-Key may be retried once the product is
published to that branch.

### Realtime

A visibility change publishes `availability:invalidated` for every variant of
the product, reason `catalogue` (which is POS-relevant, so it reaches
`staff:availability` too). The frame stays a bare pointer —
`{ variantId, productId, reason }`. **No branch list, no mode and no site flag
travels on a public or POS socket**; the client refetches through its own
authoritative endpoint, which applies the same gate it would have anyway.

---

## 3. Realtime — what a client actually receives

Socket.IO authenticates from the **audience cookie on the handshake**: the
client names its surface in the handshake query (`?audience=storefront|admin|pos`)
and the gateway reads exactly that audience's access cookie
(`kz_storefront_access` / `kz_admin_access` / `kz_pos_access`) and requires the
signed `aud` claim to agree. There is no `auth: { token }` path, and naming an
audience you hold no cookie for gets you nothing. Rooms follow the **surface**:
`storefront` joins only `user:<id>`; `pos` joins `user:<id>` and `branch:<id>`
(when it has one); `admin` joins `user:<id>` and, for a super_admin, `admins`
plus `branch:<id>` (when it has one). Every
60 s sockets are re-validated against the database and disconnected if the
account was deactivated or the password changed.

| Event | Room | Payload |
|---|---|---|
| `availability:updated` | **every socket** (the only global broadcast) | `{variantId, inStock}` — boolean only, no quantity |
| `stock:updated` | `admins` + `branch:<id>` — **staff only** | `{variantId, newStock, branchId?}` |
| `order.created` | `admins` + `branch:<id>` | POS: full sale summary; online: `{orderId, branchId}` |
| `order.status.updated` | `admins` + `branch:<id>` | `{orderId, status, branchId, voidedAt?}` |
| `order.status.updated` | `user:<ownerId>` — **the owning customer** | `{orderId, status}` — no branch, no cashier |
| `order.awaiting_stock` | `admins` + `branch:<id>` | `{orderId, branchId}` |

**Three facts that shape the whole frontend design:**

1. **Exact stock never reaches a storefront customer.** `stock:updated` was a
   global broadcast of exact unit counts to every connected socket, including
   every retail session — the one hole in a rule that role-gates quantities on
   every HTTP route. It is now staff-scoped. Storefronts subscribe to
   **`availability:updated`** instead, which carries a variant id and a
   boolean and nothing else. `inStock: false` is a committed fact (it comes
   from the R2 `balanceAfter`); `inStock: true` is only a hint to re-read.

2. **Per-customer realtime now exists.** `emitToUser` had zero production call
   sites; the `user:<id>` room was joined and never emitted to. The owning
   customer now receives `order.status.updated` on their own room with a
   deliberately narrower payload than the staff copy. Basket-displacement
   notices are still poll-only (`GET /cart`) — see §4.3.

3. **No order event is global any more.** A storefront socket no longer
   receives an event for every order anyone pays. `order.status.updated` on
   `user:<id>` *does* mean "my order" — that is the whole point of the split —
   but the staff-room copy of the same event name carries branch attribution,
   so a client must not subscribe to both and merge them.

**Room membership caveat.** `handleConnection` joins `branch:<id>` for anyone
whose `users.branchId` is set, regardless of role. Branch is staff-only in
practice, but a `site` customer given a `branchId` would receive exact stock.
That is an owner decision, not a defect — see New-5 in the implementation plan.

---

## 4. Frontend integration rules

### 4.1 Cookie authentication and refresh

Cookies are **one pair per audience** (`auth/audience.ts`,
`services/auth-cookie.service.ts`): `kz_storefront_access` /
`kz_storefront_refresh`, `kz_admin_access` / `kz_admin_refresh`,
`kz_pos_access` / `kz_pos_refresh` — all six `httpOnly: true, secure: true,
sameSite: 'strict', path: '/'`, with no `domain`. Lifetimes
`JWT_ACCESS_EXPIRATION` (**15m**) and `JWT_REFRESH_EXPIRATION` (**2d**); cookie
maxAge and token expiry are read from the same config so they always agree. The
pre-audience `access_token` / `refresh_token` pair is no longer read by anything
and is actively cleared on every session write.

- **`sameSite: 'strict'` is load-bearing.** The storefront must be served
  **same-site with the API** (a Next.js BFF/proxy). A cross-site SPA will never
  have the cookie attached, and — critically — **a top-level redirect back from
  the payment gateway is a cross-site navigation, so the cookie is not sent on
  it.** See §4.6.
- **You cannot read the cookie or decode the JWT.** Call **`GET
  /auth/{audience}/me`** — the audience of the surface you are, never another's
  — on app start and after every login/refresh. It is authoritative: `roles`,
  `permissions` and `branchId` are re-read from the database on every request,
  so a role change takes effect immediately rather than at the next token
  rotation.
- **Serialise refreshes.** Rotation is a guarded conditional
  `UPDATE … WHERE revoked = false` asserting `affected === 1`
  (`auth.service.ts:222-234`): **exactly one concurrent refresh wins and the
  rest get 401**. Use a single-flight shared promise for all 401 retries, or an
  N-way concurrent refresh signs the user out.
- **401 handling**: attempt refresh once (`POST /auth/{audience}/refresh`), then
  treat as signed out. A 401 on `GET /auth/{audience}/me` at first paint is the
  normal signed-out state, not an error.
- **403** means authenticated but wrong role — usually a `sale`/`super_admin`
  user hitting a `site`-only route such as `POST /orders`.
- Logout is **current-session only** by design; the access token stays valid
  until it expires, which is why the access lifetime is short.

### 4.2 Four-hour basket reservations

TTL is **4 hours**, owner-confirmed (`inventory.types.ts:81`).

- Adding units creates a **new tranche with its own fresh timer**; existing
  tranches are never extended. Reducing releases the **newest tranche first**,
  so the surviving units are the oldest.
- `CartLineView.expiresAt` is the **earliest** tranche expiry — when the line
  *starts* losing units, not when it empties. Render `tranches[]` for a precise
  countdown.
- `GET /cart` locks and **lazily expires** before reporting, so
  `reservedQuantity`, `availableForBasket` and `expiresAt` are always
  server-authoritative. Never compute a countdown from a cached response.
- **`items` and `notices` overlap.** An active, partially displaced line is in
  **both** arrays. Deduplicate by `id` or you will render the product twice.

### 4.3 POS displacement notices

A POS sale outranks a basket hold. The affected line is rewritten under lock
with `lastChangeReason`, `lastChangeAt` and a negative `lastChangeQtyDelta`.

- **Poll, do not wait for a push.** There is no per-customer realtime (§3).
  Refetch `GET /cart` on basket open, on window focus, and immediately before
  showing the checkout review.
- Customer-visible reasons are only `sold_in_store`, `reservation_expired` and
  `stock_not_counted`. `basket_item_removed`, `quantity_reduced` and
  `converted_to_order` are customer-initiated and produce no notice.
- **Privacy contract: the notice says WHAT, never WHO.** No branch, no cashier,
  no other customer ever appears. Do not build UI expecting a store name.
- **Clearing differs by line state.** A soft-removed tombstone's notice is
  cleared by the very `GET /cart` that returned it — **shown exactly once**, so
  if you drop that response the explanation is gone. An **active** line's notice
  is *not* cleared by reading, and repeats on every `GET /cart` and every
  `POST /orders/quote` until the customer edits the line. Keep a client-side
  dismissal keyed on `(cartItemId, lastChangeAt)`.

### 4.4 Signed checkout quotes

`POST /orders/quote` prices the basket under the inventory locks and returns an
HMAC-signed token binding the customer, the exact SKU lines, quantities, unit
prices, totals and a bounded window (**15 min** default, clamped to at most the
4-hour reservation TTL). It writes nothing and holds nothing — **a quote is not
a hold**.

The gate is a **fingerprint over the lines**, not the total: two baskets that
cost the same but differ line-by-line are a mismatch.

| `error` | `details.quote` | Meaning | Client action |
|---|---|---|---|
| `checkout_quote_required` | object | No quote yet — the **ordinary first step** | Show basket + notices; on accept, resend with the token |
| `checkout_quote_invalid` | object | Expired, malformed, tampered, wrong customer, **or lapsed during a lock wait** — one code for all five | Re-review, resend |
| `checkout_quote_stale` | object | Basket no longer matches; `details.changes` is the was/now diff | Show the diff, **wait for the customer**, then resend |
| `checkout_contents_changed` | **`null`** | Nothing purchasable left | Back to basket — nothing to confirm |
| `checkout_retry_required` | **absent** | Transient in-request race; `retryable:true`, no diff, no basket | **Retry with the SAME token**, bounded 2–3 |

`checkout_price_changed` is **defined and never thrown** — do not branch on it.

**The safe retry rule.** On `checkout_retry_required`, retry with the **same
accepted token and same Idempotency-Key**. Do **not** fetch a fresh quote and
resubmit it: the race's cause may be a new SKU appearing in the basket, and
auto-adopting a fresh quote charges the customer for something they never saw —
the removed `confirmChanges: true` defect rebuilt in the client. **A quote may
only ever be adopted by a person.**

### 4.5 One Idempotency-Key across checkout retries

Generate **one key per checkout attempt** and reuse it on **every** retry —
including after a 409. Never per HTTP request.

- Every rejection is thrown inside the checkout transaction, so the idempotency
  claim **rolls back with it** and the same key stays usable. If it did not, one
  409 would lock the customer out of their own checkout permanently.
- A **successful** request replays: the same key returns the same order and
  allocates stock exactly once.
- `quoteToken` is deliberately **excluded from the request hash**, so retrying
  with a *new* token is not treated as key reuse. The hash covers `address` and
  `discount_code`; changing those with the same key is a 409.
- Format: 8–200 chars from `[A-Za-z0-9._:-]`. A UUIDv4 is the recommended value.
  Commas and whitespace are rejected because a doubled header arrives
  comma-joined.

### 4.6 Payment confirmation and reconciliation

`POST /payment/start` → redirect the browser to `data.paymentUrl`.

**The gateway cannot call `/payment/verify` server-to-server** — the route is
guarded and the guard reads only the cookie, which the gateway cannot produce.
And because the cookie is `sameSite: 'strict'`, it is **not sent on the top-level
redirect back from the gateway** either. The working sequence is: the gateway
redirects the browser to a storefront page **on the same site as the API**; that
page loads first-party; **the page's own JavaScript** then calls
`POST /payment/verify` with `credentials: 'include'`.

Reading the result — **do not use `success`**, which is always `true` when the
call returns (it means "the gateway confirmed a receipt", not "the order is
fine"). Do not use `orderStatus === 'paid'` either.

```
progressing  ⇔  applied === true && fulfilmentBlocked === null
on hold      ⇔  applied === false || fulfilmentBlocked === 'reconciliation_required'
not paid     ⇔  HTTP 400 "Payment failed"
```

"On hold" means **money received, order not confirmed, a human is reviewing** —
never render "payment failed" for it. `reconciliationReason` is one of
`amount_mismatch`, `amount_missing`, `amount_invalid`, `duplicate_confirmed`,
`order_not_payable`, `late_confirmation_unapplied`, `late_confirmation_applied`.
The server supplies a customer-safe sentence in `message` for every outcome —
render it rather than composing your own.

### 4.6a A paid order cannot be advanced until its goods are allocated

`PATCH /orders/status/:id` now answers **409** with

```json
{
  "success": false,
  "statusCode": 409,
  "error": "ORDER_FULFILMENT_INCOMPLETE",
  "message": "This order is paid but its goods have not been allocated yet, …",
  "details": {
    "orderId": 41,
    "status": "paid",
    "fulfillmentState": "pending",
    "requestedStatus": "processing",
    "reconciliationQueue": "/payment/admin/reconciliation"
  }
}
```

whenever the target status is `processing`, `shipped` or `delivered`, the order
is `paid`, and `fulfillmentState` is **not** `fulfilled` or `not_required`
(i.e. it is `pending` or `awaiting_stock`).

**Why the API refuses.** Both re-drivers of fulfilment — the fulfilment claim
and the recovery sweep — select `status = 'paid'`. Advancing the order removes
it from both permanently, so the money stays taken and the goods are never
allocated. The refusal **writes nothing**: status, `fulfillmentState`, stock and
`order_actions` are all unchanged and the order keeps its place in the recovery
queue.

**What a client should do.** Disable/annotate the "mark as processing / shipped"
control while `status === 'paid' && (fulfillmentState === 'pending' ||
fulfillmentState === 'awaiting_stock')`, and on the 409 link the operator to
`details.reconciliationQueue`. Retry the same PATCH once `fulfillmentState`
becomes `fulfilled` — it then succeeds unchanged. Branch on
`error === 'ORDER_FULFILMENT_INCOMPLETE'`, not on the sentence.

### 4.7 Stock updates and realtime reconnect recovery

- `stock:updated` is **global and advisory**. Treat it as a hint to refresh a
  visible product, never as authority.
- **Every realtime frame is droppable by design.** The authoritative reads are
  `GET /cart` (basket), `GET /products/:id` (catalog availability) and
  `GET /inventory/lookup` (POS).
- **On reconnect, re-read rather than replay.** There is no event backlog and no
  sequence number. Refetch whatever is on screen.
- Sockets are force-disconnected when the access token expires (~15 min), on
  deactivation, and on password change. Treat a disconnect as "refresh the
  session, then reconnect, then re-read", not as a transport error.

### 4.8 Integer Rial

Every monetary value is a whole number of Rial. Format for display only
(`value / 10` for Toman); never round-trip a formatted string back to the API.
Send prices nowhere: **there is no endpoint that accepts a price from a client**
— not checkout, not POS. The server always prices from the locked variant row.
`expectedTotal`-style client assertions do not exist; the signed quote replaced
them.

### 4.9 Branch and cashier attribution

- POS attribution comes **only** from the access token. `cashierId` and
  `branchId` in the POS body are accepted for backwards compatibility and
  **ignored**. Send neither.
- A `sale` user is pinned to their own branch server-side for reports, which
  answer 403 on another branch rather than silently rewriting the filter. A
  cashier has **no sales-history route at all**: `GET /orders` needs
  `orders.read`, which `sale` does not hold. The till reprints its own sale
  through `GET /orders/:id` (`pos.receipt.read_own`).
- The **original seller** is written once and never overwritten. A void or
  return is attributed separately in `order_actions`, surfaced as
  `reversalsByActor`. **Never sum `by-cashier` and `reversalsByActor`** — they
  are the same Rial counted from two sides.
- `branchId` for the till header comes from `GET /auth/pos/me`; resolve the name
  via `GET /branch/:id`.

---

## 5. Missing endpoints — what was found, and what was done

Three journeys could not be built at all. Each gap was implemented **only**
because its behaviour was already fully determined by accepted contracts — no
new pricing, no reservation, no financial policy.

### 5.1 `GET /auth/{audience}/me` — implemented

**Evidence of the gap.** The auth controller had **no GET route of any kind**,
and `GET /users` is administrator-only. The session cookie is `httpOnly`, so
JavaScript cannot read it. No storefront, admin or POS client could answer "is
anyone signed in, what may they do, which branch are they in" — which is the
first question every one of the three apps asks on first paint.

**Why it invents nothing.** The response is exactly what `JwtStrategy.validate()`
already resolves and attaches to every authenticated request, and what
`UserRequest` already declares. It is also *more* correct than the alternative:
`validate()` re-reads roles, permissions and `branchId` from the **database** on
every request, so a role change takes effect immediately, whereas a client-side
JWT decode would render stale permissions for up to the token lifetime.

**Mounted once per audience** — `GET /auth/storefront/me`, `GET /auth/admin/me`,
`GET /auth/pos/me`. It was a single shared `GET /auth/me` when first implemented;
that shared route is **gone**, because one route reading one cookie pair is
exactly what let a till session answer for the storefront header. Each surface
now calls its own and reads only its own cookie. See `docs/AUTH-AUDIENCES.md`.

### 5.2 `GET /inventory/lookup?sku=` — implemented

**Evidence of the gap.** `GET /products` searches `LOWER(p.title) LIKE …`
(`products.service.ts:735-738`) — **title only**. A grep for `sku` across
`src/modules/products` finds it in DTOs, the entity and output views, never as a
filter. A barcode scan at the till matched nothing.

**Why it invents nothing.** `product_variants.sku` is already globally unique;
the price returned is the variant's own `price`; availability is the existing
`AvailabilitySnapshot`. It reserves nothing.

### 5.3 `GET /inventory/availability?variantIds=` — implemented

**Evidence of the gap.** Every endpoint carrying a stock number is
`super_admin`: `stock` exists only on `AdminVariantView`
(`product.view.ts:73-77`), served by `GET /products/admin/:id`
(`@Roles(super_admin)`). **A `sale` cashier could not see a stock level
anywhere in the API**, which makes "inventory visibility" — an explicit owner
requirement — unreachable for the role that needs it most.

**One behaviour deliberately left alone.** An unknown variant id fails the whole
request with 404 rather than being omitted. That is the existing inventory
contract (`computeAvailability` and `lockVariants` both throw), because every
consuming path must fail loudly rather than price a basket it could not fully
resolve. A first draft of the test expected omission; changing the service to
suit it would have altered accepted behaviour, so the test was changed instead.

### 5.4 Gaps found and **not** implemented

Each would change behaviour or needs a decision, so each is reported instead:
bookmark read (F-5), customer lookup for cashiers and a cashier directory (F-7),
partial/line-level returns, order lookup by receipt number, and a customer
projection for `GET /me/orders` (F-4).

---

## 6. Findings requiring a backend decision

Nothing in this section was changed — all are behaviour changes, and the brief
was to preserve behaviour. Every one was verified against source personally.

**F-1 · RESOLVED · `RolesGuard` metadata precedence was inverted.**
`roles.guard.ts:17-20` resolves `[getClass(), getHandler()]`, so a class-level
`@Roles` **overrides** a handler-level one — the opposite of
`jwt-auth.guard.ts:31-34` and of Nest convention. I checked every controller:
**none declares both**, so today's effective roles are exactly as tabulated. The
first handler-level `@Roles` added to `CustomerAddressController`,
`CustomerOrdersController`, `ReportsController`, `UserController` or
`AddressController` will be **silently ignored**. Swapping the array is a
one-line change with provably zero behavioural delta today.

**F-2 · MOSTLY RESOLVED · Machine-readable error codes lived in three
different places.** Insufficient stock used to set **neither** `error` nor
`code`, so a POS client could only distinguish "out of stock" by matching an
English sentence. `translateInventoryError` now sets both, for both
`INSUFFICIENT_STOCK` and `INVENTORY_CONCURRENTLY_MODIFIED`, so
`body.error ?? body.details?.code` reads uniformly across every checkout, POS
and inventory conflict — the stock special case is gone. POS *idempotency*
codes still arrive only as `details.code` with a generic top-level `error`;
keep the `??` fallback.

**F-3 · RESOLVED · Order status was broadcast to every socket from the payment path.**
`payment.service.ts:1181` calls `server.emit('order.status.updated', {orderId,
status:'paid'})` — a raw global emit that bypasses `emitOrderEvent`, whose own
doc comment (`realtime.gateway.ts:206-218`) states that this exact pattern
"leaked order totals, customer ids and branch attribution to every signed-in
retail customer with a socket open" and was fixed. The orders path was fixed;
this one was missed. Payload is narrow (`orderId`, `status`) so it leaks order
ids and activity rather than money, but it contradicts the documented contract.

**F-4 · RESOLVED · `GET /me/orders` returned raw entities.** No projection, so customers
receive `fulfillmentAttempts`, `fulfillmentNextAttemptAt`,
**`fulfillmentLastError`** (a raw internal error string), `cashierUserId`,
`cashierDisplaySnapshot`, `branchNameSnapshot`. The catalog has explicit
public/admin views precisely to prevent this; orders do not.

**F-5 · Bookmarks are write-only.** `POST /products/bookmark` toggles and
returns `{bookmarked}`; no route lists them and no product view carries an
`isBookmarked` flag. A wishlist and a correctly-lit heart are unbuildable.

**F-6 · `GET /branch` and `GET /branch/:id` have no role restriction.** Any
authenticated principal — including a retail `site` customer — can enumerate
every branch's name, address and phone. Flagged as a scoping question.

**F-7 · A cashier cannot look up a customer or list cashiers.** `/customer*` is
`super_admin`, so a till can create a customer implicitly by putting `mobile` on
a sale but can never search or confirm one. `/users` is `super_admin`, so the
`cashierUserId` report filter has no picker.

**F-8 · RESOLVED · `POST /payment/verify` was not owner-scoped.** `Verify(trackId)` takes
only a track id and never compares the caller to `order.userId`, unlike
`Start()` which does (`payment.service.ts:363`). Any authenticated user holding
a `trackId` can drive another customer's verification and read back that
customer's `orderId`, `expectedAmount`, `gatewayAmount` and status.

**F-9 · PARTLY RESOLVED · per-customer order status now exists; basket displacement is still poll-only.** `emitToUser` is declared and
documented for displacement notices but has zero production call sites. The
`user:<id>` room is joined and never used. Polling `GET /cart` is the only
channel, and the comments describing realtime as "advisory, with `GET /cart` as
the recovery path" describe a channel that never fires.

**F-10 · RESOLVED · `POST /auth/storefront/send-otp` was unthrottled and side-effecting.**
Each call issued a fresh OTP and **created a `users` row for any unseen
mobile** before the OTP was proven, and `verify-otp` had no attempt counter
against a 6-digit code. Now: 60 s resend cooldown, 5 sends/hour per normalized
mobile, 20 sends/hour per client IP, 5 wrong guesses per challenge, 120 s TTL,
one-time consumption, and **the account is created only on first successful
verification**. All state lives in the new `otp_challenges` table so the
attempt counter and the consumption are single atomic statements. See §8.3.

**F-11 · The gateway callback URL points at a route that does not exist.**
`PaymentConfig.callbackUrl` defaults to
`http://localhost:3000/v1/payment/callback` — a `/v1` prefix the app never
registers and a `/payment/callback` handler that does not exist.
`PAYMENT_CALLBACK_URL` must be set to a real storefront page.

**F-12 · Field naming is inconsistent for the same data.** `totalPrice` (POS
response, report detail) vs `total_price` (entity reads, report rows);
`unitPrice` vs `unit_price`. Pagination is top-level on `/products`, nested on
`/me/orders` and `/me/addresses`, and spelled `totalPages` / `totalPage` /
`tatalPage` (typo, admin address list) across three endpoints.

**F-13 · `checkout_price_changed` is dead code.** Defined in
`checkout.messages.ts` and never thrown. Do not branch on it.

**F-15 · RESOLVED · `POST /orders` could answer a bare 500 on insufficient stock.**
`translateInventoryError` is called only from `createPosOrder`
(`orders.service.ts:1405`) and `reverseOrder` (`:1717`). The checkout path's
`convertBasketToOrderAllocation` has no such wrapper, so an
`InsufficientStockError` escapes as a non-`HttpException` and the global filter
renders a generic 500 with no code. In practice it looks hard to reach — the
allocation runs inside the same transaction that already holds the variant
locks, so availability cannot move underneath it — but a storefront cannot
distinguish "out of stock" from a server fault if it ever does fire.

**F-14 · `order.voided` is declared and never emitted.** Present in
`emitOrderEvent`'s event union; voids emit `order.status.updated` with a
`voidedAt` field instead. A client subscribing to it receives nothing, ever.

---

## 7. Administration findings (verified)

The two highest-severity items I confirmed against source myself.

**A-1 · `DELETE /roles/:id` silently de-privileges every user holding the role.**
`user_roles.rolesId` is `ON DELETE CASCADE`
(`1757000000001-BaselineSchema.ts:176`) and `RoleService.removeRole` deletes
unconditionally with no usage check. Deleting the `super_admin` row returns
**200 "Role deleted successfully"** and strips super-admin from **every** user —
including the caller, who is locked out on their next request, because roles are
re-read from the database per request. No endpoint exposes a usage count, so a
UI cannot even warn.

**RESOLVED.** `RoleService.removeRole` is now transactional and takes the role
row `FOR UPDATE` before deciding. The three built-in roles are undeletable by
**name** (`ROLE_BUILTIN_PROTECTED`), a role held by anyone is undeletable
(`ROLE_IN_USE`, carrying `details.assignedUserCount`), and every path that could
strip the last administrator — `DELETE /roles/remove`, `PATCH /users/:id` role
replacement, `DELETE /users/:id`, `PATCH /users/:id/deactivate` — refuses with
`LAST_SUPER_ADMIN`. The button is safe to ship: the server refuses, not the UI.

**A-2 · RETRACTED — this finding was wrong.** ~~A password change does not
revoke refresh tokens.~~

The original claim was that only access tokens die on a password change, so a
stolen refresh token could still rotate itself a fresh access token. **That is
false.** `AuthService.refreshToken()` checks the *presented refresh token* and
rejects it, so the rotation never happens and no fresh access token is ever
minted. The claim assumed a rotation the code refuses to perform.

**HOW THE CHECK WORKS NOW — `users.passwordVersion` (migration 0027).**

Every access and refresh token carries a `pv` claim: the value of
`users."passwordVersion"` at the moment it was minted. A verifier admits the
token only while `pv` still **equals** the column. Changing a password
increments the column, so every token from the old epoch dies at the very next
request, and a token minted afterwards carries the new value and works
immediately.

It is enforced at **three** independent points, all covered by tests:

| Surface | Enforcement | Effect |
|---|---|---|
| Access token on any HTTP request | `JwtStrategy.validate` | old access token rejected, 401 `SESSION_INVALIDATED` |
| Refresh rotation | `AuthService.refreshToken` | old refresh token cannot rotate |
| Open websocket | `RealtimeGateway` handshake + 60 s sweep | live socket disconnected |

The write side is one transaction in `UserService.applyPasswordChange` and in
`AdminUserService.resetPassword`: new hash, `"passwordVersion" = "passwordVersion" + 1`
**in SQL**, and every live `refresh_tokens` row revoked. The increment is
arithmetic PostgreSQL performs under the row's own lock, so two concurrent
password changes produce two increments rather than both reading the same value
and writing the same one.

One password change therefore ends every session on every surface, including
sockets already open. **No `deactivate` step is required and none was added.**
The previously recommended "chain deactivate → revoke-sessions" advice is
withdrawn: `POST /auth/users/:id/revoke-sessions` remains useful for revoking
sessions *without* changing a password, but it is not needed to make a password
change effective.

**THE ONE-SECOND EDGE IS GONE.** This document used to record an honest
limitation: `iat` has whole-second granularity while `passwordChangedAt` is a
microsecond timestamp, so a token minted in the *same second* as the change
could not be ordered against it. The comparison resolved **fail-closed**, which
was the right choice of two wrong answers — it never let a compromised session
survive, but it *did* reject a legitimate login that landed in that second,
once, after which a retry succeeded. An integer compared for equality has no
such tie to break, so there is no window to document, no retry, and no
`awaitNextSecond()` in the tests.

**FOR A CLIENT.** Nothing changes in the request or response shape: the claim is
inside an httpOnly cookie that no browser code reads. What changes is that a
sign-in immediately after a password change now works on its **first** attempt.
A client that had a retry for that case can drop it; one that did not was
occasionally showing a spurious failure.

`passwordChangedAt` is still written and still returned on the admin user
detail — it is the "password last changed" fact an operator needs — but nothing
authorises on it any more.

Further verified administration facts a frontend must encode:

- **`/branch` responses are not nested under `data`.** `BranchController`
  returns the entity directly, so the interceptor **spreads** it:
  `{success, timeStamp, id, name, address, phone, …}`. It is the only family in
  the API that does this. `DELETE /branch/:id` also returns the removed entity
  **without `id`** (TypeORM strips the primary key on remove).
- **`DELETE /branch/:id` returns a generic 500 whenever the branch is in use.**
  `users.branchId` and `orders.branchId` are both `ON DELETE NO ACTION`. Reassign
  staff first, and accept that a branch that ever sold anything cannot be
  deleted. `PATCH /branch/:id` has no duplicate-name pre-check either, so a
  rename collision is also a 500.
- **`POST /users` and `PATCH /users/:id` return a generic 500 on a duplicate
  username** (no pre-check; the UNIQUE violation is untranslated). `POST
  /auth/register` *does* pre-check and answers 400. **Prefer `/auth/register`
  for a staff-creation form.**
- **`role` is documented optional and is required in effect** — the service
  throws `400 "User role is required"`. Swagger will mislead you.
- **`GET /users?role=` truncates each user's `roles` array** to the matched role
  and makes pagination unreliable (the filter is applied to the joined alias).
- **`PATCH /users/:id` with `role: [...]` replaces the whole role set** —
  sending `["sale"]` to a `["super_admin","sale"]` user silently strips
  super-admin. Use `POST /roles/assign` / `DELETE /roles/remove` for
  incremental changes; both take role **ids**, so fetch `GET /roles` first.
- **`DELETE /users/:id` has two outcomes** decided by a sales count no endpoint
  exposes: soft-deactivate if the user has orders, hard-delete otherwise. Read
  `data.softDeactivated` to find out which happened. Use
  `PATCH /users/:id/deactivate` for "retire this employee" instead.
- **`PATCH /users/:id/deactivate` is not idempotent** (second call is
  `400 "User is already deactivated"`); `activate` is. Treat that 400 as
  "already in the desired state".
- **Admin stock adjustment emits no realtime event.** Only POS sales and
  fulfilment emit `stock:updated`; a dashboard will not see manual corrections.
- **`POST /attributes` returns no created object** — no attribute id, no value
  ids. Re-fetch `GET /attributes` afterwards. Attribute **values are globally
  unique by string**, so `size: ["red"]` fails once `color: ["red"]` exists.
- **`PATCH /products/:id` replace-vs-merge**: `title`/`description`/`basePrice`
  merge; `categoryIds` and `images` **replace the whole set** (and `images: []`
  **deletes every attached image row**); `variants` is a **partial upsert** —
  an unmentioned variant is untouched, and `variants: []` is a silent no-op.
  `stock` on a variant **update** is rejected (`VARIANT_STOCK_NOT_UPDATABLE`);
  use the adjust endpoint.
- **`POST /products/uploadImage`**: multipart field `file`, **no mimetype check
  and no size limit**, buffered in memory. It returns a **detached** image row;
  attach it later via the `images` array. Enforce your own client-side limits.
- **Opening stock can bypass the ledger.** `POST /products` writes
  `variants[].stock` straight into the column with no `stock_movements` row —
  and `CreateVariantDto.stock` is **required**. Only the adjust endpoint writes
  the ledger. If an audit trail matters, create variants at 0 and stock them via
  the adjust endpoint.
- **The below-reserved refusal has two wire shapes**: 409 with
  `error: "STOCK_BELOW_RESERVED"` from the unlocked pre-check, or 400 with a
  different message from the authoritative locked check. Treat both as the same
  user-facing case, and offer `allowBelowReserved` as the override.
- **`CreateAddressDto.description` is accepted, validated and silently
  discarded** — there is no such column.
- **`POST /address` cannot create an address for another user**; it hard-codes
  the calling admin. Use `/address` for read-only lookup and in-place `PATCH`
  only, never `POST` on a customer's behalf, and avoid `DELETE` (it 500s on any
  address an order references).

### Administration endpoints that do not exist

- ~~**`GET /categories/:id` and `PATCH /categories/:id`**~~ — **RESOLVED for
  rename and delete.** `PATCH /categories/:id` (`categories.update`) renames a
  category, and `safeRemove` is now the ONLY delete, reachable at
  `DELETE /categories/:id` (`categories.delete`): it refuses a non-empty
  category with 409 `CATEGORY_IN_USE` and detaches nothing. The unconditional
  detach-and-delete route is gone. See §2.8.1. A single-category **read**
  (`GET /categories/:id`) still has no route; use `GET /categories/admin`
  (paginated, searchable, never cached) or the public `GET /categories`.
- **`isDefault` is absent from `AdminVariantView`**, so the admin UI cannot
  identify the default variant it is told to retire explicitly. Only
  `GET /inventory/lookup` exposes it, one SKU at a time.
- **No stock-ledger read endpoint.** `stock_movements` is the audit trail for
  every adjustment and no controller exposes it, so a "Variant & stock" screen
  cannot show history.
- **`GET /products/variants/:id`** does not exist.
- ~~**`GET /orders` for a super_admin returns every order in the system**~~ —
  **RESOLVED.** It is now one bounded page, server-side filtered, ordered
  `soldAt DESC, id DESC`, and projected to `AdminOrderRowView`
  rather than the order entity. Gated on the `orders.read` capability, not on a
  role name. The unbounded `OrdersService.findAll` that served it has been
  deleted.

> **One correction to the admin audit.** It reported that
> `GET /inventory/availability` "silently omits unknown ids". It does not — I
> verified this personally and it is asserted by a test: an unknown id fails the
> **whole request with 404**, naming the missing ids, because
> `computeAvailability` and `lockVariants` both throw and every consuming path
> must fail loudly. The audit read the file mid-edit.

---

## 8. Security hardening — new contract surface

Everything in this section is new behaviour a frontend must encode. All codes
arrive in the **top-level `error`** field (`global.exception.ts` promotes it);
supporting facts arrive under `details`.

### 8.1 Role administration — 409s replace silent damage

| Code | HTTP | Raised by | `details` |
|---|---|---|---|
| `ROLE_BUILTIN_PROTECTED` | 409 | `DELETE /roles/:id` for `super_admin`/`sale`/`site` | `roleName` |
| `ROLE_IN_USE` | 409 | `DELETE /roles/:id` when anyone holds it | `roleName`, `assignedUserCount` |
| `LAST_SUPER_ADMIN` | 409 | `DELETE /roles/remove`, `PATCH /users/:id` (role replacement), `DELETE /users/:id`, `PATCH /users/:id/deactivate` | `roleName`, `userId` |

Built-ins are matched by **name**, never by id, so this holds across
environments. `DELETE /roles/:id` can also now answer **404** where a racing
duplicate delete previously got a second 200.

The "last administrator" rule is about the last admin who **can still sign
in**: with one active and one deactivated `super_admin`, stripping the active
one is refused. A `PATCH /users/:id` refused this way rolls back **entirely** —
a username change in the same body is not applied either.

**The delete-role button is now safe to ship.** The server refuses; the UI no
longer has to hide it. Show `assignedUserCount` from `details` to explain why.

### 8.2 `POST /payment/verify` is owner-scoped

A `site` customer may verify only an attempt belonging to their own order.
A foreign attempt, an unknown `trackId`, and an attempt whose order no longer
exists all return the **same 404** with `error: "PAYMENT_ATTEMPT_NOT_FOUND"` —
byte-identical bodies, so `trackId`s cannot be probed. **This is a breaking
change: an unknown `trackId` used to be 400.** `super_admin` may verify any
attempt (explicit policy, so support can re-drive a stuck callback); `sale`
gets no exemption. Ownership comes from the access token only — a `userId` in
the body is rejected 400 by the global `ValidationPipe`.

Internal recovery (`POST /payment/admin/fulfilment/recover`) and
re-verification (`POST /payment/admin/reverify`) are unaffected: they call the
settlement layer directly and never impersonate a customer.

### 8.3 OTP

| Constant | Value |
|---|---|
Resend cooldown (per normalized mobile) | 60 s
Sends per mobile | 5 / hour
Sends per client IP | 20 / hour
Wrong guesses per challenge | 5
Code TTL | 120 s

- **`send-otp` no longer creates the account.** `verify-otp` does, on first
  success. A `users` row is no longer a side effect of an unproven request.
- **Enumeration-safe.** `send-otp` returns the identical 201 whether or not the
  number is registered — it never looks the user up at all. `verify-otp`
  returns one identical 401 `OTP_INVALID` for *no challenge*, *wrong code*,
  *expired code*, *attempts exhausted* and *replay*.
- **Consequence for the UI:** the client is never told "too many attempts",
  because telling it would leak to a third party hammering a number that
  someone is mid-login. **Offer "resend code" after any verification failure.**
- `retryAfterSeconds` is a **body field under `details`**, not a `Retry-After`
  header.
- Mobile numbers are normalized to `09XXXXXXXXX` before anything else happens.
  `09…`, `9…`, `+989…`, `00989…`, `989…`, spaces/hyphens/brackets and
  Persian/Arabic-Indic digits are all accepted. Nothing previously accepted is
  now rejected, and send and verify need not agree on formatting.

### 8.4 Inventory conflicts are 409, never 500

| Code | HTTP | `details` |
|---|---|---|
| `INSUFFICIENT_STOCK` | 409 | `variantId`, `sku`, `requested`, `available`, `retryable: true` |
| `INVENTORY_CONCURRENTLY_MODIFIED` | 409 | `entity` (`variant`/`reservation`/`cart_item`), `retryable: true` |

`POST /orders` previously answered a bare **500** when an accepted basket hold
turned out to have no physical stock behind it (reachable after a super-admin
stock correction made with `allowBelowReserved`). It now answers 409
`INSUFFICIENT_STOCK` with **no fresh quote** — the basket fingerprint still
matches, so re-quoting alone will not help and the client must reduce the line.

### 8.5 `GET /me/orders` is a bounded projection

Customer order responses are now explicit view models built by an
**allow-list**, so a future entity column cannot appear by default.

Exposed on an order: `id`, `orderNumber`, `channel`, `status`,
`fulfillmentState`, `paymentMethod`, `soldAt`, `paidAt`, `voidedAt`,
`refundedAt`, `subtotal`, `totalPrice`, `discountCode`, `addressSnapshot`,
`items`. Per item: `id`, `productId`, `variantId`, `productTitleSnapshot`,
`variantSkuSnapshot`, `attributesSnapshot`, `quantity`, `unitPrice`,
`totalPrice` — all from the immutable snapshot columns, so a later price change
never rewrites history.

**Removed** (breaking for any client that read them): `fulfillmentLastError`
and the three fulfilment-retry columns, `cashierUserId`,
`cashierDisplaySnapshot`, `branchId`, `branchNameSnapshot`, `userId`,
`customerId`, `addressId`, the live `address` relation, the nested `product`
object on each item, `paid_at`, `created_at`/`updated_at`, and
`addressSnapshot.backfilled`. **Renamed** to camelCase: `total_price` →
`totalPrice`, `discount_code` → `discountCode`, item `unit_price` →
`unitPrice`, item `total_price` → `totalPrice`. **Added**: `voidedAt`,
`refundedAt`.

Payment is **not projected at all**, so the reconciliation ledger cannot leak.
Payment state is served by `status` + `paidAt` + `paymentMethod`. If the
storefront needs a per-attempt payment history, that is a new endpoint and an
owner decision.

**`GET /me/orders` default page size is 10, not 20.** `PaginationDto` declares
`limit = 10` and the `ValidationPipe` substitutes it before the handler runs,
so the handler's `?? 20` is dead code.

---

## 8.6 The role model is FIXED — `POST /roles` has been removed

`POST /roles` no longer exists; the path answers **404**.

**Why.** `CreateRoleDto.name` carried `@IsEnum(UserRoleEnum)`, so the only names
it accepted were `super_admin`, `sale` and `site` — all three of which the
seeder creates on bootstrap. Every possible request therefore answered
**400 `This role already exists`**. It also contradicted `DELETE /roles/:id`,
which refuses those same three names with **409 `ROLE_BUILTIN_PROTECTED`**: the
API simultaneously advertised "you may invent roles" and "the only roles that
exist are structural and untouchable", and a client cannot implement both.

**What a frontend must change.** Remove any "create role" affordance. The role
picker is a fixed list of three values, read from `GET /roles`. A role NAME
grants nothing on its own — the guards are written against `UserRoleEnum` — so
adding a role is a backend code change, never an API call.

**Unchanged, and still the contract:**

| Route | Notes |
|---|---|
| `GET /roles` | the catalogue, always exactly the three built-ins |
| `GET /roles/users/:userId` | the roles one user holds |
| `POST /roles/assign` | ADDS one role; 201 |
| `DELETE /roles/remove` | body `{userId, roleId}`; 409 `LAST_SUPER_ADMIN` still protects the last administrator |
| `DELETE /roles/:id` | kept for a `roles` row inserted out of band. Against the shipped catalogue it can now only answer 409 `ROLE_BUILTIN_PROTECTED` or 404. `ROLE_IN_USE` and every locking guarantee are unchanged. |

---

## 8.7 Manual reconciliation queue (owner decision D-2)

The queue is where a `super_admin` resolves money that arrived but could not be
applied, and paid orders whose goods were never allocated. **Nothing in it is
automatic**: no refund, cancellation, back-order or write-off happens unless an
operator asks for it, with a reason.

### `GET /payment/admin/reconciliation`

Paginated. An order is a **case** when any of these holds:

| `caseTypes` member | Meaning |
|---|---|
| `unapplied_receipt` | a gateway-confirmed receipt nobody has closed |
| `fulfilment_incomplete` | `status=paid`, `fulfillmentState=pending` |
| `awaiting_stock` | `status=paid`, `fulfillmentState=awaiting_stock` |
| `operator_open` | an operator decision exists and is not closed |

Query: `page`, `limit`, `caseType`, `paymentStatus`, `orderStatus`,
`fulfillmentState`, `branchId`, `createdFrom`, `createdTo`, `resolved`.
Unknown query keys are **rejected with 400**, not ignored. **The default is
everything, resolved cases included** — an unresolved discrepancy must not be
able to hide behind a default filter. Use `resolved=false` for the working view.

Response `data`: `{ data[], total, page, limit, totalPages }`. Each row:

```
orderId, orderNumber, channel, orderStatus, fulfillmentState, branchId,
caseTypes[], reconciliationState, reconciliationResolvedAt,
fulfilmentAuthorized, paidAt, createdAt,
money: { orderTotal, confirmedHeld, confirmedUnapplied, refundedTotal,
         hasAmountDiscrepancy }
```

**`orderId` IS the case id.** **Every `money.*` figure is a STRING of integer
Rial** — they are `bigint` columns and parsing them into a JavaScript `Number`
is silent data loss past 2^53. `confirmedHeld` and `refundedTotal` are disjoint
buckets, so nothing is counted twice; `confirmedUnapplied` is the provisional
subset of `confirmedHeld`. `fulfilmentAuthorized: false` on a paid, unfulfilled
order means no receipt authorizes shipping it.

### `GET /payment/admin/reconciliation/:orderId`

The same row plus `customer {userId, customerId, mobile, displayName}`,
`receipts[]`, `authorizationClauses[]`, `stock{}`, `actions[]` (the append-only
audit, oldest first) and **`allowedActions[]`** — the mutations the server will
honour from the current state, for rendering buttons.

`receipts[]` per row: `id`, `status`, `amount`, `gatewayAmount`,
`gatewayAmountRaw`, `refNumber`, `requiresReconciliation`,
`reconciliationReason`, `reconciledAt`, `paidAt`, `createdAt`. **The gateway
SESSION id (`track_id`) is never exposed** — it is itself the credential
`POST /payment/verify` accepts. Nor are the re-verification worker's columns or
`orders.fulfillmentLastError`.

`authorizationClauses[]` is the fulfilment claim's own diagnosis per receipt:
`paymentId`, `isSuccess`, `hasGatewayAmount`, `gatewayMatchesAmount`,
`amountMatchesOrder`, `reasonResolved`, `qualifies`.

404 `RECONCILIATION_CASE_NOT_FOUND` when the order does not exist or has
nothing outstanding.

### The five mutations

All `super_admin`, all `POST`, all **200 (not 201)**, all requiring a
**mandatory `Idempotency-Key` header** (one client-generated UUIDv4 per
decision, resent verbatim on retry — operators never type it) and a
**mandatory `reason`** of at least 4 characters.

| Path suffix | Body | What it does |
|---|---|---|
| `/retry-fulfilment` | `{reason}` | re-drives phase 2 through the UNCHANGED fulfilment boundary. Read `fulfilled` and `blocked` — `blocked: "reconciliation_required"` means nothing was consumed. |
| `/mark-refund-required` | `{reason, expectedAmount?}` | **records an obligation; refunds nothing.** No payment row, order status or stock changes. Stays in the queue. |
| `/confirm-refund` | `{reason, paymentId, amount, externalReference}` | **reports a refund already completed with the provider.** |
| `/mark-backorder` | `{reason}` | explicit decision to wait for stock. No stock consumed. Stays in the queue. |
| `/resolve` | `{reason, resolutionType}` | closes with no financial action. `resolutionType` ∈ `no_discrepancy`, `settled_externally`, `customer_agreed`, `gateway_duplicate`. |

Response `data` for all five: `{orderId, action, actionId, orderStatus,
fulfillmentState, reconciliationState, message}` plus `fulfilled`/`blocked` on
retry and `stockRestored` on refund confirmation.

**`/confirm-refund` in detail.** The named receipt becomes `refunded` and gets a
`reconciled_at`; `amount`, `gateway_amount`, `gateway_amount_raw`, `ref_number`
and `paid_at` are **never** rewritten. The ORDER becomes `refunded` with a
`refundedAt` **only if the refunded receipt was the settling one** — refunding a
`confirmed_unapplied` duplicate leaves the order alone. **Inventory is restored
only where a real prior consumption exists** (derived from `stock_movements`);
otherwise `stockRestored: false` and nothing is invented.

### Error codes (branch on `error`, never on `message`)

| Code | Status | When |
|---|---|---|
| `RECONCILIATION_CASE_NOT_FOUND` | 404 | no such order, or nothing outstanding and no decision recorded |
| `RECONCILIATION_ALREADY_RESOLVED` | 409 | the case is `refund_confirmed` or `resolved` |
| `REFUND_ALREADY_CONFIRMED` | 409 | that receipt is already `refunded` |
| `REFUND_PENDING_CONFIRMATION` | 409 | `/resolve` on a case marked `refund_required` |
| `PAYMENT_NOT_ON_ORDER` | 404 | `paymentId` belongs to another order |
| `PAYMENT_NOT_REFUNDABLE` | 409 | the gateway never confirmed that attempt |
| `REFUND_AMOUNT_INVALID` | 400 | amount ≤ 0, or above the largest recorded figure |
| `ORDER_NOT_RETRYABLE` | 409 | not `paid` + `pending`/`awaiting_stock` |
| `ORDER_NOT_BACKORDERABLE` | 409 | same |
| `IDEMPOTENCY_KEY_REQUIRED` / `IDEMPOTENCY_KEY_INVALID` | 400 | header missing / malformed |
| `IDEMPOTENCY_KEY_REUSED` / `IDEMPOTENCY_REQUEST_IN_PROGRESS` | 409 | under `details.code` |

A **refused** decision releases its key, so the SAME key may be retried once the
request is fixed. An identical retry of a **succeeded** decision replays the
stored response and writes no second audit row.

### What the CUSTOMER sees

`GET /me/orders` / `GET /me/orders/:id` gain one field:

```
reviewState: "under_review" | "refund_in_progress" | null
```

- `under_review` — *payment received; this order requires review.* Shown while
  the case is `open` / `backordered`, and for a paid order stuck in
  `awaiting_stock`.
- `refund_in_progress` — a refund has been arranged and is being processed. It
  does **not** claim a refund completed.
- `null` once the case is resolved — a completed refund is reported honestly by
  `status: "refunded"` plus `refundedAt`.

No operator reason, gateway reference, amount or internal error text ever
reaches this projection. The customer allow-list is otherwise unchanged.

### Realtime

Reconciliation mutations emit `order.status.updated` to **admins + the owning
branch** (`emitOrderEvent`) and to **the owning customer's own room**
(`emitToUser`, payload `{orderId, status, fulfillmentState}` only). There is no
global broadcast on any reconciliation path.
