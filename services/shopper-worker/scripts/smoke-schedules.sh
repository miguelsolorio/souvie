#!/usr/bin/env bash
# WS11 smoke against the local Supabase stack (CI; the development Mac has no container runtime).
# On the real Postgres, pgmq and pg_cron it proves, with WORKER_RETAILER_MODE=mock:
#   * enqueue_due_scheduled_runs() starts one scheduled run for the due schedule, once: a second call
#     starts none and puts nothing more on the queue (criteria 2 and 3), and the message is
#     {"run_id"} and nothing else
#   * a schedule with no list for the week is skipped with a schedule_skipped row, not a failed run
#   * the worker takes the scheduled run from the queue and plans it to needs_review
#   * the worker drains the outbox: a row for a household with no devices is marked sent, and a row
#     for a household inside its quiet hours is held until they end (criterion 7)
# Run from the repo root with DB_URL set, after the pgTAP step.
set -euo pipefail
: "${DB_URL:?DB_URL is required}"

LOG=worker-schedules-smoke.log
q() { psql "$DB_URL" -v ON_ERROR_STOP=1 -Atc "$1"; }

# Ids unlike any other fixture's.
H1=0d000000-0000-4000-8000-0000000000d1   # has this week's list: its schedule starts a run
H2=0d000000-0000-4000-8000-0000000000d2   # no list, quiet hours around now: skipped and held
H3=0d000000-0000-4000-8000-0000000000d3   # no list, no quiet hours: skipped and sent
U1=d1111111-1111-4111-8111-1111111111d1
U2=d2222222-2222-4222-8222-2222222222d2
U3=d3333333-3333-4333-8333-3333333333d3
C1=7d000000-0000-4000-8000-0000000000d1
C2=7d000000-0000-4000-8000-0000000000d2
C3=7d000000-0000-4000-8000-0000000000d3
S1=5d000000-0000-4000-8000-0000000000d1
S2=5d000000-0000-4000-8000-0000000000d2
S3=5d000000-0000-4000-8000-0000000000d3
LIST=9d000000-0000-4000-8000-0000000000d1
PLAN=cd000000-0000-4000-8000-0000000000d1

# The week a run five minutes ago shops for (the Monday on or after it, in Los Angeles).
week="$(q "select public.scheduled_run_target_week(now() - interval '5 minutes', 'America/Los_Angeles')")"
echo "target week: $week"

psql "$DB_URL" -v ON_ERROR_STOP=1 -q -v week="$week" <<SQL
insert into auth.users (id, email) values
  ('$U1', 'ws11-smoke-1@example.test'), ('$U2', 'ws11-smoke-2@example.test'),
  ('$U3', 'ws11-smoke-3@example.test');
insert into public.households (id, name, created_by, timezone) values
  ('$H1', 'WS11 Smoke 1', '$U1', 'America/Los_Angeles'),
  ('$H2', 'WS11 Smoke 2', '$U2', 'UTC'),
  ('$H3', 'WS11 Smoke 3', '$U3', 'America/Los_Angeles');
insert into public.household_members (household_id, user_id, role) values
  ('$H1', '$U1', 'owner'), ('$H2', '$U2', 'owner'), ('$H3', '$U3', 'owner');
insert into public.retailer_connections (id, household_id, user_id, retailer, auth_type, store_id, store_name, modality, status) values
  ('$C1', '$H1', '$U1', 'kroger', 'none', 'MOCK0001', 'Mock QFC Duvall', 'pickup', 'active'),
  ('$C2', '$H2', '$U2', 'kroger', 'none', 'MOCK0001', 'Mock QFC Duvall', 'pickup', 'active'),
  ('$C3', '$H3', '$U3', 'kroger', 'none', 'MOCK0001', 'Mock QFC Duvall', 'pickup', 'active');

insert into public.meal_plans (id, household_id, week_start) values ('$PLAN', '$H1', :'week');
insert into public.grocery_lists (id, household_id, plan_id, name, status, built_at)
  values ('$LIST', '$H1', '$PLAN', 'WS11 smoke week', 'active', now());
insert into public.grocery_list_items (list_id, household_id, ingredient_id, display_name, qty, unit, section, position)
select '$LIST', '$H1', (select i.id from public.ingredients i where i.name = l.name),
       l.display_name, l.qty, l.unit, l.section, l.position
  from (values
    ('yellow onion', 'Yellow onions', 3, 'each', 'produce', 0),
    ('garlic', 'Garlic', 1, 'head', 'produce', 1),
    ('milk', 'Whole milk', 1, 'gallon', 'dairy', 2)
  ) as l(name, display_name, qty, unit, section, position);

-- Quiet hours around now, in the household's zone (UTC): from an hour ago to an hour from now.
update public.households
   set quiet_hours = jsonb_build_object(
         'start', to_char((now() at time zone 'UTC') - interval '1 hour', 'HH24:MI'),
         'end', to_char((now() at time zone 'UTC') + interval '1 hour', 'HH24:MI'))
 where id = '$H2';

