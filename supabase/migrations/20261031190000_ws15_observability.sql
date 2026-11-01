-- WS15: observability. docs/02-data-model.md migration order 16.
--
-- What this adds:
--   households.ai_daily_cap_usd   the household's model budget per UTC day (default 2.00). Read by
--                                 the cost guards in packages/llm (log.ts) through the household
--                                 row; the AI_DAILY_CAP_USD variable is only the fallback.
--   ai_runs.user_id               who made the call, so a call with no household (parse-ingredients
--                                 in "lines" mode) can still be capped per user. The WS03 review
--                                 (2026-10-30): any signed-in user could send 200 lines per call
--                                 with nothing to stop them.
--   user_ai_spend_since           today's spend of one user on household-less calls (service role).
--   v_ai_cost_daily               cost and call count per household, day, kind and model.
--   v_ai_cost_by_prompt           calls, average latency and error rate per prompt version.
--   v_runs_stalled                the dashboard query behind the "no worker alive" alert: a run
--                                 that says it is running but has had no heartbeat for 10 minutes.
--
-- What it does not add (orchestrator corrections, 2026-10-31): a second sweeper, a heartbeat
-- column (WS09 made shopping_runs.heartbeat_at), a dead-letter queue (the dead letter is pgmq's
-- archive, a_shopping_run, after three attempts), or a pg_cron job.

-- ---------------------------------------------------------------------------------------
-- households.ai_daily_cap_usd
-- ---------------------------------------------------------------------------------------

alter table public.households
  add column ai_daily_cap_usd numeric(8, 2) not null default 2.00;

alter table public.households
  add constraint households_ai_daily_cap_range check (ai_daily_cap_usd >= 0 and ai_daily_cap_usd <= 1000);

comment on column public.households.ai_daily_cap_usd is
  'USD of model calls the household may spend per UTC day. 0 switches model calls off. Members can read it; only the service role writes it (no client UPDATE grant).';

-- No `grant update (ai_daily_cap_usd)`: UPDATE on households is granted by column (name, zip,
-- plan_mode), so a new column is not client-editable. The cap is an operator control. Changing it
-- is a service-role statement:
--   update public.households set ai_daily_cap_usd = 5 where id = '<household>';

-- ---------------------------------------------------------------------------------------
-- ai_runs.user_id and the per-user spend
-- ---------------------------------------------------------------------------------------

alter table public.ai_runs
  add column user_id uuid references auth.users (id) on delete set null;

comment on column public.ai_runs.user_id is
  'The signed-in user whose request caused the call, when the caller knows it. Set by parse-ingredients, whose "lines" mode has no household; null for system jobs and for calls made on a household''s behalf by the worker.';

create index ai_runs_user_created_idx on public.ai_runs (user_id, created_at)
  where household_id is null;

-- What a user has spent since a moment on calls with no household. Calls with a household count
-- against the household's cap instead. Summed in SQL so PostgREST's row limit cannot undercount.
create or replace function public.user_ai_spend_since(
  p_user_id uuid,
  p_since timestamptz
)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(r.cost_usd), 0)
  from public.ai_runs r
  where r.user_id = p_user_id and r.household_id is null and r.created_at >= p_since
$$;

revoke all on function public.user_ai_spend_since(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.user_ai_spend_since(uuid, timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------
-- Cost views
-- ---------------------------------------------------------------------------------------
-- security_invoker: the view reads ai_runs as the caller, so the "ai_runs: members read" policy
-- decides the rows. A member sees their own households' numbers; the service role sees all of
-- them. A row the cap refused (error = 'cost_cap', cost 0, no model call) is not a model call and
-- is left out of the counts.

create view public.v_ai_cost_daily
with (security_invoker = true) as
select
  r.household_id,
  (r.created_at at time zone 'utc')::date as day,
  r.kind,
  r.model,
  sum(r.cost_usd) as cost_usd,
  count(*)::integer as calls
from public.ai_runs r
where r.error is distinct from 'cost_cap'
group by r.household_id, (r.created_at at time zone 'utc')::date, r.kind, r.model;

comment on view public.v_ai_cost_daily is
  'ai_runs cost and call count per household, UTC day, kind and model. security_invoker, so RLS on ai_runs applies.';

create view public.v_ai_cost_by_prompt
with (security_invoker = true) as
select
  r.prompt_version,
  count(*)::integer as calls,
  round(avg(r.latency_ms), 1) as avg_latency_ms,
  round(avg(case when r.ok then 0 else 1 end), 4) as error_rate
from public.ai_runs r
where r.error is distinct from 'cost_cap'
group by r.prompt_version;

comment on view public.v_ai_cost_by_prompt is
  'Calls, average latency and error rate (0 to 1) per prompt version. A null prompt_version groups calls that carry none. security_invoker, so RLS on ai_runs applies.';

revoke all on public.v_ai_cost_daily, public.v_ai_cost_by_prompt from anon, authenticated;
grant select on public.v_ai_cost_daily, public.v_ai_cost_by_prompt to authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- v_runs_stalled: the run-health dashboard query
-- ---------------------------------------------------------------------------------------
-- The worker's sweeper (90 seconds, WS09) fails or requeues a run whose worker died, as long as
-- some worker is alive. This view is the other half: a run that still says running or
-- checking_out ten minutes after its last heartbeat means no worker is alive to sweep it. A run
-- that waits for a worker (running, approved, heartbeat null) is measured from its last status
-- change. needs_review is not here: a run waiting on a human is not running (R10).

create view public.v_runs_stalled
with (security_invoker = true) as
select
  r.id as run_id,
  r.household_id,
  r.retailer,
  r.status,
  r.heartbeat_at,
  r.status_changed_at,
  floor(extract(epoch from (now() - coalesce(r.heartbeat_at, r.status_changed_at))))::integer
    as silent_seconds
from public.shopping_runs r
where r.status in ('running', 'checking_out')
  and coalesce(r.heartbeat_at, r.status_changed_at) < now() - interval '10 minutes';

comment on view public.v_runs_stalled is
  'Runs still running or checking_out with no heartbeat for 10 minutes: no worker is alive to sweep them. security_invoker, so members see their households'' runs.';

revoke all on public.v_runs_stalled from anon, authenticated;
grant select on public.v_runs_stalled to authenticated, service_role;
