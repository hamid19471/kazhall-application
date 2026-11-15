# Development / review seed

`DEVELOPMENT / REVIEW ONLY — NEVER USE IN PRODUCTION`

A deterministic, idempotent dataset that fills every implemented journey with
reviewable data: catalogue, customers, carts with live four-hour reservations,
sales on both channels, reversals, the payment reconciliation queue, and enough
dated history for the reports to mean something.

## Commands

Start the disposable review stack first — the seeder will not run without it:

```bash
# from the repo root (the canonical `kazhal-review` Compose project)
pnpm infra:up

# from apps/api — migrate, then seed
pnpm migration:run
KAZHAL_ALLOW_DEV_SEED=true pnpm seed:dev

# DESTRUCTIVE: empty every table and re-seed
KAZHAL_ALLOW_DEV_SEED=true pnpm seed:dev:reset -- --yes
```

The review stack publishes PostgreSQL on `127.0.0.1:55433` with database
`kazhal_review`, user `kazhal_review`. Point `apps/api/.env` at it:

```
DB_HOST=127.0.0.1
DB_PORT=55433
DB_USERNAME=kazhal_review
DB_DATABASE=kazhal_review
KAZHAL_ALLOW_DEV_SEED=true
```

`pnpm seed:dev` never deletes anything. The only command that can lose data is
`seed:dev:reset`, and it needs BOTH the opt-in and `--yes`.

Each command prints its target before writing — host, port, database and user,
never a password:

```
Target: 127.0.0.1:55433/kazhal_review as kazhal_review (NODE_ENV=development)
```

## Safety rules — fail closed

The seeder refuses unless it has POSITIVE evidence the target is disposable.
It does not infer permission from the absence of a danger signal.

| Rule | Behaviour |
| --- | --- |
| **Explicit opt-in** | `KAZHAL_ALLOW_DEV_SEED=true` is required by every dev-seed command. Absent, empty, `false`, `1`, `TRUE` or anything else → refused, before any connection |
| **Production refused** | `NODE_ENV=production` aborts before a connection is opened |
| **Unset NODE_ENV is not consent** | An unset `NODE_ENV` authorises nothing. It is reported as `NODE_ENV=unset`, never silently read as "development" |
| **Disposable marker required** | The target database must carry table `kazhal_disposable_test_server` holding token `kazhal-disposable-review-server`. Checked **after connecting and before the first write or TRUNCATE** |
| **Marker failures fail closed** | Table missing, no row, wrong token, malformed row, or an unreadable query → refused. An unreadable marker is not a present one |
| **Production-looking names** | `DB_DATABASE` matching `prod`/`production`/`live` is refused as belt-and-braces — but a plain name like `kazhal` is NOT treated as safe; the marker decides |
| **Destructive reset** | Needs the opt-in **and** `--yes`. Neither implies the other |
| **No escape hatch** | There is no force flag, no bypass and no production override. If it refuses, point it at a review database |
| **Nothing secret is printed** | Host, port, database and username only — no passwords, tokens, hashes, cookies, JWT secrets or OTP codes |
| **Schema must be current** | Aborts if any migration is pending |
| **No live external services** | No gateway, no refund endpoint, no SMS. Redis is touched only to invalidate the catalogue cache, and failing to reach it is a warning |
| **Source is untouched** | The commands only write to the database |

Why two independent proofs? `KAZHAL_ALLOW_DEV_SEED` travels with the CLIENT and
states intent. The marker table travels with the SERVER — it is planted only by
`docker/review-initdb/00-disposable-marker.sql` when a throwaway PostgreSQL is
first initialised, so it cannot be set by accident from a shell. A real
database would have to satisfy both.

Covered by unit tests in `src/database/seeder/dev/dev-seed.guard.spec.ts`,
including one that proves a refusal issues nothing but a `SELECT` — so a
refused run cannot have mutated anything.

## Which database does it target?

The review stack from `apps/api/docker-compose.review.yml`:

```bash
pnpm infra:up    # scripts/infra.sh: the kazhal-review project, from the repo root
```

