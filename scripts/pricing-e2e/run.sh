#!/bin/sh
# Disposable database + services for pricing browser / end-to-end tests
# (docs/MONTHLY-PRICING.md §10). Never touches the shared `kazhal_review`
# database, the shared dev services (8000/8001/8002) or Redis database 0.
#
#   sh scripts/pricing-e2e/run.sh up       create a uniquely named database in the
#                                          existing kazhal-review PostgreSQL, migrate,
#                                          seed the journey's minimum, start API/Web/POS
#                                          on 18000/18001/18002
#   sh scripts/pricing-e2e/run.sh status   print the run's state (no secrets)
#   sh scripts/pricing-e2e/run.sh down     stop only those services, drop only that
#                                          database, clear only Redis database 15
#   sh scripts/pricing-e2e/run.sh check-redis-target <db> <container>
#                                          the pure guard 'down' applies before
#                                          FLUSHDB (exit 0 = allowed); used by
#                                          scripts/pricing-e2e/run.test.sh
#
# It uses the existing `kazhal-review` containers (no new Compose project) and
# `docker exec` for the two statements that need them: CREATE / DROP DATABASE.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
STATE_DIR=${PRICING_E2E_STATE_DIR:-${TMPDIR:-/tmp}/kazhal-pricing-e2e}
STATE="$STATE_DIR/state.env"
# The configured constants. Values read back from the state file always get a
# STATE_ prefix, so a recorded value can never overwrite what it is checked against.
readonly PG_CONTAINER=kazhal-review-postgres
readonly EXPECTED_REDIS_CONTAINER=kazhal-review-redis
readonly EXPECTED_REDIS_DB=15
readonly API_PORT=18000
readonly WEB_PORT=18001
readonly POS_PORT=18002
readonly DIST=.next-pricing-e2e
readonly NAME_PATTERN='^kazhal_pricing_e2e_[0-9]+_[0-9]+$'

psql_admin() { # run SQL against the server's maintenance database
  docker exec -i "$PG_CONTAINER" sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -At'
}

port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

wait_http() { # url, seconds
  i=0
  while [ "$i" -lt "$2" ]; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$1" || true)
    case "$code" in 2*|3*) return 0 ;; esac
    i=$((i + 1)); sleep 1
  done
  echo "timed out waiting for $1" >&2; return 1
}

save() { printf '%s=%s\n' "$1" "$2" >> "$STATE"; }

# state_get KEY: the value recorded for KEY, read as data (the file is never
# sourced). Empty when KEY is missing or recorded more than once.
state_get() {
  [ "$(grep -c "^$1=" "$STATE" || true)" = "1" ] || return 0
  sed -n "s/^$1=//p" "$STATE"
}

# redis_target_ok DB CONTAINER: the only Redis target 'down' may FLUSHDB.
# Pure — no I/O — so run.test.sh can exercise every refusal.
redis_target_ok() {
  case "$1" in
    '') echo "refusing to clear Redis: no database is recorded" >&2; return 1 ;;
    *[!0-9]*) echo "refusing to clear Redis: recorded database '$1' is not a decimal number" >&2; return 1 ;;
  esac
  if [ "$1" = "0" ]; then echo "refusing to clear Redis: database 0 is never cleared" >&2; return 1; fi
  if [ "$1" != "$EXPECTED_REDIS_DB" ]; then
    echo "refusing to clear Redis: recorded database $1 is not the dedicated database $EXPECTED_REDIS_DB" >&2; return 1
  fi
  if [ "$2" != "$EXPECTED_REDIS_CONTAINER" ]; then
    echo "refusing to clear Redis: recorded container '$2' is not $EXPECTED_REDIS_CONTAINER" >&2; return 1
  fi
}

redis_container_ok() { # the live container really is the expected, running one
  [ "$(docker inspect -f '{{.Name}} {{.State.Running}}' "$EXPECTED_REDIS_CONTAINER" 2>/dev/null)" = "/$EXPECTED_REDIS_CONTAINER true" ] || {
    echo "refusing to clear Redis: container $EXPECTED_REDIS_CONTAINER is not running" >&2; return 1; }
}

