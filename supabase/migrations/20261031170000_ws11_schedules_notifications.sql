-- WS11: scheduled shopping runs and push notifications. docs/02-data-model.md §Retail and
-- §Migration ownership, order 13.
--
-- Tables: scheduled_runs, notification_preferences, notification_outbox. Columns on households:
-- timezone and quiet_hours. push_tokens is WS09's; WS11 adds the functions that register and forget
-- a device token. Also here: the pg_cron job that turns due schedules into shopping runs, the
-- generators that write the new notifications into the outbox, and the two triggers that do the
-- same for a failed run and a finished import.
--
-- How a Saturday run happens (docs/01 §Shopping run):
--   pg_cron, every 5 minutes -> enqueue_due_scheduled_runs() -> for each due schedule:
--       resolve the active grocery list of the coming week -> enqueue_shopping_run(..., 'scheduled')
--       (WS09's function: daily limit, one active run per list, pgmq message) -> advance next_run_at.
--   A schedule that cannot start (no list, a Tier 3 store, a run already going) is skipped, not
--   retried, and the household is told through the outbox.
--   The worker (services/shopper-worker) drains notification_outbox, honouring preferences and quiet
--   hours. There is no send-push Edge Function and no pg_net: SQL never calls out. The worker still
--   sends cart_ready and needs_review straight to Expo, through the same preference and quiet hours
--   gate; only a push held back by quiet hours is parked in the outbox.
--
-- Ownership decisions that differ from the brief (orchestrator corrections, 2026-10-31):
--   * notification_preferences is (user_id, type, enabled) with primary key (user_id, type).
--   * quiet_hours is {start, end}; the zone is the new households.timezone.
--   * push_tokens keeps WS09's shape; a dead token is deleted, not disabled.
--   * The outbox types beyond docs/02's five are run_failed and schedule_skipped.

-- ---------------------------------------------------------------------------------------
-- Enums (docs/02 names the type notification_type)
-- ---------------------------------------------------------------------------------------

create type public.notification_type as enum (
  'cart_ready',
  'items_need_review',
  'pickup_reminder',
  'weekly_nudge',
  'import_finished',
  'run_failed',
  'schedule_skipped'
);

-- ---------------------------------------------------------------------------------------
-- Small validators. Plain functions with the default grants: a CHECK constraint runs them as the
-- role that writes the row.
-- ---------------------------------------------------------------------------------------

-- An IANA zone name Postgres knows.
create or replace function public.is_valid_time_zone(p_tz text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_tz is not null and exists (
    select 1 from pg_catalog.pg_timezone_names n where n.name = p_tz
  )
$$;

-- {"start": "21:00", "end": "07:00"}: two different clock times, nothing else. The window may run
-- past midnight.
create or replace function public.quiet_hours_is_valid(q jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    case
      when jsonb_typeof(q) <> 'object' then false
      else
        (select array_agg(k order by k) from jsonb_object_keys(q) as k) = array['end', 'start']
        and jsonb_typeof(q -> 'start') = 'string'
        and jsonb_typeof(q -> 'end') = 'string'
        and (q ->> 'start') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        and (q ->> 'end') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        and (q ->> 'start') <> (q ->> 'end')
    end,
    false
  )
$$;

-- The cron subset a schedule may use: "minute hour * * weekdays" (packages/core/src/schedule.ts
-- parseCron is the same grammar). Weekdays are `*`, numbers 0 to 7 (0 and 7 are Sunday), ranges
-- that run upward, and comma lists of those.
create or replace function public.scheduled_run_cron_is_valid(p_cron text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  m text[];
  item text;
begin
  if p_cron is null then
    return false;
  end if;
  m := regexp_match(
    regexp_replace(p_cron, '^\s+|\s+$', '', 'g'),
    '^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|[0-7](?:-[0-7])?(?:,[0-7](?:-[0-7])?)*)$'
  );
  if m is null then
    return false;
  end if;
  if m[1]::int > 59 or m[2]::int > 23 then
    return false;
  end if;
  if m[3] <> '*' then
    foreach item in array string_to_array(m[3], ',') loop
      if position('-' in item) > 0
        and split_part(item, '-', 2)::int < split_part(item, '-', 1)::int then
        return false;
      end if;
    end loop;
  end if;
  return true;
end;
$$;

-- The weekday field as ISO weekdays (1 Monday to 7 Sunday), sorted; null for `*`.
create or replace function public.scheduled_run_weekdays(p_field text)
returns int[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  item text;
  first_day int;
  last_day int;
  found int[] := '{}';
begin
  if p_field = '*' then
    return null;
  end if;
  foreach item in array string_to_array(p_field, ',') loop
    first_day := split_part(item, '-', 1)::int;
    last_day := case
      when position('-' in item) > 0 then split_part(item, '-', 2)::int
      else first_day
    end;
    for d in first_day..last_day loop
      found := found || (case when d = 0 then 7 else d end);
    end loop;
  end loop;
  return (select array_agg(distinct x order by x) from unnest(found) as x);
end;
$$;

-- The first moment strictly after p_after at which the cron fires on p_tz's wall clock. The same
-- result as nextRunAt in packages/core/src/schedule.ts (a test runs both): a wall time the clock
-- skips is read with the offset from before the change, a repeated one is the later.
create or replace function public.scheduled_run_next(p_cron text, p_tz text, p_after timestamptz)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  v_parts text[];
  v_days int[];
  v_start date;
  v_day date;
  v_at timestamptz;
begin
  if not public.scheduled_run_cron_is_valid(p_cron) then
    raise exception 'invalid_cron' using errcode = 'P0001';
  end if;
  v_parts := regexp_split_to_array(regexp_replace(p_cron, '^\s+|\s+$', '', 'g'), '\s+');
  v_days := public.scheduled_run_weekdays(v_parts[5]);
  -- An unknown zone makes AT TIME ZONE raise; say so in our own words. (Checking the zone against
  -- pg_timezone_names here would read the whole zone database on every call.)
  begin
    v_start := (p_after at time zone p_tz)::date;
  exception when invalid_parameter_value then
    raise exception 'invalid_time_zone' using errcode = 'P0001';
  end;
  for i in 0..8 loop
    v_day := v_start + i;
    if v_days is not null and not (extract(isodow from v_day)::int = any (v_days)) then
      continue;
    end if;
    v_at := (v_day + make_time(v_parts[2]::int, v_parts[1]::int, 0)) at time zone p_tz;
    if v_at > p_after then
      return v_at;
    end if;
  end loop;
  raise exception 'invalid_cron' using errcode = 'P0001';
end;
$$;

-- The Monday on or after the local date of p_at in p_tz: the week a run at p_at shops for
-- (resolveTargetWeekStart in packages/core/src/schedule.ts).
create or replace function public.scheduled_run_target_week(p_at timestamptz, p_tz text)
returns date
language sql
stable
set search_path = ''
as $$
  select d + ((8 - extract(isodow from d)::int) % 7)
  from (select (p_at at time zone p_tz)::date as d) as local
$$;

-- ---------------------------------------------------------------------------------------
-- households: timezone and quiet hours
-- ---------------------------------------------------------------------------------------

alter table public.households
  add column timezone text,
  add column quiet_hours jsonb;

alter table public.households
  add constraint households_timezone_valid
    check (timezone is null or public.is_valid_time_zone(timezone)),
  add constraint households_quiet_hours_valid
    check (quiet_hours is null or public.quiet_hours_is_valid(quiet_hours));

comment on column public.households.timezone is
  'IANA zone the household lives in. Quiet hours and the weekly nudge are read in it; null means America/Los_Angeles. Owner-editable.';
comment on column public.households.quiet_hours is
  '{"start": "21:00", "end": "07:00"} in households.timezone. A push due inside the window waits for its end. Owner-editable.';

-- households has column-level UPDATE grants (name, zip, plan_mode). These two are the owner's to
-- set, through the existing "households: owners update" policy.
grant update (timezone, quiet_hours) on public.households to authenticated;

-- ---------------------------------------------------------------------------------------
-- scheduled_runs
-- ---------------------------------------------------------------------------------------

create table public.scheduled_runs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  -- Five-field cron in `tz`: "minute hour * * weekdays" (scheduled_run_cron_is_valid).
  cron text not null,
  tz text not null default 'America/Los_Angeles',
  connection_id uuid not null references public.retailer_connections (id) on delete cascade,
  -- core.RunPolicy keys (CCR6), validated by shopping_run_policy_is_valid. The editor writes
  -- budget_cap_usd, per_item_ceiling_usd and substitution.
  policy jsonb not null default '{}'::jsonb,
  -- Set by the trigger below; clients cannot write it.
  next_run_at timestamptz not null,
  -- The next_run_at value that was handled (enqueued or skipped). The scheduler refuses a
  -- schedule whose next_run_at equals it, so a value is handled at most once.
  last_enqueued_for timestamptz,
  enabled boolean not null default true,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint scheduled_runs_cron_valid check (public.scheduled_run_cron_is_valid(cron)),
  constraint scheduled_runs_tz_valid check (public.is_valid_time_zone(tz)),
  constraint scheduled_runs_policy_valid check (public.shopping_run_policy_is_valid(policy))
);

comment on table public.scheduled_runs is
  'A household''s standing order to shop (WS11): a weekly time, a store connection, and a run policy. pg_cron turns each due schedule into a shopping run and advances next_run_at.';
comment on column public.scheduled_runs.last_enqueued_for is
  'The next_run_at value already handled. enqueue_due_scheduled_runs skips a schedule whose next_run_at equals it.';

create index scheduled_runs_household_idx on public.scheduled_runs (household_id);
create index scheduled_runs_connection_idx on public.scheduled_runs (connection_id);
-- The scheduler's lookup: enabled schedules by due time.
create index scheduled_runs_due_idx on public.scheduled_runs (next_run_at) where enabled;

create trigger scheduled_runs_set_updated_at
  before update on public.scheduled_runs
  for each row execute function public.set_updated_at();

-- Keeps a schedule honest for every writer: the connection is the household's own, a household has
-- at most 10 schedules, and next_run_at is always the next firing of the cron after now (on insert,
-- when the cron or zone changes, and when a schedule is switched back on).
create or replace function public.scheduled_runs_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  v_check_connection boolean := true;
  v_recompute boolean := true;
begin
  -- OLD does not exist on INSERT, so it is only read on the UPDATE path.
  if tg_op = 'UPDATE' then
    v_check_connection := new.connection_id is distinct from old.connection_id;
    v_recompute := new.cron is distinct from old.cron
      or new.tz is distinct from old.tz
      or (new.enabled and not old.enabled);
  end if;

  if v_check_connection then
    select c.household_id into v_household
    from public.retailer_connections c
    where c.id = new.connection_id;
    if v_household is distinct from new.household_id then
      raise exception 'connection_not_found' using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'INSERT' and (
    select count(*) from public.scheduled_runs s where s.household_id = new.household_id
  ) >= 10 then
    raise exception 'too_many_schedules' using errcode = 'P0001';
  end if;

  if v_recompute then
    new.next_run_at := public.scheduled_run_next(new.cron, new.tz, now());
  end if;
  return new;
end;
$$;

create trigger scheduled_runs_before_write_row
  before insert or update on public.scheduled_runs
  for each row execute function public.scheduled_runs_before_write();

-- docs/05 §Money: a change to the spending rules is logged. The scheduler's own updates (next_run_at
-- and last_enqueued_for) are not changes to the rules, so the update trigger names the columns a
-- person can write.
create or replace function public.scheduled_runs_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.scheduled_runs;
begin
  if tg_op = 'DELETE' then
    r := old;
  else
    r := new;
  end if;
  insert into public.audit_events (household_id, actor_user_id, kind, payload)
  values (
    r.household_id,
    (select auth.uid()),
    'policy_changed',
    jsonb_build_object(
      'scheduled_run_id', r.id,
      'change', lower(tg_op),
      'cron', r.cron,
      'enabled', r.enabled,
      'policy', r.policy
    )
  );
  return null;
end;
$$;

create trigger scheduled_runs_audit_write
  after insert or delete on public.scheduled_runs
  for each row execute function public.scheduled_runs_audit();

create trigger scheduled_runs_audit_update
  after update of cron, tz, connection_id, policy, enabled on public.scheduled_runs
  for each row execute function public.scheduled_runs_audit();

-- ---------------------------------------------------------------------------------------
-- notification_preferences: per person, per type. No row means on.
-- ---------------------------------------------------------------------------------------

create table public.notification_preferences (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  type public.notification_type not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),

  primary key (user_id, type)
);

comment on table public.notification_preferences is
  'Which pushes a person wants (WS11). A missing row means the type is on. Written through set_notification_preference.';

create trigger notification_preferences_set_updated_at
  before update on public.notification_preferences
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------
-- notification_outbox: pushes waiting for the worker. Written by the functions and triggers below
-- and by the worker (a push held back by quiet hours); nobody else.
-- ---------------------------------------------------------------------------------------

create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  type public.notification_type not null,
  -- What the push carries in its data: opaque ids and numbers, never an item name.
  -- core.NotificationPayload is the shape.
  payload jsonb not null default '{}'::jsonb,
  -- Not before this time. The worker moves it to the end of quiet hours when it is due inside them,
  -- and pushes it out while it sends, so a worker that dies mid-send retries after the lease.
  deliver_after timestamptz not null default now(),
  sent_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  -- One row per key: a nudge for a week, a failure for a run. Null for a row that may repeat.
  dedupe_key text,
  created_at timestamptz not null default now(),

  constraint notification_outbox_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint notification_outbox_attempts_range check (attempts >= 0),
  constraint notification_outbox_last_error_length check (
    last_error is null or char_length(last_error) <= 500
  )
);

