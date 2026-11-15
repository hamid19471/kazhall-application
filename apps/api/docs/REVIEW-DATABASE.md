# Local PostgreSQL for Independent Review

This document is the handoff for a supervising developer who needs to inspect
the database and run the integration suite **without Docker socket access**.

Everything below was executed and verified on this machine. The final section
states exactly what that verification does and does not prove.

---

## 1. Why an override exists

The project ships `apps/api/docker-compose.yml`, which publishes PostgreSQL on
`5432`, Redis on `6379` and MinIO on `9000/9001`, on all interfaces. On this
machine every one of those ports is already taken:

| Port | Held by | Nature |
|---|---|---|
| 5432 | native Homebrew `postgresql@17` (pid 742) | **the developer's own data** |
| 6379 | native Homebrew `redis-server` (pid 734) | developer's own |
| 9000 / 9001 | container `karinmed-minio` | an **unrelated** project |

`docker compose up` against the base file alone therefore fails on all three
bindings, and the fix must never be to stop somebody else's service or to
reuse the developer's database. So the base file is used **unmodified**, with a
narrow override on top:

* `apps/api/docker-compose.review.yml` — remaps every port to a free number
  **bound to `127.0.0.1`**, renames the containers, sets throwaway credentials,
  and mounts the disposable-server marker script.
* Compose project name **`kazhal-review`** — named volumes are namespaced per
  project, so this stack's data lives in `kazhal-review_postgres-data` and can
  never touch, reuse, or be confused with any other stack's volume.

No pre-existing `kazhal*` volume existed before this stack was created, so no
developer data was adopted, reused, or reset. `docker compose down -v` was
never run, and no unrelated container was stopped.

---

## 2. The running review stack

```
Compose project : kazhal-review
Compose files   : /Users/hamidasadi/Downloads/kazhal/apps/api/docker-compose.yml
                  /Users/hamidasadi/Downloads/kazhal/apps/api/docker-compose.review.yml
```

| Service | Container | Published (loopback only) |
|---|---|---|
| `postgres` | `kazhal-review-postgres` | `127.0.0.1:55433` → 5432 |
| `redis` | `kazhal-review-redis` | `127.0.0.1:56379` → 6379 |
| `minio` | `kazhal-review-minio` | `127.0.0.1:59000`, `127.0.0.1:59001` |

**PostgreSQL connection (throwaway local credentials — not production, not reused):**

```
host      127.0.0.1
port      55433
user      kazhal_review
password  kazhal_review_local_only
database  kazhal_review          (maintenance database)
```

Start / check the stack:

```bash
cd /Users/hamidasadi/Downloads/kazhal/apps/api
docker compose -p kazhal-review -f docker-compose.yml -f docker-compose.review.yml up -d
docker compose -p kazhal-review -f docker-compose.yml -f docker-compose.review.yml ps
```

**Safe stop — preserves all data** (stops containers, keeps volumes):

```bash
cd /Users/hamidasadi/Downloads/kazhal/apps/api
docker compose -p kazhal-review -f docker-compose.yml -f docker-compose.review.yml stop
```

To remove the containers but still keep the data, use `down` **without** `-v`.
**Never run `down -v`** — that deletes `kazhal-review_postgres-data`.

---

## 3. Connection config (gitignored)

```
/Users/hamidasadi/Downloads/kazhal/apps/api/.env.review.local
```

Mode `0600`, ignored via `.gitignore:15`. It holds only throwaway local
credentials for the loopback-bound disposable server. Verify it is ignored:

```bash
cd /Users/hamidasadi/Downloads/kazhal && git check-ignore -v apps/api/.env.review.local
```

The file supplies the **connection**. It deliberately cannot supply the
**mode** — see §5.

---

## 4. Verifying the connection

`psql` is not on the default `PATH` on this machine; it ships with the
Homebrew PostgreSQL formula:

```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
```

**Host-side SQL verification, no Docker involved:**

```bash
PGPASSWORD=kazhal_review_local_only \
  psql -h 127.0.0.1 -p 55433 -U kazhal_review -d kazhal_review \
  -c "SELECT current_database(), inet_server_port(), version();" \
  -c "SELECT * FROM public.kazhal_disposable_test_server;" \
  -c "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1;"
```

For comparison, readiness **through Docker**:

```bash
docker exec kazhal-review-postgres pg_isready -U kazhal_review -d kazhal_review
```

The two paths are independent: the first needs only a TCP socket on
`127.0.0.1:55433`, the second needs the Docker socket.

---

## 5. Running the integration suite against this server

The harness has two provisioning modes, selected by `KAZHAL_INT_PG_MODE`.

### `docker` — the default, unchanged

```bash
cd /Users/hamidasadi/Downloads/kazhal/apps/api
pnpm run test:int
```

Starts its own throwaway `postgres:17-alpine` container on a random free port
and removes it on teardown. This is the pre-existing behaviour and is fully
preserved.

### `external` — for a reviewer with no Docker socket access

```bash
cd /Users/hamidasadi/Downloads/kazhal/apps/api
pnpm run test:int:external
```

Single file:

```bash
cd /Users/hamidasadi/Downloads/kazhal/apps/api
KAZHAL_INT_PG_MODE=external \
  pnpm exec jest --config ./test/jest-integration.json --runInBand \
  test/integration/smoke.int-spec.ts
```

Keep the run's database afterwards for inspection instead of dropping it:

```bash
KAZHAL_INT_PG_MODE=external KAZHAL_INT_KEEP_DB=1 pnpm run test:int:external
```