That publishes PostgreSQL on `127.0.0.1:55433` and stamps the server with the
`kazhal_disposable_test_server` marker table. `apps/api/.env` points at
`kazhal_ws_c` on that server. Nothing in the seed path can reach a database the
`DB_*` variables do not name, and the target is echoed on every run — so
"which database did this hit" is never a guess.

## Refreshing the dataset

| You want | Run |
| --- | --- |
| Top up after a schema or catalogue change | `pnpm seed:dev` |
| Undo your own poking and start clean | `pnpm seed:dev:reset -- --yes` |
| Rebuild the schema from scratch too | drop the database, `pnpm migration:run`, then `pnpm seed:dev` |

## Idempotency

Every object is addressed by a natural key: role name, branch name, username,
category title, attribute name, SKU, order number. A second run finds all of
them and creates nothing — verified by running it twice and comparing counts.

Catalogue **facts** are the opposite: price, active/default flags, the product
and variant codes and the two visibility columns are rewritten on every run,
because `dev-seed.data.ts` is their source of truth and a re-run is how a
corrected data file reaches an already-seeded database. The branch selections
are rewritten the same way — delete every row for the product, insert the
wanted set — so a mode that was widened or narrowed between runs cannot leave
orphaned selections behind. The row set and the count come out identical each
time; only the `created` column counts the re-inserts, and the seed report says
so in its notes.

Two things are written once and then deliberately left alone:

- **`product_variants.stock`** is set only when the variant is created. Seeded
  sales have since drawn it down and `stock_movements.balanceAfter` records
  those draws; resetting it would leave the ledger describing a history that no
  longer adds up.
- **An order whose `orderNumber` exists is skipped whole** — items, payment and
  stock consumption included. Re-running a sale would consume stock twice for a
  sale that happened once.

Passwords ARE refreshed on every run, so the documented credentials always work
even if a reviewer changed one.

## Dates

Relative, anchored to local midnight in `Asia/Tehran` (the zone
`ReportsService` reports in), so "today's sales" means the same thing to the
seed and to the report. Orders are spread across today, yesterday, and 3, 4, 5,
6, 8, 10 and 40 days back. Every seeded sale is clamped to the past — a sale is
never stamped later than the moment it was written.

This does not weaken idempotency: orders are matched by `orderNumber`, never by
date, so a run on a later day moves nothing.

## Credentials

`DEVELOPMENT / REVIEW ONLY — NEVER USE IN PRODUCTION`

Every account uses the password **`Kazhal!Dev2026`**.

| Username | Role | Branch | Use it to review |
| --- | --- | --- | --- |
| `dev_superadmin` | `super_admin` | Main (Sanandaj) | Everything: admin, reports, reconciliation, and POS. Reports are reachable ONLY from the admin console — the same account signed in at the till is refused `/reports/*` at the audience layer |
| `dev_admin_nobranch` | `super_admin` | — | Admin and reports work with no branch at all — reporting is whole-business and never branch-scoped; POS selling is refused (no branch) |
| `dev_cashier1` | `sale` | Main (Sanandaj) | POS selling; the original seller on most sales |
| `dev_cashier2` | `sale` | Main (Sanandaj) | Second seller; the actor who voided and returned cashier 1's sales |
| `dev_cashier_marivan` | `sale` | Marivan | Branch scoping on the catalogue and the till. Reporting is refused outright, branch or no branch |
| `dev_customer1` | `site` | — | Cart with live reservations, 2 addresses, online orders |
| `dev_customer2` | `site` | — | Separate addresses and orders; proves cross-customer isolation |
| `dev_disabled` | `sale` | Main (Sanandaj) | Access control — every request fails `401 ACCOUNT_DEACTIVATED` |

Mobiles are `09000000001`–`09000000008`, in order. The `0900` prefix is
unassigned in Iran, so no review account can collide with a real number.

### Sign-in URLs

| Surface | URL |
| --- | --- |
| Web — customer | `http://localhost:8001/auth/sign-in` |
| Web — admin | `http://localhost:8001/admin` |
| Store — POS | `http://localhost:8002/login` |

### Sign-in, stated plainly

**Production customer authentication is OTP-only and stays that way.**