comment on table public.notification_outbox is
  'Pushes waiting for the shopper worker to send (WS11). Service role only.';

create unique index notification_outbox_dedupe_key_idx
  on public.notification_outbox (dedupe_key)
  where dedupe_key is not null;
-- The worker's lookup: unsent rows by due time.
create index notification_outbox_due_idx
  on public.notification_outbox (deliver_after)
  where sent_at is null;
create index notification_outbox_household_idx on public.notification_outbox (household_id);

-- ---------------------------------------------------------------------------------------
-- Table privileges and RLS (supabase/README.md §RLS conventions)
-- ---------------------------------------------------------------------------------------

revoke all on public.scheduled_runs, public.notification_preferences, public.notification_outbox
  from anon, authenticated;

-- Members read their household's schedules; owners write them. next_run_at and last_enqueued_for
-- are the scheduler's, so a client can write neither.
grant select on public.scheduled_runs to authenticated;
grant insert (id, household_id, cron, tz, connection_id, policy, enabled)
  on public.scheduled_runs to authenticated;
grant update (cron, tz, connection_id, policy, enabled) on public.scheduled_runs to authenticated;
grant delete on public.scheduled_runs to authenticated;

-- A person reads their own preferences and writes them through set_notification_preference, so
-- the upsert needs no UPDATE grant on the key columns.
grant select on public.notification_preferences to authenticated;

