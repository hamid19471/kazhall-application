#!/bin/sh
# Safety tests for run.sh's cleanup guards (docs/MONTHLY-PRICING.md §10).
#
#   sh scripts/pricing-e2e/run.test.sh
#
# Touches no real service: `docker` is replaced on PATH by a stub that records
# each call and answers like the kazhal-review containers, and every run uses
# its own throwaway state directory.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
RUN="$HERE/run.sh"
for dir in "$ROOT/apps/web/.next-pricing-e2e" "$ROOT/apps/store/.next-pricing-e2e"; do
  [ ! -e "$dir" ] || { echo "a real pricing e2e run looks active ($dir); run.sh down first" >&2; exit 1; }
done

WORK=$(mktemp -d "${TMPDIR:-/tmp}/kazhal-pricing-e2e-test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"
cat > "$WORK/bin/docker" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "$1" in
  inspect) echo "/kazhal-review-redis true" ;;
  exec) case "$*" in *DBSIZE*) echo 0 ;; "exec -i "*) cat > /dev/null ;; esac ;;
esac
STUB
chmod +x "$WORK/bin/docker"

passed=0; failed=0
ok() { passed=$((passed + 1)); echo "PASS  $1"; }
ko() { failed=$((failed + 1)); echo "FAIL  $1"; }

# --- the pure guard ---------------------------------------------------------
if sh "$RUN" check-redis-target 15 kazhal-review-redis 2>/dev/null; then ok "database 15 on kazhal-review-redis is allowed"
else ko "database 15 on kazhal-review-redis is allowed"; fi

refuse() { # label db container
  if sh "$RUN" check-redis-target "$2" "$3" 2>/dev/null; then ko "$1 is refused"; else ok "$1 is refused"; fi
}
refuse "database 0" 0 kazhal-review-redis
refuse "database 14" 14 kazhal-review-redis
refuse "an empty value" "" kazhal-review-redis
refuse "a non-numeric value" abc kazhal-review-redis
refuse "'015' (not exactly 15)" 015 kazhal-review-redis
refuse "' 15' (whitespace)" " 15" kazhal-review-redis
refuse "'15 ' (whitespace)" "15 " kazhal-review-redis
refuse "'-15'" -15 kazhal-review-redis
refuse "'15; FLUSHALL'" "15; FLUSHALL" kazhal-review-redis
refuse "another container" 15 some-other-redis
refuse "an empty container" 15 ""

# --- 'down' end to end, against the stub -----------------------------------
down_with() { # label, then the state file's lines; sets $status and $log
  label=$1; shift
  dir="$WORK/state-$(date +%s)-$passed-$failed"
  mkdir -p "$dir"; chmod 700 "$dir"
  printf '%s\n' "$@" > "$dir/state.env"; chmod 600 "$dir/state.env"
  DOCKER_LOG="$dir/docker.log"; : > "$DOCKER_LOG"
  status=0
  PATH="$WORK/bin:$PATH" DOCKER_LOG="$DOCKER_LOG" PRICING_E2E_STATE_DIR="$dir" \
    sh "$RUN" down > "$dir/out.log" 2>&1 || status=$?
  log=$(cat "$DOCKER_LOG")
  if [ -f "$dir/state.env" ]; then kept=yes; else kept=no; fi
}

DB=kazhal_pricing_e2e_20260928000000_1
down_with "valid" "DB=$DB" "REDIS_DB=15" "REDIS_CONTAINER=kazhal-review-redis"
if [ "$status" = 0 ] && printf '%s\n' "$log" | grep -qx 'exec kazhal-review-redis redis-cli -n 15 FLUSHDB' \
   && [ "$(printf '%s\n' "$log" | grep -c FLUSH)" = 1 ] && [ "$kept" = no ]; then
  ok "down with database 15 clears exactly Redis database 15"
else ko "down with database 15 clears exactly Redis database 15 (status $status)"; fi

refuse_down() { # label, state lines...
  label=$1; shift
  down_with "$label" "$@"
  if [ "$status" != 0 ] && ! printf '%s\n' "$log" | grep -q FLUSH && [ "$kept" = yes ]; then
    ok "down refuses $label (no FLUSH issued, state kept)"
  else ko "down refuses $label (status $status, flush: $(printf '%s\n' "$log" | grep -c FLUSH || true))"; fi
}
refuse_down "database 0" "DB=$DB" "REDIS_DB=0" "REDIS_CONTAINER=kazhal-review-redis"
refuse_down "database 14" "DB=$DB" "REDIS_DB=14" "REDIS_CONTAINER=kazhal-review-redis"
refuse_down "an empty database" "DB=$DB" "REDIS_DB=" "REDIS_CONTAINER=kazhal-review-redis"
refuse_down "a missing database" "DB=$DB" "REDIS_CONTAINER=kazhal-review-redis"
refuse_down "a non-numeric database" "DB=$DB" "REDIS_DB=abc" "REDIS_CONTAINER=kazhal-review-redis"
refuse_down "a duplicated database entry" "DB=$DB" "REDIS_DB=15" "REDIS_DB=0" "REDIS_CONTAINER=kazhal-review-redis"
refuse_down "another container" "DB=$DB" "REDIS_DB=15" "REDIS_CONTAINER=other-redis"
refuse_down "a state line that tries to redefine the constant" "DB=$DB" "REDIS_DB=0" "EXPECTED_REDIS_DB=0" "REDIS_CONTAINER=kazhal-review-redis"

echo "$passed passed, $failed failed"
[ "$failed" = 0 ]