insert into public.scheduled_runs (id, household_id, cron, tz, connection_id, policy) values
  ('$S1', '$H1', '0 9 * * 6', 'America/Los_Angeles', '$C1', '{"budget_cap_usd": 150}'),
  ('$S2', '$H2', '0 9 * * 6', 'America/Los_Angeles', '$C2', '{}'),
  ('$S3', '$H3', '0 9 * * 6', 'America/Los_Angeles', '$C3', '{}');
-- Due five minutes ago. (A schedule's next_run_at is the server's; this is the test's clock.)
update public.scheduled_runs set next_run_at = now() - interval '5 minutes' where id in ('$S1', '$S2', '$S3');
SQL

# Criterion 2: one run, one message, next_run_at moved on.
started="$(q "select public.enqueue_due_scheduled_runs()")"
echo "enqueue_due_scheduled_runs() -> $started"
test "$started" = "1"
run="$(q "select id from public.shopping_runs where household_id = '$H1' and trigger = 'scheduled'")"
test -n "$run"
test "$(q "select status from public.shopping_runs where id = '$run'")" = "queued"
test "$(q "select (policy ->> 'budget_cap_usd') || '/' || (policy ->> 'auto_checkout') from public.shopping_runs where id = '$run'")" = "150/false"
test "$(q "select count(*) from pgmq.q_shopping_run where message ->> 'run_id' = '$run'")" -eq 1
test "$(q "select message::text from pgmq.q_shopping_run where message ->> 'run_id' = '$run'")" = "{\"run_id\": \"$run\"}"
test "$(q "select next_run_at > now() from public.scheduled_runs where id = '$S1'")" = "t"
echo "one scheduled run and one {run_id} message"

# Criterion 3: a second call starts nothing.
again="$(q "select public.enqueue_due_scheduled_runs()")"
test "$again" = "0"
test "$(q "select count(*) from public.shopping_runs where household_id = '$H1'")" -eq 1
test "$(q "select count(*) from pgmq.q_shopping_run where message ->> 'run_id' = '$run'")" -eq 1
echo "a second call started none"

# Criterion 4 (as the orchestrator decided): no list for the week is a skipped schedule.
test "$(q "select count(*) from public.shopping_runs where household_id in ('$H2', '$H3')")" -eq 0
test "$(q "select count(*) from public.notification_outbox where type = 'schedule_skipped' and payload ->> 'reason' = 'no_active_list' and household_id in ('$H2', '$H3')")" -eq 2
echo "two skipped schedules, two schedule_skipped rows, no failed run"

cd services/shopper-worker
WORKER_DATABASE_URL="$DB_URL" WORKER_RETAILER_MODE=mock WORKER_HEARTBEAT_SECONDS=5 \
  WORKER_OUTBOX_SECONDS=5 WORKER_CONCURRENCY=2 ./node_modules/.bin/tsx src/index.ts > "../../$LOG" 2>&1 &
pid=$!
cd ../..

# The worker plans the scheduled run exactly as it plans a manual one.
status=""
for _ in $(seq 1 120); do
  status="$(q "select status from public.shopping_runs where id = '$run'")"
  [ "$status" = "needs_review" ] && break
  case "$status" in failed|cancelled) break ;; esac
  sleep 0.5
done
if [ "$status" != "needs_review" ]; then
  echo "scheduled run is $status, wanted needs_review"; q "select coalesce(error, '') from public.shopping_runs where id = '$run'"; cat "$LOG"; kill -TERM "$pid" || true; exit 1
fi
test "$(q "select count(*) from public.shopping_run_items where run_id = '$run'")" -eq 3
echo "the worker planned the scheduled run to needs_review"

# The outbox drain: the household without devices is marked sent; the one in quiet hours is held.
for _ in $(seq 1 40); do
  sent="$(q "select count(*) from public.notification_outbox where household_id = '$H3' and sent_at is not null")"
  [ "$sent" = "1" ] && break
  sleep 0.5
done
test "$sent" = "1" || { echo "the outbox row for $H3 was not sent"; cat "$LOG"; kill -TERM "$pid" || true; exit 1; }
sleep 6   # two more drain passes: the quiet-hours row must still be there
test "$(q "select count(*) from public.notification_outbox where household_id = '$H2' and sent_at is null and attempts = 0 and deliver_after > now() + interval '30 minutes'")" -eq 1
echo "the outbox row in quiet hours is held until they end; the other was drained"

stop=$(date +%s)
kill -TERM "$pid"
wait "$pid" || true
elapsed=$(( $(date +%s) - stop ))
echo "worker exited ${elapsed}s after SIGTERM"
test "$elapsed" -le 10
if grep -qE "\] (fatal|poll failed)|outbox claim failed" "$LOG"; then cat "$LOG"; exit 1; fi
cat "$LOG"
