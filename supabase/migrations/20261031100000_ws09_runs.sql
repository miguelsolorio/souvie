-- WS09: shopping runs. docs/02-data-model.md §Retail, migration order 11.
--
-- Tables: shopping_runs, shopping_run_items (also the write ledger for add-only carts), and
-- push_tokens (docs/02 sketch; WS11 extends it). Also here: the pgmq queue `shopping_run`, the
-- enqueue function the app and WS11's scheduler call, the cancel function, the dispatch function
-- run-approve uses, the run status guard, the retention job, and the Realtime publication entry.
--
-- Sort order: after the lists migration (a run shops one grocery list) and the retail migration
-- (a run uses one retailer connection).
--
-- Who writes what:
--   shopping_runs        enqueue_shopping_run creates a run (status queued) and sends its pgmq
--                        message. The worker (service role) moves it through the state machine,
--                        writes the transcript, the snapshot and the heartbeat. run-approve (service
--                        role) applies the review and moves needs_review -> running. Members read
--                        their household's runs and cancel one through cancel_shopping_run.
--   shopping_run_items   the worker writes the proposal and the ledger; run-approve writes the
--                        review decisions. Members read.
--   push_tokens          each signed-in user registers and removes their own device tokens.
--
-- Kroger's terms shape this file (docs/04-integrations.md §Kroger, docs/02 §Retention):
--   * shopping_run_items holds the product the household reviewed and the price it saw, as the
--     household's own purchase record. `alternatives` (up to three other candidates) and the run's
--     `cart_snapshot` are search-derived; both are cleared 24 hours after the run closes, by the
--     pg_cron job at the end of this file. The interval is the function's argument, so it can be
--     tightened without a schema change.
--   * No table here stores search results. Candidates live in the worker's memory for one run.
--
-- Columns beyond the docs/02 sketch (all additive; see the "As built (WS09)" note there):
--   shopping_runs.retailer, store_id, store_name   the store the run shopped, copied from the
--                                                  connection at enqueue time
--   shopping_runs.progress                         {phase, done, total} for the live progress line
--   shopping_runs.created_by                       who pressed "Shop this list" (null if scheduled)
--   shopping_runs.approved_at, approved_by         the review gate: set by run-approve
--   shopping_runs.status_changed_at, created_at, updated_at
--   shopping_run_items.position, display_name, section   the list line this row shops for
--   shopping_run_items.flags                       why the row needs the person's call
--   shopping_run_items.reason                      the model's or the code's one-line reason
--   shopping_run_items.cart_qty                    units the retailer confirmed in the cart

-- ---------------------------------------------------------------------------------------
-- Enums (named <table>_<column>, docs/02 §Conventions)
-- ---------------------------------------------------------------------------------------

create type public.shopping_runs_trigger as enum ('manual', 'scheduled');
create type public.shopping_runs_status as enum (
  'queued', 'running', 'needs_review', 'cart_ready', 'checking_out', 'checked_out', 'failed',
  'cancelled'
);
create type public.shopping_run_items_status as enum (
  'proposed', 'matched', 'substituted', 'unmatched', 'removed'
);
create type public.shopping_run_items_user_decision as enum ('accepted', 'swapped', 'removed');
create type public.push_tokens_platform as enum ('ios', 'android', 'web');

-- ---------------------------------------------------------------------------------------
-- RunPolicy in SQL. core.RunPolicy (packages/core/src/run.ts, CCR6) is the schema; these two
-- functions repeat it so a policy no TypeScript checked never reaches a run row.
-- ---------------------------------------------------------------------------------------

-- DEFAULT_RUN_POLICY. Change it together with packages/core/src/run.ts.
create or replace function public.shopping_run_default_policy()
returns jsonb
language sql
immutable
parallel safe
set search_path = ''
as $$
  select jsonb_build_object(
    'budget_cap_usd', null,
    'per_item_ceiling_usd', null,
    'substitution', 'same_brand',
    'auto_checkout', false,
    'auto_checkout_cap_usd', null,
    'max_tool_calls', 200,
    'max_wall_clock_seconds', 900
  )