| Surface | How you sign in |
| --- | --- |
| Web — admin (`/admin/login`) | Username + password, the real `POST /auth/admin/login`. Requires the `admin.access` permission (which `super_admin` carries) |
| Store — POS (`/login`) | Username + password, the real `POST /auth/pos/login`. Requires the `pos.access` permission (`sale`, and `super_admin`). The till sells; it has no reporting screen — sales reports are the main administrator's, in the web admin console |
| Web — customer (`/auth/sign-in`) | OTP in production. A **review-only** password form appears when, and only when, the conditions below hold |

The storefront's review-only password form is gated twice:

1. `NODE_ENV !== "production"` — Next inlines this at BUILD time, so a
   production bundle has the branch compiled out entirely and it cannot be
   switched on later by setting a variable on a running server.
2. `NEXT_PUBLIC_ENABLE_REVIEW_LOGIN=true` — unset by default, and in no
   committed env file.

```bash
# from apps/web — review only, never in a production deployment
NEXT_PUBLIC_ENABLE_REVIEW_LOGIN=true pnpm dev
```

It is not a bypass: it posts `POST /auth/storefront/review-login`, the storefront
audience's password door, against accounts that genuinely hold a password, and
the server applies exactly the same checks staff logins get. The server-side gate
is independent of the Next build flag: the route answers **403** unless
`NODE_ENV !== 'production'` **and** `KAZHAL_ENABLE_REVIEW_LOGIN=true` on the API. It exists only because no SMS provider has been supplied, so
no reviewer can receive a code. **Delete it the day one is.**

Nothing here weakens OTP. No bypass endpoint was added, no code is returned by
any API, no code is logged, and the rate limits, hashing and one-time
consumption are untouched.

**Production OTP remains `BLOCKED — SMS provider and credentials have not been
supplied.`** The only `OtpSender` implementation discards the code, so no
customer can receive one outside development.

## What gets seeded

| | |
| --- | --- |
| Roles | `super_admin`, `sale`, `site` (the fixed built-ins) |
| Branches | 3 — Sanandaj main shop, Marivan shop, central warehouse |
| Users | 8 (see the table above) |
| Categories | 12 Persian outdoor-equipment categories |
| Attributes | 5 (رنگ، سایز، ظرفیت، وزن، جنس) with 29 values |
| Products | 27, with 37 variants |
| Channel visibility | all 6 owner cases (see below), with 2 `product_branch_visibility` rows |
| Addresses | 4, across 4 cities |
| Carts | 6 lines with 7 reservation tranches |
| Orders | 18 — 8 POS, 10 online |
| Payments | 19, plus 5 reconciliation action records |

### Schema limits this seed does not paper over

- **Categories are flat.** `categories` has `id` and `title` and nothing else —
  no slug, no parent. The hierarchy the brief describes cannot be expressed
  without a schema change, so the 12 categories are a flat set.
- **A warehouse is not a branch type.** `branches` has only `name`, `address`
  and `phone`. The third branch is a real branch row whose role is conveyed by
  its name alone; no API treats it differently.
- **Addresses have no recipient-name column and no default flag.** The
  recipient's name is carried inside the free-text `address` line. "Default
  address" cannot be represented.
- **Products have no `isActive`.** Only variants do, so the one retired product
  is expressed as a product whose every variant is inactive.
- **Product images are empty.** There is no safe local seed asset and copying
  images from a live site would be a licensing problem, so every product falls
  back to the application's own placeholder. Product media remains a content
  task.

### Catalogue states covered

Multi-variant products, variant-specific prices, base-price inheritance
(3 variants with a `NULL` price), an inactive product, 2 out-of-stock variants,
5 low-stock variants (1–5 units), and deep stock for concurrency testing.

No sellable variant is free: every active variant resolves to a positive
integer-Rial price, and zero is never used as an inheritance signal.

### Channel visibility — all six cases, one product each

`visibleOnSite` (website) and `branchVisibility` (tills) are two **independent**
dimensions, so the six cases the owner asked for are their product, not six
values of one field. Each is demonstrated by exactly one seeded product; every
other product is website + all branches, so the existing review flows are
unchanged.