**Isolation.** Each run creates its own database `kazhal_int_<runId>` on the
review server, applies every migration to it, and drops **only that database**
on teardown. Nothing is shared between runs; `resetDb()`'s `TRUNCATE` can only
ever reach tables inside the run's own database. The review server's own
`kazhal_review` maintenance database is used solely to issue `CREATE DATABASE`
and `DROP DATABASE`; no test ever runs against it.

**Teardown never touches containers.** External-mode teardown drops one
database and closes its connection. It issues no `docker` command at all, so an
externally managed stack is never stopped, removed, or inspected by the suite.

**Fail-closed.** External mode refuses to run unless the target server carries
the marker table `public.kazhal_disposable_test_server` holding the token
`kazhal-disposable-review-server`. That marker is planted once, by
`apps/api/docker/review-initdb/00-disposable-marker.sql`, when a review
server's data directory is first initialised. The check is deliberately
**server-side**: an environment variable travels with the client and can be set
by accident, whereas this marker only exists on a server that was built to be
thrown away. It aborts before a single DDL statement.

Two further guards:

* The mode is read **only** from a real environment variable, never from
  `.env.review.local`. A file on disk must never be able to silently redirect
  `pnpm test:int` at a shared server.
* Every database name is generated by the harness and matched against
  `/^kazhal_int_[a-z0-9_]{1,40}$/` — checked before `CREATE` and **again**
  before `DROP`, so a hand-edited state file cannot aim the drop elsewhere.

A fully migrated database has been **left in place for inspection**:

```
kazhal_int_m36_25c92da3
```

It holds the complete schema after all 15 migrations — 24 application tables
plus the `migrations` bookkeeping table — with tables emptied by the suite's own
`resetDb()`. Connect to it directly:

```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
PGPASSWORD=kazhal_review_local_only \
  psql -h 127.0.0.1 -p 55433 -U kazhal_review -d kazhal_int_m36_25c92da3 \
  -c "\dt" \
  -c "SELECT name FROM migrations ORDER BY timestamp;"
```

Drop it when you are done:

```bash
PGPASSWORD=kazhal_review_local_only \
  psql -h 127.0.0.1 -p 55433 -U kazhal_review -d kazhal_review \
  -c 'DROP DATABASE "kazhal_int_m36_25c92da3";'
```

Any other `kazhal_int_*` database is a leak from an interrupted run and is safe
to drop the same way. A normal run leaves none.

---

## 6. Evidence that Docker socket access is unnecessary in external mode

External mode was run with a fake `docker` executable placed **first on `PATH`**,
which logs any invocation and exits non-zero with a permission-denied message —
i.e. it simulates exactly the failure the supervising developer hit:

```
$ env PATH="$SHIM_DIR:$PATH" DOCKER_SHIM_LOG=... \
    KAZHAL_INT_PG_MODE=external KAZHAL_INT_KEEP_DB=1 \
    pnpm exec jest --config ./test/jest-integration.json --runInBand \
    test/integration/smoke.int-spec.ts test/integration/checkout.int-spec.ts

[int] run m36-25c92da3: PostgreSQL ready on 127.0.0.1:55433 — EXTERNAL server
      (no docker involved), database kazhal_int_m36_25c92da3
Test Suites: 2 passed, 2 total
Tests:       21 passed, 21 total
[int] run m36-25c92da3: KAZHAL_INT_KEEP_DB=1 — KEEPING database kazhal_int_m36_25c92da3.

docker shim invocation count: 0
```

**Zero invocations.** External mode never executed `docker` at all — not to
start anything, not to inspect anything, not on teardown — so a denied Docker
socket cannot affect it.

The **full** suite also passes against this server (with `docker` available but
unused by the external path):

```
$ pnpm run test:int:external
[int] run log-e1d7a68b: PostgreSQL ready on 127.0.0.1:55433 — EXTERNAL server
      (no docker involved), database kazhal_int_log_e1d7a68b
Test Suites: 26 passed, 26 total
Tests:       264 passed, 264 total
[int] run log-e1d7a68b: dropped database kazhal_int_log_e1d7a68b
      (external server left running)
```

The **fail-closed gate** was exercised by pointing external mode at an
**unmarked** database (`.../postgres`) on the same server:

```
Error: Jest: Got error running globalSetup ... reason: REFUSING TO RUN.
The PostgreSQL named by KAZHAL_INT_PG_ADMIN_URL does not carry the
disposable-test-server marker (table public.kazhal_disposable_test_server).
```

No database was created on that target.

The **docker mode is unchanged and still works**, verified separately:

```
$ pnpm run test:int
[int] run l05-2f38a8fd: PostgreSQL ready on 127.0.0.1:55217 —
      self-provisioned postgres:17-alpine container 9ef009e08a4b
Test Suites: 26 passed, 26 total
Tests:       264 passed, 264 total
[int] run l05-2f38a8fd: removed container 9ef009e08a4b
```

---

## 7. What this does NOT prove

**Host-side verification from the implementing environment does not prove the
supervising developer's sandbox can connect.** The checks above ran as the
local user on this host. A reviewer's sandbox may have its own network
namespace, its own loopback, or an egress policy — any of which can block
`127.0.0.1:55433` even though the port is published and working here.

Independent verification from the reviewer's own environment is still required.
Run §4's `psql` command and §5's `test:int:external` from *inside* the review
sandbox. If the `psql` command cannot connect, the blocker is network reachability
between the sandbox and the host loopback, not the database — say so rather than
assuming the stack is down, and confirm with §2's `ps` command.

Nothing here required, requested, or performed any weakening of host security:
the Docker socket was not `chmod`-ed, no unauthenticated Docker TCP API was
enabled, and no authentication or TLS protection was disabled.