$$;

-- True when `p` is a RunPolicy or a partial one: strict keys, the types and ranges of run.ts, and
-- auto_checkout only with a cap. Every test is guarded by jsonb_typeof, so a wrong type is false,
-- never a cast error.
create or replace function public.shopping_run_policy_is_valid(p jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(
    jsonb_typeof(p) = 'object'
    and not exists (
      select 1 from jsonb_object_keys(p) as k
      where k not in (
        'budget_cap_usd', 'per_item_ceiling_usd', 'substitution', 'auto_checkout',
        'auto_checkout_cap_usd', 'max_tool_calls', 'max_wall_clock_seconds'
      )
    )
    and (
      not (p ? 'budget_cap_usd')
      or case jsonb_typeof(p -> 'budget_cap_usd')
        when 'null' then true
        when 'number' then (p -> 'budget_cap_usd')::numeric > 0
        else false
      end
    )
    and (
      not (p ? 'per_item_ceiling_usd')
      or case jsonb_typeof(p -> 'per_item_ceiling_usd')
        when 'null' then true
        when 'number' then (p -> 'per_item_ceiling_usd')::numeric > 0
        else false
      end
    )
    and (
      not (p ? 'substitution')
      or (
        jsonb_typeof(p -> 'substitution') = 'string'
        and (p ->> 'substitution') in ('none', 'same_brand', 'any')
      )
    )
    and (not (p ? 'auto_checkout') or jsonb_typeof(p -> 'auto_checkout') = 'boolean')
    and (
      not (p ? 'auto_checkout_cap_usd')
      or case jsonb_typeof(p -> 'auto_checkout_cap_usd')
        when 'null' then true
        when 'number' then (p -> 'auto_checkout_cap_usd')::numeric > 0
        else false
      end
    )
    and (
      not (p ? 'max_tool_calls')
      or case jsonb_typeof(p -> 'max_tool_calls')
        when 'number' then
          (p -> 'max_tool_calls')::numeric between 1 and 1000
          and (p -> 'max_tool_calls')::numeric = trunc((p -> 'max_tool_calls')::numeric)
        else false
      end
    )
    and (
      not (p ? 'max_wall_clock_seconds')
      or case jsonb_typeof(p -> 'max_wall_clock_seconds')
        when 'number' then
          (p -> 'max_wall_clock_seconds')::numeric between 1 and 3600
          and (p -> 'max_wall_clock_seconds')::numeric
            = trunc((p -> 'max_wall_clock_seconds')::numeric)
        else false
      end
    )
    -- `auto_checkout` requires `auto_checkout_cap_usd` (run.ts refine).
    and (
      case
        when jsonb_typeof(p -> 'auto_checkout') = 'boolean' and (p -> 'auto_checkout')::boolean
          then jsonb_typeof(p -> 'auto_checkout_cap_usd') = 'number'
        else true
      end
    ),
    false
  )
$$;

-- ---------------------------------------------------------------------------------------
-- The run state machine. packages/agent/src/state.ts is the same table; the guard trigger below
-- enforces it for every writer, the service role included.
--
--   queued -> running -> needs_review -> running (push phase) -> cart_ready -> checking_out
--          -> checked_out, with failed and cancelled reachable from every active state, and
--   running -> queued when a worker hands a run back (shutdown, a retry).
-- ---------------------------------------------------------------------------------------

create or replace function public.shopping_run_transition_allowed(
  p_from public.shopping_runs_status,
  p_to public.shopping_runs_status
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select (p_from::text, p_to::text) in (
    ('queued', 'running'),
    ('queued', 'failed'),
    ('queued', 'cancelled'),
    ('running', 'queued'),
    ('running', 'needs_review'),
    ('running', 'cart_ready'),
    ('running', 'failed'),
    ('running', 'cancelled'),
    ('needs_review', 'running'),
    ('needs_review', 'failed'),
    ('needs_review', 'cancelled'),
    ('cart_ready', 'checking_out'),
    ('cart_ready', 'failed'),
    ('cart_ready', 'cancelled'),
    ('checking_out', 'checked_out'),
    ('checking_out', 'failed'),
    ('checking_out', 'cancelled')
  )
$$;

-- ---------------------------------------------------------------------------------------
-- shopping_runs
-- ---------------------------------------------------------------------------------------

create table public.shopping_runs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  list_id uuid not null references public.grocery_lists (id) on delete cascade,
  -- Null once the connection row is deleted; the run keeps its store below.
  connection_id uuid references public.retailer_connections (id) on delete set null,
  retailer public.retailer not null,
  store_id text,
  store_name text,
  trigger public.shopping_runs_trigger not null default 'manual',
  status public.shopping_runs_status not null default 'queued',
  -- core.RunPolicy, stored as is with the defaults filled in by enqueue_shopping_run.
  policy jsonb not null default public.shopping_run_default_policy(),
  -- The proposed cart shown at review: flags, summary, handoffUrl. Cleared 24h after the run
  -- closes (Kroger terms).
  cart_snapshot jsonb,
  -- The subtotal the household reviewed, then the one it approved.
  subtotal_usd numeric(12, 2),
  -- Array of {ts, tool, by, input, output_summary, ok, screenshot_path?}. No product data.
  transcript jsonb not null default '[]'::jsonb,
  error text,
  -- {phase, done, total}: the live progress line in the app.
  progress jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  -- The review gate. Set by run-approve; the push phase and checkout need it.
  approved_at timestamptz,
  approved_by uuid references auth.users (id) on delete set null,
  started_at timestamptz,
  finished_at timestamptz,
  -- Written by the worker every WORKER_HEARTBEAT_SECONDS while it holds the run; null while the
  -- run waits for a worker.
  heartbeat_at timestamptz,
  status_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint shopping_runs_policy_valid check (public.shopping_run_policy_is_valid(policy)),
  constraint shopping_runs_transcript_array check (jsonb_typeof(transcript) = 'array'),
  constraint shopping_runs_cart_snapshot_object check (
    cart_snapshot is null or jsonb_typeof(cart_snapshot) = 'object'
  ),
  constraint shopping_runs_progress_object check (jsonb_typeof(progress) = 'object'),
  constraint shopping_runs_subtotal_range check (
    subtotal_usd is null or (subtotal_usd >= 0 and subtotal_usd <= 100000)
  ),
  constraint shopping_runs_error_length check (error is null or char_length(error) <= 2000),
  constraint shopping_runs_store_id_format check (
    store_id is null or store_id ~ '^[A-Za-z0-9_-]{1,64}$'
  ),
  constraint shopping_runs_store_name_length check (
    store_name is null or char_length(store_name) <= 200
  )
);

comment on table public.shopping_runs is
  'One shopping run of one grocery list at one store (WS09). The worker moves it through the state machine.';
comment on column public.shopping_runs.cart_snapshot is
  'The proposed cart at review (flags, summary, handoffUrl). Cleared 24 hours after the run closes.';
comment on column public.shopping_runs.transcript is
  'Every tool call: {ts, tool, by, input, output_summary, ok}. Holds no product names or prices.';
comment on column public.shopping_runs.heartbeat_at is
  'Worker liveness. Null while the run waits for a worker; a stale value means the worker died.';

-- docs/02 §Indexes, plus the sweeper's lookup and the "one active run per list" check.
create index shopping_runs_household_created_idx
  on public.shopping_runs (household_id, created_at desc);
create index shopping_runs_list_idx on public.shopping_runs (list_id);
create index shopping_runs_connection_idx on public.shopping_runs (connection_id);
create index shopping_runs_active_heartbeat_idx
  on public.shopping_runs (heartbeat_at)
  where status in ('running', 'checking_out');
create index shopping_runs_closed_idx
  on public.shopping_runs (finished_at)
  where cart_snapshot is not null;

create trigger shopping_runs_set_updated_at
  before update on public.shopping_runs
  for each row execute function public.set_updated_at();

-- Refuses a status change the state machine does not allow, for every writer, and stamps the
-- timestamps that go with a status: started_at on the first running, finished_at when the run
-- reaches a resting state (cart_ready, checked_out, failed, cancelled), status_changed_at always.
create or replace function public.shopping_runs_status_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.status_changed_at := now();
    if new.status = 'running' and new.started_at is null then
      new.started_at := now();
    end if;
    return new;
  end if;

  if new.status = old.status then
    return new;
  end if;
  if not public.shopping_run_transition_allowed(old.status, new.status) then
    raise exception 'invalid_transition: % -> %', old.status, new.status
      using errcode = 'P0001';
  end if;

  new.status_changed_at := now();
  if new.status = 'running' and new.started_at is null then
    new.started_at := now();
  end if;
  if new.status in ('cart_ready', 'checked_out', 'failed', 'cancelled') then
    new.finished_at := now();
  else
    new.finished_at := null;
  end if;
  if new.status in ('checked_out', 'failed', 'cancelled', 'needs_review', 'cart_ready', 'queued') then
    new.heartbeat_at := null;
  end if;
  return new;
end;
$$;

create trigger shopping_runs_status_guard_row
  before insert or update of status on public.shopping_runs
  for each row execute function public.shopping_runs_status_guard();

-- ---------------------------------------------------------------------------------------
-- shopping_run_items: one per list item per run, and the write ledger
-- ---------------------------------------------------------------------------------------

create table public.shopping_run_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.shopping_runs (id) on delete cascade,
  -- Copied from the run by the sync trigger below, whatever the writer sends.
  household_id uuid not null references public.households (id) on delete cascade,
  list_item_id uuid references public.grocery_list_items (id) on delete set null,
  position integer not null default 0,
  -- The list line as the household wrote it ("Penne (gluten-free)"), kept if the line goes away.
  display_name text not null,
  section text not null default 'other',
  -- The chosen product, as the retailer returned it. Null while unmatched.
  product_id text,
  upc text,
  product_name text,
  size text,
  -- Units to buy, a whole number for a cart.
  qty numeric,
  -- At review time: the promotional price when there is one, else the regular price.
  unit_price_usd numeric(12, 2),
  line_total_usd numeric(12, 2),
  status public.shopping_run_items_status not null default 'proposed',
  -- Up to 3 {product_id, upc, name, size, price, qty} shown at review. Cleared with cart_snapshot.
  alternatives jsonb,
  user_decision public.shopping_run_items_user_decision,
  -- [{kind, detail}]: why the row needs the person's call (allergen, budget, substitution, ...).
  flags jsonb not null default '[]'::jsonb,
  reason text,
  -- The ledger. Before each cart call: delta_sent = cart_qty + the delta, sent_at = now(),
  -- delta_result = null. After it: delta_result = '204' (and cart_qty = delta_sent) or the error.
  -- A row with delta_sent and no delta_result is a call that was in flight when a worker died.
  delta_sent numeric,
  cart_qty numeric not null default 0,
  sent_at timestamptz,
  delta_result text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint shopping_run_items_display_name_length check (
    char_length(btrim(display_name)) between 1 and 500
  ),
  constraint shopping_run_items_section_length check (char_length(section) between 1 and 40),
  constraint shopping_run_items_product_id_format check (
    product_id is null or product_id ~ '^[A-Za-z0-9_-]{1,64}$'
  ),
  constraint shopping_run_items_upc_format check (upc is null or upc ~ '^[0-9]{8,14}$'),
  constraint shopping_run_items_product_name_length check (
    product_name is null or char_length(product_name) between 1 and 500
  ),
  constraint shopping_run_items_size_length check (size is null or char_length(size) <= 100),
  constraint shopping_run_items_qty_range check (qty is null or (qty >= 0 and qty <= 1000)),
  constraint shopping_run_items_price_range check (
    (unit_price_usd is null or unit_price_usd >= 0)
    and (line_total_usd is null or line_total_usd >= 0)
  ),
  constraint shopping_run_items_alternatives_shape check (
    alternatives is null
    or (jsonb_typeof(alternatives) = 'array' and jsonb_array_length(alternatives) <= 3)
  ),
  constraint shopping_run_items_flags_array check (jsonb_typeof(flags) = 'array'),
  constraint shopping_run_items_reason_length check (reason is null or char_length(reason) <= 500),
  constraint shopping_run_items_delta_result_length check (
    delta_result is null or char_length(delta_result) <= 500
  ),
  constraint shopping_run_items_cart_qty_range check (cart_qty >= 0 and cart_qty <= 1000),
  constraint shopping_run_items_position_range check (position between 0 and 1000000)
);

