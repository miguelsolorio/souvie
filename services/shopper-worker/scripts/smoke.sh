#!/usr/bin/env bash
# WS09 worker smoke against the local Supabase stack (CI; the development Mac has no container
# runtime). With WORKER_RETAILER_MODE=mock and no model key it proves, on the real Postgres, pgmq
# and migrations:
#   * an idle poll is logged within 5 seconds of start
#   * enqueue_shopping_run -> the worker plans -> needs_review, with no cart write
#   * an approval (written the way run-approve writes it) -> the worker pushes -> cart_ready with
#     the hand-off link and a ledger row per line
#   * SIGTERM -> the worker exits within 10 seconds
# Run from the repo root with DB_URL set.
set -euo pipefail
: "${DB_URL:?DB_URL is required}"

LIST=9c000000-0000-4000-8000-0000000000c9
CONN=7c000000-0000-4000-8000-0000000000c9
USER_ID=c9999999-9999-4999-8999-999999999999
LOG=worker-smoke.log

q() { psql "$DB_URL" -v ON_ERROR_STOP=1 -Atc "$1"; }

wait_for_status() {
  local run="$1" want="$2" status=""
  for _ in $(seq 1 120); do
    status="$(q "select status from public.shopping_runs where id = '$run'")"
    [ "$status" = "$want" ] && return 0
    case "$status" in failed|cancelled) break ;; esac
    sleep 0.5
  done
  echo "run $run is $status, wanted $want"
  q "select coalesce(error, '') from public.shopping_runs where id = '$run'"
  cat "$LOG"
  return 1
}

psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f services/shopper-worker/scripts/smoke-fixture.sql

cd services/shopper-worker
WORKER_DATABASE_URL="$DB_URL" WORKER_RETAILER_MODE=mock WORKER_HEARTBEAT_SECONDS=5 \
  WORKER_CONCURRENCY=2 ./node_modules/.bin/tsx src/index.ts > "../../$LOG" 2>&1 &
pid=$!
cd ../..
started=$(date +%s)

for _ in $(seq 1 10); do grep -q "\] idle " "$LOG" && break; sleep 0.5; done
grep -q "\] idle " "$LOG" || { echo "no idle poll within 5 seconds"; cat "$LOG"; exit 1; }
echo "idle poll logged $(( $(date +%s) - started ))s after start"

run="$(q "select public.enqueue_shopping_run('$LIST', '$CONN', 'manual', '{\"per_item_ceiling_usd\": 15}'::jsonb)")"
echo "enqueued run $run"
wait_for_status "$run" needs_review
psql "$DB_URL" -c "select status, subtotal_usd, cart_snapshot ->> 'summary' as summary from public.shopping_runs where id = '$run'"
psql "$DB_URL" -c "select status, count(*) from public.shopping_run_items where run_id = '$run' group by status order by status"
test "$(q "select count(*) from public.shopping_run_items where run_id = '$run'")" -eq 12
test "$(q "select count(*) from public.shopping_run_items where run_id = '$run' and delta_sent is not null")" -eq 0
echo "proposal written, no cart write before review"

# The approval through run-approve's own store over postgres.js (what the Edge Function runs after
# auth.getUser): one swap, the rest kept, needs_review -> running, the queue message.
(cd services/shopper-worker && DB_URL="$DB_URL" ./node_modules/.bin/tsx scripts/approve.ts "$run" "$USER_ID")
test "$(q "select count(*) from public.shopping_run_items where run_id = '$run' and user_decision = 'swapped'")" -eq 1
test "$(q "select count(*) from public.product_matches where household_id = '0c000000-0000-4000-8000-0000000000c9'")" -ge 1
echo "approved through run-approve's store"
wait_for_status "$run" cart_ready
psql "$DB_URL" -c "select status, subtotal_usd, cart_snapshot ->> 'handoffUrl' as handoff from public.shopping_runs where id = '$run'"
psql "$DB_URL" -c "select delta_result, count(*) from public.shopping_run_items where run_id = '$run' and status in ('matched', 'substituted') group by delta_result"
test "$(q "select count(*) from public.shopping_run_items where run_id = '$run' and status in ('matched', 'substituted') and delta_result is distinct from '204'")" -eq 0
q "select cart_snapshot ->> 'handoffUrl' from public.shopping_runs where id = '$run'" | grep -q '^https://mock-retailer.test/checkout'
test "$(q "select count(*) from pgmq.q_shopping_run where message ->> 'run_id' = '$run'")" -eq 0
echo "cart filled through the ledger; messages acked"

stop=$(date +%s)
kill -TERM "$pid"
wait "$pid" || true
elapsed=$(( $(date +%s) - stop ))
echo "worker exited ${elapsed}s after SIGTERM"
test "$elapsed" -le 10
grep -q "\] stopped" "$LOG"
if grep -qE "\] (fatal|poll failed)" "$LOG"; then cat "$LOG"; exit 1; fi
cat "$LOG"