stop_tree() { # TERM a process and all its descendants (pnpm exec → node → workers)
  for child in $(pgrep -P "$1" 2>/dev/null || true); do stop_tree "$child"; done
  kill -TERM "$1" 2>/dev/null || true
}

stop_pid() { # stop a recorded process tree, only if it is still running
  pid=$1
  case "$pid" in ''|*[!0-9]*) return 0 ;; esac
  kill -0 "$pid" 2>/dev/null || return 0
  stop_tree "$pid"
}

cmd_up() {
  if [ -f "$STATE" ]; then
    echo "a pricing e2e run is already recorded at $STATE — run 'down' first" >&2; exit 1
  fi
  for port in $API_PORT $WEB_PORT $POS_PORT; do
    port_free "$port" || { echo "port $port is in use" >&2; exit 1; }
  done
  docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" | grep -q true || { echo "$PG_CONTAINER is not running (pnpm infra:up)" >&2; exit 1; }
  redis_container_ok || exit 1
  size=$(docker exec "$EXPECTED_REDIS_CONTAINER" redis-cli -n "$EXPECTED_REDIS_DB" DBSIZE)
  [ "$size" = "0" ] || { echo "Redis database $EXPECTED_REDIS_DB is not empty ($size keys); refusing to share it" >&2; exit 1; }

  mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"
  : > "$STATE"; chmod 600 "$STATE"
  DB="kazhal_pricing_e2e_$(date +%Y%m%d%H%M%S)_$$"
  ADMIN_USER=e2e_owner
  ADMIN_PASS=$(openssl rand -hex 16)
  CASHIER_PASS=$(openssl rand -hex 16)
  JWT=$(openssl rand -hex 32)
  OTP=$(openssl rand -hex 32)
  # Secrets go to the mode-600 state file and to child environments only —
  # never to a command line, where any local process could read them.
  # Recorded BEFORE anything is created, so 'down' can always clean up.
  save DB "$DB"; save REDIS_DB "$EXPECTED_REDIS_DB"; save REDIS_CONTAINER "$EXPECTED_REDIS_CONTAINER"
  save ADMIN_USER "$ADMIN_USER"; save ADMIN_PASS "$ADMIN_PASS"; save CASHIER_PASS "$CASHIER_PASS"

  echo "creating database $DB"
  printf 'CREATE DATABASE "%s";\n' "$DB" | psql_admin >/dev/null

  cd "$ROOT/apps/api"
  echo "migrating"
  DB_DATABASE="$DB" pnpm -s migration:run > "$STATE_DIR/migrate.log" 2>&1
  echo "seeding roles and the owner account"
  DB_DATABASE="$DB" BOOTSTRAP_ADMIN_USERNAME="$ADMIN_USER" BOOTSTRAP_ADMIN_PASSWORD="$ADMIN_PASS" \
    pnpm -s seed > "$STATE_DIR/seed.log" 2>&1
  [ -f dist/main.js ] || pnpm -s build > "$STATE_DIR/api-build.log" 2>&1

  echo "starting API on $API_PORT"
  PORT=$API_PORT DB_DATABASE="$DB" REDIS_DB=$EXPECTED_REDIS_DB \
      CORS_ORIGINS="http://localhost:$WEB_PORT,http://localhost:$POS_PORT" \
      PAYMENT_CALLBACK_URL="http://localhost:$WEB_PORT/checkout/payment/return" \
      JWT_SECRET_KEY="$JWT" OTP_HMAC_SECRET="$OTP" SEED_ON_BOOTSTRAP=false \
      node dist/main > "$STATE_DIR/api.log" 2>&1 &
  save API_PID $!
  wait_http "http://localhost:$API_PORT/health" 60

  echo "seeding the journey's records"
  # seed.mjs reads both passwords from the mode-600 state file itself.
  node "$ROOT/scripts/pricing-e2e/seed.mjs" "http://localhost:$API_PORT" "$DB" "$STATE" \
    > "$STATE_DIR/fixture.json"

  for app in web store; do
    port=$WEB_PORT; key=WEB_PID
    [ "$app" = store ] && { port=$POS_PORT; key=POS_PID; }
    echo "building and starting $app on $port"
    cd "$ROOT/apps/$app"
    # `next build` adds the build directory's type globs to tsconfig.json;
    # the tracked file is put back exactly as it was once the build is done.
    cp tsconfig.json "$STATE_DIR/$app.tsconfig.json"
    KAZHAL_NEXT_DIST_DIR=$DIST NEXT_PUBLIC_API_BASE_URL="http://localhost:$API_PORT" \
      pnpm exec next build > "$STATE_DIR/$app-build.log" 2>&1 || {
        cp "$STATE_DIR/$app.tsconfig.json" tsconfig.json; echo "$app build failed" >&2; exit 1; }
    cp "$STATE_DIR/$app.tsconfig.json" tsconfig.json
    KAZHAL_NEXT_DIST_DIR=$DIST NEXT_PUBLIC_API_BASE_URL="http://localhost:$API_PORT" \
      pnpm exec next start -p "$port" > "$STATE_DIR/$app.log" 2>&1 &
    save "$key" $!
    wait_http "http://localhost:$port/" 60
  done
  echo "ready: API http://localhost:$API_PORT  Web http://localhost:$WEB_PORT  POS http://localhost:$POS_PORT"
  echo "fixture: $STATE_DIR/fixture.json   credentials: $STATE (mode 600)"
}