comment on table public.shopping_run_items is
  'One row per list item per run (WS09): the proposal, the review decision, and the add-only cart ledger.';
comment on column public.shopping_run_items.alternatives is
  'Up to three other candidates for review. Search-derived: cleared 24 hours after the run closes.';
comment on column public.shopping_run_items.delta_sent is
  'Total units this run has sent for the row, including a call in flight. Written before the call.';
comment on column public.shopping_run_items.cart_qty is
  'Units the retailer confirmed in the cart for this row. Corrections send cart_qty - qty as a negative delta.';

create index shopping_run_items_run_position_idx
  on public.shopping_run_items (run_id, position);
create index shopping_run_items_list_item_idx on public.shopping_run_items (list_item_id);
create index shopping_run_items_household_idx on public.shopping_run_items (household_id);

create trigger shopping_run_items_set_updated_at
  before update on public.shopping_run_items
  for each row execute function public.set_updated_at();

-- Keeps an item in its run's household. The worker writes household_id itself, but nothing else
-- may decide it.
create or replace function public.shopping_run_items_sync()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  run_household uuid;
begin
  select r.household_id into run_household
  from public.shopping_runs r
  where r.id = new.run_id;
  if not found then
    raise exception 'run_not_found';
  end if;
  new.household_id := run_household;
  return new;