-- The outbox has no client access at all.

alter table public.scheduled_runs enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.notification_outbox enable row level security;

create policy "scheduled_runs: members read" on public.scheduled_runs
  for select to authenticated
  using (household_id in (select public.current_household_ids()));

-- Spending rules are the owner's call (docs/05 §Money): the same rule enqueue_shopping_run applies
-- to a run's policy.
create policy "scheduled_runs: owners insert" on public.scheduled_runs
  for insert to authenticated
  with check (household_id in (select public.owned_household_ids()));

create policy "scheduled_runs: owners update" on public.scheduled_runs
  for update to authenticated
  using (household_id in (select public.owned_household_ids()))
  with check (household_id in (select public.owned_household_ids()));

create policy "scheduled_runs: owners delete" on public.scheduled_runs
  for delete to authenticated
  using (household_id in (select public.owned_household_ids()));

create policy "notification_preferences: own read" on public.notification_preferences
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------------------
-- Device tokens and preferences, for the app (push_tokens itself is WS09's)
-- ---------------------------------------------------------------------------------------

-- Registers this device for the signed-in person. A token names a device: whoever signs in on it
-- last owns it, so a phone that changes hands stops receiving the first person's pushes even when
-- that person's sign-out never reached the server. A person keeps at most 20 devices (the oldest
-- go first). Calling it on every launch refreshes updated_at.
create or replace function public.register_push_token(
  p_token text,
  p_platform public.push_tokens_platform
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;
  if p_token is null or p_token !~ '^(Exponent|Expo)PushToken\[.+\]$' then
    raise exception 'invalid_token' using errcode = 'P0001';
  end if;

  delete from public.push_tokens t where t.token = p_token and t.user_id <> v_uid;

  insert into public.push_tokens (user_id, token, platform)
  values (v_uid, p_token, p_platform)
  on conflict (user_id, token)
  do update set platform = excluded.platform, updated_at = now();

  delete from public.push_tokens t
  where t.user_id = v_uid
    and t.token in (
      select o.token from public.push_tokens o
      where o.user_id = v_uid
      order by o.updated_at desc, o.token
      offset 20
    );
end;
$$;

-- Forgets a device by its token. Callable with no session on purpose: when a session ends without
-- the app signing out (the account was signed out elsewhere, the refresh token was revoked), the
-- app can no longer delete its own row, and the phone would keep receiving the household's pushes.
-- The token is the capability: it is unguessable, and whoever holds it could send to the device
-- anyway. Deleting a row that is not there is not an error.
create or replace function public.forget_push_token(p_token text)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.push_tokens t where t.token = p_token
$$;

create or replace function public.set_notification_preference(
  p_type public.notification_type,
  p_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;
  insert into public.notification_preferences (user_id, type, enabled)
  values (v_uid, p_type, coalesce(p_enabled, true))
  on conflict (user_id, type)
  do update set enabled = excluded.enabled, updated_at = now();
end;
$$;

revoke all on function public.register_push_token(text, public.push_tokens_platform)
  from public, anon;
revoke all on function public.forget_push_token(text) from public;
revoke all on function public.set_notification_preference(public.notification_type, boolean)
  from public, anon;
grant execute on function public.register_push_token(text, public.push_tokens_platform)
  to authenticated, service_role;
grant execute on function public.forget_push_token(text) to anon, authenticated, service_role;
grant execute on function public.set_notification_preference(public.notification_type, boolean)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- The outbox writer
-- ---------------------------------------------------------------------------------------

-- Adds a row, or does nothing when a row with the same dedupe key exists. Returns the new id.
create or replace function public.notification_outbox_add(
  p_household uuid,
  p_type public.notification_type,
  p_payload jsonb,
  p_deliver_after timestamptz default now(),
  p_dedupe_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.notification_outbox (household_id, type, payload, deliver_after, dedupe_key)
  values (p_household, p_type, p_payload, coalesce(p_deliver_after, now()), p_dedupe_key)
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.notification_outbox_add(
  uuid, public.notification_type, jsonb, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.notification_outbox_add(
  uuid, public.notification_type, jsonb, timestamptz, text
) to service_role;

-- ---------------------------------------------------------------------------------------
-- enqueue_due_scheduled_runs: the Saturday morning job
--
-- For each enabled schedule that is due (next_run_at has passed and has not been handled):
--   1. find the household's active grocery list for the coming week: the list of the meal plan
--      whose week_start is the Monday on or after the scheduled time, in the schedule's zone
--   2. start a scheduled run of it with enqueue_shopping_run (a shopping_runs row, status queued,
--      and one pgmq message)
--   3. advance next_run_at to the next firing after now, and record the handled value in
--      last_enqueued_for
-- all in one transaction, under FOR UPDATE SKIP LOCKED, so two overlapping jobs never handle the
-- same schedule and a value is handled at most once.
--
-- A schedule that cannot start is skipped, not retried, and the household is told through the
-- outbox (schedule_skipped, with a reason): no active list for the week, a store connection that
-- is gone or needs a new sign-in, a Tier 3 store (the worker cannot drive those, and unattended
-- checkout would need Tier 3 Mode B), a run already going for the list, the daily run limit, or a
-- job that woke up more than 6 hours late. A list that already has a cart is skipped quietly: the
-- store cart is add-only, and a second run would add everything again.
--
-- Unattended checkout does not exist: auto_checkout is always switched off for a scheduled run, so
-- a run ends at cart_ready and the person pays in the store's app (docs/04, R19).
--
-- Returns the number of runs enqueued.
-- ---------------------------------------------------------------------------------------

create or replace function public.enqueue_due_scheduled_runs(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  s record;
  v_week date;
  v_list uuid;
  v_auth public.retailer_connections_auth_type;
  v_found boolean;
  v_reason text;
  v_policy jsonb;
  v_next timestamptz;
  v_count integer := 0;
begin
  for s in
    select sr.*
    from public.scheduled_runs sr
    join public.households h on h.id = sr.household_id and h.deleted_at is null
    where sr.enabled
      and sr.next_run_at <= p_now
      and sr.last_enqueued_for is distinct from sr.next_run_at
    order by sr.next_run_at
    limit 100
    for update of sr skip locked
  loop
    v_reason := null;
    v_list := null;
    v_week := public.scheduled_run_target_week(s.next_run_at, s.tz);

    if p_now - s.next_run_at > interval '6 hours' then
      v_reason := 'missed';
    end if;

    if v_reason is null then
      select l.id into v_list
      from public.grocery_lists l
      join public.meal_plans p on p.id = l.plan_id
      where l.household_id = s.household_id
        and l.status = 'active'
        and l.deleted_at is null
        and p.week_start = v_week
      order by l.built_at desc nulls last, l.created_at desc
      limit 1;
      if v_list is null then
        v_reason := 'no_active_list';
      end if;
    end if;

    if v_reason is null then
      select true, c.auth_type into v_found, v_auth
      from public.retailer_connections c
      where c.id = s.connection_id and c.household_id = s.household_id;
      if v_found is not true then
        v_reason := 'connection_not_found';
      elsif v_auth = 'browser_session' then
        v_reason := 'tier3_unattended';
      end if;
    end if;

    if v_reason is null and exists (
      select 1 from public.shopping_runs r
      where r.list_id = v_list and r.status in ('cart_ready', 'checking_out', 'checked_out')
    ) then
      v_reason := 'already_shopped';
    end if;

    if v_reason is null then
      -- A scheduled run never checks out by itself.
      v_policy := coalesce(s.policy, '{}'::jsonb)
        || jsonb_build_object('auto_checkout', false, 'auto_checkout_cap_usd', null);
      begin
        perform public.enqueue_shopping_run(v_list, s.connection_id, 'scheduled', v_policy);
        v_count := v_count + 1;
      exception when others then
        if sqlerrm in (
          'connection_not_found', 'connection_inactive', 'run_in_progress', 'daily_run_limit',
          'invalid_policy'
        ) then
          v_reason := sqlerrm;
        else
          v_reason := 'internal_error';
          raise warning 'enqueue_due_scheduled_runs: schedule % failed: %', s.id, sqlerrm;
        end if;
      end;
    end if;

    if v_reason is not null and v_reason <> 'already_shopped' then
      perform public.notification_outbox_add(
        s.household_id,
        'schedule_skipped',
        jsonb_build_object(
          'type', 'schedule_skipped',
          'scheduleId', s.id,
          'reason', v_reason,
          'weekStart', v_week
        ),
        p_now,
        'schedule_skipped:' || s.id || ':' || extract(epoch from s.next_run_at)::bigint
      );
    end if;

    v_next := public.scheduled_run_next(s.cron, s.tz, greatest(s.next_run_at, p_now));
    update public.scheduled_runs sr
    set last_enqueued_for = s.next_run_at, next_run_at = v_next
    where sr.id = s.id and sr.last_enqueued_for is distinct from sr.next_run_at;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.enqueue_due_scheduled_runs(timestamptz)
  from public, anon, authenticated;
grant execute on function public.enqueue_due_scheduled_runs(timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------
-- Generators: the notifications nothing else triggers
-- ---------------------------------------------------------------------------------------

-- weekly_nudge: from p_weekday at p_at (household time; 4 is Thursday, 17:00) until the week ends,
-- a household that has planned before and has nothing planned for next week gets one nudge, once
-- per week. Change the day and time by passing arguments from the cron job.
create or replace function public.enqueue_weekly_nudges(
  p_weekday integer default 4,
  p_at time default '17:00',
  p_now timestamptz default now()
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with local_now as (
    select h.id as household_id,
           (p_now at time zone coalesce(h.timezone, 'America/Los_Angeles')) as at_home
    from public.households h
    where h.deleted_at is null
  ),
  due as (
    select l.household_id, date_trunc('week', l.at_home)::date as this_week
    from local_now l
    where l.at_home >= date_trunc('week', l.at_home) + make_interval(days => p_weekday - 1) + p_at
  )
  insert into public.notification_outbox (household_id, type, payload, dedupe_key)
  select d.household_id,
         'weekly_nudge'::public.notification_type,
         jsonb_build_object('type', 'weekly_nudge', 'weekStart', (d.this_week + 7)::text),
         'weekly_nudge:' || d.household_id || ':' || (d.this_week + 7)
  from due d
  where exists (
      select 1 from public.household_members m where m.household_id = d.household_id
    )
    -- Only households that plan: a household that never opened the planner is not nagged.
    and exists (
      select 1
      from public.meal_plans p
      join public.meal_plan_entries e on e.plan_id = p.id
      where p.household_id = d.household_id
    )
    and not exists (
      select 1
      from public.meal_plans p
      join public.meal_plan_entries e on e.plan_id = p.id
      where p.household_id = d.household_id and p.week_start = d.this_week + 7
    )
  on conflict (dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- pickup_reminder: for a confirmed order with a recorded pickup window (orders.slot_start, WS12),
-- one reminder p_lead before the window opens. The orders table is WS12's and may not exist yet in
-- this database, so the statement is built at run time and the function does nothing until it does.
create or replace function public.enqueue_pickup_reminders(
  p_lead interval default interval '1 hour',
  p_now timestamptz default now()
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_orders text;
begin
  -- Looked up at run time, so the schema linter does not demand a table WS12 has not made yet.
  v_orders := to_regclass('public.orders')::text;
  if v_orders is null then
    return 0;
  end if;
  execute format($q$
    insert into public.notification_outbox (household_id, type, payload, deliver_after, dedupe_key)
    select o.household_id,
           'pickup_reminder'::public.notification_type,
           jsonb_build_object(
             'type', 'pickup_reminder',
             'orderId', o.id,
             'runId', o.run_id,
             'slotStart', to_char(o.slot_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
           ),
           greatest(o.slot_start - $1, $2),
           'pickup_reminder:' || o.id
    from %s o
    where o.status = 'confirmed'
      and o.slot_start is not null
      and o.slot_start > $2
      and o.slot_start - $1 <= $2 + interval '20 minutes'
    on conflict (dedupe_key) where dedupe_key is not null do nothing
  $q$, v_orders) using p_lead, p_now;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Runs both generators. One failing must not stop the other, so each is its own sub-transaction.
create or replace function public.enqueue_notification_generators()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  begin
    v_count := v_count + public.enqueue_weekly_nudges();
  exception when others then
    raise warning 'enqueue_weekly_nudges failed: %', sqlerrm;
  end;
  begin
    v_count := v_count + public.enqueue_pickup_reminders();
  exception when others then
    raise warning 'enqueue_pickup_reminders failed: %', sqlerrm;
  end;
  return v_count;
end;
$$;

-- Sent rows, and rows that never became sendable, do not stay: the outbox is a queue, not a log.
create or replace function public.notification_outbox_prune(p_keep interval default interval '14 days')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.notification_outbox o
  where o.sent_at < now() - p_keep
     or (o.sent_at is null and o.created_at < now() - p_keep);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.enqueue_weekly_nudges(integer, time, timestamptz)
  from public, anon, authenticated;
revoke all on function public.enqueue_pickup_reminders(interval, timestamptz)
  from public, anon, authenticated;
revoke all on function public.enqueue_notification_generators() from public, anon, authenticated;
revoke all on function public.notification_outbox_prune(interval) from public, anon, authenticated;
grant execute on function public.enqueue_weekly_nudges(integer, time, timestamptz)
  to service_role;
grant execute on function public.enqueue_pickup_reminders(interval, timestamptz)
  to service_role;
grant execute on function public.enqueue_notification_generators() to service_role;
grant execute on function public.notification_outbox_prune(interval) to service_role;

-- ---------------------------------------------------------------------------------------
-- Triggers: a failed run and a finished import
-- ---------------------------------------------------------------------------------------

-- cart_ready and needs_review are pushed by the worker itself. A run that fails is not: nobody
-- would know a Saturday run had stopped.
create or replace function public.shopping_runs_notify_failed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.notification_outbox_add(
    new.household_id,
    'run_failed',
    jsonb_build_object(
      'type', 'run_failed',
      'runId', new.id,
      'scheduled', new.trigger = 'scheduled'
    ),
    now(),
    'run_failed:' || new.id
  );
  return null;
end;
$$;

create trigger shopping_runs_notify_failed_row
  after update of status on public.shopping_runs
  for each row
  when (new.status = 'failed' and old.status is distinct from 'failed')
  execute function public.shopping_runs_notify_failed();

-- An import the person waited for needs no push; one that took long enough for them to leave the
-- screen does. recipe-import finishes a job inside the request, so this fires only for the slow ones.
create or replace function public.import_jobs_notify_done()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(new.finished_at, now()) - new.created_at < interval '20 seconds' then
    return null;
  end if;
  perform public.notification_outbox_add(
    new.household_id,
    'import_finished',
    jsonb_build_object(
      'type', 'import_finished',
      'importJobId', new.id,
      'recipeId', new.result_recipe_id
    ),
    now(),
    'import_finished:' || new.id
  );
  return null;
end;
$$;

create trigger import_jobs_notify_done_row
  after update of status on public.import_jobs
  for each row
  when (new.status = 'done' and old.status is distinct from 'done')
  execute function public.import_jobs_notify_done();

revoke all on function public.scheduled_runs_before_write() from public, anon, authenticated;
revoke all on function public.scheduled_runs_audit() from public, anon, authenticated;
revoke all on function public.shopping_runs_notify_failed() from public, anon, authenticated;
revoke all on function public.import_jobs_notify_done() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------
-- pg_cron. cron.schedule replaces a job of the same name, so a re-run of this file is safe.
-- ---------------------------------------------------------------------------------------

select cron.schedule(
  'enqueue-due-scheduled-runs',
  '*/5 * * * *',
  'select public.enqueue_due_scheduled_runs()'
);

select cron.schedule(
  'notification-generators',
  '*/15 * * * *',
  'select public.enqueue_notification_generators()'
);

select cron.schedule(
  'notification-outbox-prune',
  '41 4 * * *',
  'select public.notification_outbox_prune()'
);