cmd_status() {
  [ -f "$STATE" ] || { echo "no pricing e2e run recorded"; return 0; }
  grep -vE '_PASS=' "$STATE"
  [ -f "$STATE_DIR/fixture.json" ] && cat "$STATE_DIR/fixture.json"
  return 0
}

cmd_down() {
  [ -f "$STATE" ] || { echo "no pricing e2e run recorded"; return 0; }
  STATE_DB=$(state_get DB)
  STATE_REDIS_DB=$(state_get REDIS_DB)
  STATE_REDIS_CONTAINER=$(state_get REDIS_CONTAINER)
  refused=0
  for key in POS_PID WEB_PID API_PID; do stop_pid "$(state_get "$key")"; done
  sleep 2
  for port in $API_PORT $WEB_PORT $POS_PORT; do
    port_free "$port" || echo "warning: port $port is still in use" >&2
  done
  if printf '%s' "$STATE_DB" | grep -Eq "$NAME_PATTERN"; then
    echo "dropping database $STATE_DB"
    printf 'DROP DATABASE IF EXISTS "%s" WITH (FORCE);\n' "$STATE_DB" | psql_admin >/dev/null
  else
    echo "refusing to drop unexpected database name '$STATE_DB'" >&2; refused=1
  fi
  if redis_target_ok "$STATE_REDIS_DB" "$STATE_REDIS_CONTAINER" && redis_container_ok; then
    echo "clearing Redis database $EXPECTED_REDIS_DB"
    docker exec "$EXPECTED_REDIS_CONTAINER" redis-cli -n "$EXPECTED_REDIS_DB" FLUSHDB >/dev/null
    size=$(docker exec "$EXPECTED_REDIS_CONTAINER" redis-cli -n "$EXPECTED_REDIS_DB" DBSIZE)
    [ "$size" = "0" ] || { echo "Redis database $EXPECTED_REDIS_DB still holds $size keys" >&2; refused=1; }
  else
    refused=1
  fi
  for app in web store; do # in case 'up' stopped mid-build
    [ -f "$STATE_DIR/$app.tsconfig.json" ] && cp "$STATE_DIR/$app.tsconfig.json" "$ROOT/apps/$app/tsconfig.json"
    rm -f "$STATE_DIR/$app.tsconfig.json"
  done
  rm -rf "$ROOT/apps/web/$DIST" "$ROOT/apps/store/$DIST"
  if [ "$refused" != "0" ]; then
    echo "cleanup incomplete; $STATE is kept for inspection" >&2; exit 1
  fi
  rm -f "$STATE" "$STATE_DIR/fixture.json"
  echo "done"
}

case "${1:-}" in
  up) cmd_up ;;
  status) cmd_status ;;
  down) cmd_down ;;
  check-redis-target) redis_target_ok "${2:-}" "${3:-}" ;;
  *) echo "usage: sh scripts/pricing-e2e/run.sh up|status|down|check-redis-target" >&2; exit 2 ;;
esac