end;
$$;

create trigger shopping_run_items_sync_row
  before insert or update of run_id, household_id on public.shopping_run_items
  for each row execute function public.shopping_run_items_sync();

-- ---------------------------------------------------------------------------------------
-- push_tokens (docs/02 sketch; WS11 extends it with notification preferences)
-- ---------------------------------------------------------------------------------------

create table public.push_tokens (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  token text not null,
  platform public.push_tokens_platform not null,
  updated_at timestamptz not null default now(),

  primary key (user_id, token),
  constraint push_tokens_token_length check (char_length(token) between 1 and 400)
);

comment on table public.push_tokens is
  'Expo push tokens per user and device (WS09; WS11 extends). Each user reads and writes only their own.';

create index push_tokens_token_idx on public.push_tokens (token);

create trigger push_tokens_set_updated_at
  before update on public.push_tokens
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------
-- Table privileges and RLS (supabase/README.md §RLS conventions)
-- ---------------------------------------------------------------------------------------

revoke all on public.shopping_runs, public.shopping_run_items, public.push_tokens
  from anon, authenticated;

-- Runs and their items are written by the worker, run-approve, and the functions below.
grant select on public.shopping_runs to authenticated;
grant select on public.shopping_run_items to authenticated;

grant select, delete on public.push_tokens to authenticated;
grant insert (user_id, token, platform) on public.push_tokens to authenticated;
grant update (platform, updated_at) on public.push_tokens to authenticated;