| Case | Product | Code | `visibleOnSite` | Branch mode | Branches |
| --- | --- | --- | --- | --- | --- |
| Website only | چادر خانوادگی ۴ نفره مدل دشت | `KZ-P-900002` | `true` | `none` | — |
| All retail branches only | کفش کوهنوردی ساق‌بلند ضدآب | `KZ-P-900016` | `false` | `all` | every branch, including future ones |
| Selected branches only | طناب دینامیک کوهنوردی ۵۰ متری | `KZ-P-900019` | `false` | `selected` | فروشگاه مرکزی کژال — سنندج |
| Website + all branches («همه کانال‌ها») | the other 22 products | `KZ-P-9000xx` | `true` | `all` | every branch |
| Website + selected branches | کوله روزانه ۳۰ لیتری مدل سیروان | `KZ-P-900004` | `true` | `selected` | شعبه کژال — مریوان |
| Hidden / draft | چادر سقفی خودرو (مدل بازنشسته) | `KZ-P-900027` | `false` | `none` | — |

**Stock is global — branch selection controls visibility only, not inventory.**
`product_variants.stock` stays one number per variant. Selecting a branch says
*where the product may be sold from*; every listed branch still sells out of
that same single quantity, and two branches racing for the last unit resolve
exactly as two cashiers in one branch do. There is no per-branch stock anywhere
in this dataset, and none in the schema.

**The two `selected` products point at different branches on purpose**, so
branch filtering is provable in both directions with the seeded accounts:

| Signed in as | Branch | Sees `KZ-P-900019` | Sees `KZ-P-900004` |
| --- | --- | --- | --- |
| `dev_cashier1`, `dev_cashier2` | Main (Sanandaj) | yes | **no** |
| `dev_cashier_marivan` | Marivan | **no** | yes |

Neither `KZ-P-900019` (not on the site) nor `KZ-P-900016` (not on the site) may
appear in any storefront listing, detail page, search result or cart, and
`KZ-P-900027` appears nowhere at all while still resolving by id for the admin
console.

None of the five special-case products appears in a seeded order or a seeded
cart line. That is deliberate: a seeded POS sale from a branch the catalogue
says cannot sell the product would be a history the running application could
not have produced. A check on the seeded database confirms it — every POS order
line is sellable in the branch that sold it, and every online order line and
cart line is on the website.

#### Product and variant codes

Every product carries a fixed, hand-written «کد محصول» in the reserved
`KZ-P-9000xx` block, and every variant a «کد گونه» that begins with its
parent's, e.g. `KZ-P-900001` → `KZ-P-900001-V000001`, `-V000002`.

**The code generator is never called by the seed.** `product_code_seq` advances
on every `nextval` whether or not the transaction commits, so a generated code
would differ between the first run and the second and the seeder could no
longer recognise the row it wrote. The 9xxxxx block keeps the generated
*format* while sitting far out of the sequence's reach — a freshly seeded
database hands out `KZ-P-000028` next — so a hand-written seed code and a code
the application generates cannot collide.

`sku` is untouched: the SKU is the warehouse's string, the code is the store's.

### Cart and reservation states covered

All produced by the real `InventoryService`, never by hand-written rows:

- a plain hold at the full four-hour TTL;
- one cart line backed by **two tranches** with independent expiry times;
- a line about **twelve minutes from expiry**;
- a line **partially displaced** by a counter sale, carrying the
  `sold_in_store` notice;
- a line whose hold **already expired**, carrying `reservation_expired`.

### Reconciliation cases covered

Amount mismatch, confirmed-but-unapplied, refund required, refund externally
confirmed, backordered, resolved, awaiting-stock fulfilment, and a duplicate
confirmation — the last one landing as a second `confirmed_unapplied` receipt,
because `uq_payment_one_success_per_order` allows only one success per order.

Every operator decision is recorded in the append-only `payment_actions` table.
No gateway and no refund endpoint is ever called.

## Catalogue cache

The list endpoints are version-keyed in Redis. Because the seeder writes to
PostgreSQL directly, it bumps the catalogue cache versions through the
application's own `CacheService` when it finishes. Without that, a Redis still
warm from before the seed serves the old catalogue and `GET /categories`
answers with an empty list next to a full product list — observed, not
theorised. If Redis is unreachable the seed still succeeds and says so.