alter table public.shopping_runs enable row level security;
alter table public.shopping_run_items enable row level security;
alter table public.push_tokens enable row level security;

create policy "shopping_runs: members read" on public.shopping_runs
  for select to authenticated
  using (household_id in (select public.current_household_ids()));

create policy "shopping_run_items: members read" on public.shopping_run_items
  for select to authenticated
  using (household_id in (select public.current_household_ids()));

create policy "push_tokens: own read" on public.push_tokens
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "push_tokens: own insert" on public.push_tokens
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "push_tokens: own update" on public.push_tokens
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "push_tokens: own delete" on public.push_tokens
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------------------
-- The queue (Supabase Queues). The worker reads it; enqueue_shopping_run and
-- shopping_run_dispatch write it. Messages are {"run_id": "<uuid>"}.
-- ---------------------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pgmq.list_queues() q where q.queue_name = 'shopping_run') then
    perform pgmq.create('shopping_run');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- enqueue_shopping_run: "Shop this list" in the app, and WS11's scheduler.
--
-- A signed-in member may start a manual run of their household's list at one of their
-- household's active connections. With no signed-in user (the service role, pg_cron) the run may
-- be manual or scheduled. Refusals are plain error codes in the message, like the other
-- functions: list_not_found (also for a list of another household), connection_not_found,
-- connection_inactive, invalid_trigger, invalid_policy, run_in_progress, daily_run_limit.
-- ---------------------------------------------------------------------------------------

create or replace function public.enqueue_shopping_run(
  list_id uuid,
  connection_id uuid,
  trigger text,
  policy jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_household uuid;
  v_retailer public.retailer;
  v_store_id text;
  v_store_name text;
  v_status public.retailer_connections_status;
  v_trigger text := coalesce(enqueue_shopping_run.trigger, 'manual');
  v_policy jsonb := coalesce(enqueue_shopping_run.policy, '{}'::jsonb);
  v_run uuid;
begin
  if v_trigger not in ('manual', 'scheduled') then
    raise exception 'invalid_trigger';
  end if;
  -- A person starts a run by hand. Only the scheduler, with no user, starts a scheduled one.
  if v_uid is not null and v_trigger <> 'manual' then
    raise exception 'invalid_trigger';
  end if;

  select l.household_id into v_household
  from public.grocery_lists l
  join public.households h on h.id = l.household_id and h.deleted_at is null
  where l.id = enqueue_shopping_run.list_id and l.deleted_at is null;
  if v_household is null then
    raise exception 'list_not_found';
  end if;
  if v_uid is not null and not exists (
    select 1 from public.household_members m
    where m.household_id = v_household and m.user_id = v_uid
  ) then
    raise exception 'list_not_found';
  end if;

  select c.retailer, c.store_id, c.store_name, c.status
    into v_retailer, v_store_id, v_store_name, v_status
  from public.retailer_connections c
  where c.id = enqueue_shopping_run.connection_id and c.household_id = v_household;
  if v_retailer is null then
    raise exception 'connection_not_found';
  end if;
  if v_status <> 'active' then
    raise exception 'connection_inactive';
  end if;

  if not public.shopping_run_policy_is_valid(v_policy) then
    raise exception 'invalid_policy';
  end if;
  v_policy := public.shopping_run_default_policy() || v_policy;
  if not public.shopping_run_policy_is_valid(v_policy) then
    raise exception 'invalid_policy';
  end if;

  -- One active run per list: a second tap does not start a second agent.
  perform pg_advisory_xact_lock(hashtextextended('shopping-run:' || enqueue_shopping_run.list_id::text, 0));
  if exists (
    select 1 from public.shopping_runs r
    where r.list_id = enqueue_shopping_run.list_id
      and r.status in ('queued', 'running', 'needs_review', 'checking_out')
  ) then
    raise exception 'run_in_progress';
  end if;

  -- docs/05 §Money: a daily maximum number of runs per household.
  if (
    select count(*) from public.shopping_runs r
    where r.household_id = v_household and r.created_at > now() - interval '1 day'
  ) >= 20 then
    raise exception 'daily_run_limit';
  end if;

  insert into public.shopping_runs (
    household_id, list_id, connection_id, retailer, store_id, store_name, trigger, status,
    policy, created_by
  ) values (
    v_household, enqueue_shopping_run.list_id, enqueue_shopping_run.connection_id, v_retailer,
    v_store_id, v_store_name, v_trigger::public.shopping_runs_trigger, 'queued', v_policy, v_uid
  )
  returning id into v_run;

  perform pgmq.send('shopping_run'::text, jsonb_build_object('run_id', v_run), 0);
  return v_run;
end;
$$;

-- A member cancels an active run. The worker checks the status between steps and stops.
create or replace function public.cancel_shopping_run(run_id uuid)
returns public.shopping_runs_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_household uuid;
  v_status public.shopping_runs_status;
begin
  select r.household_id, r.status into v_household, v_status
  from public.shopping_runs r
  where r.id = cancel_shopping_run.run_id
  for update;
  if v_household is null or (
    v_uid is not null and not exists (
      select 1 from public.household_members m
      where m.household_id = v_household and m.user_id = v_uid
    )
  ) then
    raise exception 'run_not_found';
  end if;
  if v_status not in ('queued', 'running', 'needs_review', 'cart_ready', 'checking_out') then
    raise exception 'not_cancellable';
  end if;
  update public.shopping_runs r
  set status = 'cancelled', error = null
  where r.id = cancel_shopping_run.run_id;
  return 'cancelled';
end;
$$;

-- Sends a run's queue message again: run-approve after an approval, with no pgmq grant to the
-- service role. Service role only.
create or replace function public.shopping_run_dispatch(run_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_msg bigint;
begin
  if not exists (select 1 from public.shopping_runs r where r.id = shopping_run_dispatch.run_id) then
    raise exception 'run_not_found';
  end if;
  select s into v_msg
  from pgmq.send('shopping_run'::text, jsonb_build_object('run_id', shopping_run_dispatch.run_id), 0) s;
  return v_msg;
end;
$$;

revoke all on function public.enqueue_shopping_run(uuid, uuid, text, jsonb) from public, anon;
revoke all on function public.cancel_shopping_run(uuid) from public, anon;
revoke all on function public.shopping_run_dispatch(uuid) from public, anon, authenticated;
grant execute on function public.enqueue_shopping_run(uuid, uuid, text, jsonb)
  to authenticated, service_role;
grant execute on function public.cancel_shopping_run(uuid) to authenticated, service_role;
grant execute on function public.shopping_run_dispatch(uuid) to service_role;

-- ---------------------------------------------------------------------------------------
-- Retention (docs/02 §Retention, Kroger terms): 24 hours after a run closes, its cart_snapshot is
-- cleared and its items' alternatives are nulled. The approved product, quantity and price stay
-- as the household's own purchase record. `p_after` is the config: lower it to tighten.
-- ---------------------------------------------------------------------------------------

create or replace function public.shopping_runs_clear_expired(
  p_after interval default interval '24 hours'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_runs integer;
begin
  update public.shopping_run_items i
  set alternatives = null
  from public.shopping_runs r
  where i.run_id = r.id
    and i.alternatives is not null
    and r.status in ('cart_ready', 'checked_out', 'failed', 'cancelled')
    and r.finished_at < now() - p_after;

  update public.shopping_runs r
  set cart_snapshot = null
  where r.cart_snapshot is not null
    and r.status in ('cart_ready', 'checked_out', 'failed', 'cancelled')
    and r.finished_at < now() - p_after;
  get diagnostics v_runs = row_count;
  return v_runs;
end;
$$;

revoke all on function public.shopping_runs_clear_expired(interval)
  from public, anon, authenticated;
grant execute on function public.shopping_runs_clear_expired(interval) to service_role;

-- Every hour. cron.schedule replaces a job of the same name, so a re-run of this file is safe.
select cron.schedule(
  'shopping-runs-retention',
  '17 * * * *',
  'select public.shopping_runs_clear_expired()'
);

-- ---------------------------------------------------------------------------------------
-- Realtime: the run screen follows status and progress live. Realtime applies RLS to inserts and
-- updates, so a member receives only their household's runs. Runs are never deleted by a client,
-- so the default replica identity is enough. shopping_run_items is not published: the screen
-- refetches the items when the run's status changes.
-- ---------------------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end;
$$;

alter publication supabase_realtime add table public.shopping_runs;
