-- WS12: orders and history. docs/02-data-model.md §Retail (orders) and §Views, migration order 14.
--
-- Objects: the orders table and its enum, the confirm_order function the app calls when a person
-- says "I placed it", and three views for the History screens: v_meals_cooked_weekly,
-- v_spend_weekly_by_store and v_most_bought_products.
--
-- Sort order: after the runs migration (an order points at a run) and the retail migration (the
-- most-bought view reads product_matches).
--
-- Who writes what:
--   orders   no retailer exposes order history through an API, so a row is the household's own
--            record: the run ledger plus a person's confirmation (R19: a run reaching cart_ready
--            is not an order). Members confirm through confirm_order and may correct the total,
--            the window, the order number, the notes and the status afterwards. They cannot
--            insert, delete, or move an order to another run or household. The service role
--            writes directly (WS10 records a Tier 3 order from the confirmation page).
--   views    read only, security_invoker, so the caller's row level security decides every row.
--
-- Kroger's terms shape this file (docs/04-integrations.md §Kroger, docs/06-risks.md R21):
--   * orders keeps one amount, the total a person entered. The views read amounts and names the
--     run ledger already holds for the run itself, as the household's purchase record.
--   * Nothing here stores a history of amounts for a product outside a specific run. Spend is
--     summed from order totals; "most bought" counts rows of confirmed orders and carries a
--     name, never an amount.
--   * No descriptions, images, or catalog fields are kept.
--
-- Timezone. Weeks are Monday to Sunday in the household's zone. The zone comes from one function,
-- history_time_zone(household), which returns the app's launch zone for now. When households
-- gain their own zone column (WS11), replace that function's body and nothing else changes.

-- ---------------------------------------------------------------------------------------
-- Enum (named <table>_<column>, docs/02 §Conventions)
-- ---------------------------------------------------------------------------------------

create type public.orders_status as enum ('confirmed', 'picked_up', 'delivered', 'cancelled');

-- ---------------------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------------------

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  -- Copied from the run by the sync trigger below, whatever the writer sends.
  household_id uuid not null references public.households (id) on delete cascade,
  -- One order per run. An order follows its run: runs are never deleted by a client, and a
  -- household delete removes both.
  run_id uuid not null references public.shopping_runs (id) on delete cascade,
  -- Copied from the run, like household_id.
  retailer public.retailer not null,
  -- The store's own order number. Optional: the person may paste it.
  retailer_order_id text,
  modality public.retailer_connections_modality not null,
  slot_start timestamptz,
  slot_end timestamptz,
  -- What the person says they paid, entered at confirmation (prefilled with the run subtotal), or
  -- the confirmation page total for a Tier 3 order.
  total_usd numeric(12, 2) not null,
  status public.orders_status not null default 'confirmed',
  -- Null for a Tier 3 order recorded by the worker, and after the person's account is gone.
  confirmed_by uuid default auth.uid() references auth.users (id) on delete set null,
  confirmed_at timestamptz not null default now(),
  notes text,
  -- Tier 3 confirmation details. Never written by a client.
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint orders_run_key unique (run_id),
  constraint orders_total_range check (total_usd >= 0 and total_usd <= 100000),
  constraint orders_retailer_order_id_length check (
    retailer_order_id is null or char_length(btrim(retailer_order_id)) between 1 and 100
  ),
  constraint orders_notes_length check (notes is null or char_length(notes) <= 1000),
  constraint orders_raw_object check (raw is null or jsonb_typeof(raw) = 'object'),
  -- A window needs a start; an end after the start; and no longer than a day (a delivery window).
  constraint orders_window_needs_start check (slot_end is null or slot_start is not null),
  constraint orders_window_order check (slot_end is null or slot_end > slot_start),
  constraint orders_window_length check (
    slot_end is null or slot_end - slot_start <= interval '24 hours'
  ),
  -- Postgres cannot drop an enum value, so a constraint keeps the retired retailer out (CCR9).
  constraint orders_no_instacart check (retailer <> 'instacart')
);

comment on table public.orders is
  'An order the household says it placed (WS12): the run ledger plus a person''s confirmation. No retailer exposes order history through an API.';
comment on column public.orders.total_usd is
  'What the person entered, prefilled with the run subtotal; the confirmation page total for a Tier 3 order.';
comment on column public.orders.confirmed_by is
  'The member who said "I placed it". Null for a Tier 3 order recorded by the worker.';
comment on column public.orders.raw is
  'Tier 3 confirmation details (WS10). Service role only.';

-- docs/02 §Indexes: history reads a household's orders newest first. The pickup index serves the
-- reminder job (WS11), which looks for confirmed orders with a window ahead.
create index orders_household_created_idx on public.orders (household_id, created_at desc);
create index orders_household_confirmed_idx on public.orders (household_id, confirmed_at desc);
create index orders_pickup_idx
  on public.orders (slot_start)
  where status = 'confirmed' and slot_start is not null;

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

-- Keeps an order in its run's household and retailer. Nothing else may decide either, so a row
-- written by any role cannot point at one household's run and another's data.
create or replace function public.orders_sync()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_household uuid;
  v_retailer public.retailer;
begin
  select r.household_id, r.retailer into v_household, v_retailer
  from public.shopping_runs r
  where r.id = new.run_id;
  if not found then
    raise exception 'run_not_found';
  end if;
  new.household_id := v_household;
  new.retailer := v_retailer;
  return new;
end;
$$;

create trigger orders_sync_row
  before insert or update of run_id, household_id, retailer on public.orders
  for each row execute function public.orders_sync();

-- ---------------------------------------------------------------------------------------
-- Table privileges and RLS (supabase/README.md §RLS conventions)
-- ---------------------------------------------------------------------------------------

revoke all on public.orders from anon, authenticated;

grant select on public.orders to authenticated;
-- A person can correct what they entered. The run, household, retailer, who confirmed and when
-- are fixed once the row exists.
grant update (modality, slot_start, slot_end, total_usd, retailer_order_id, notes, status)
  on public.orders to authenticated;

alter table public.orders enable row level security;

create policy "orders: members read" on public.orders
  for select to authenticated
  using (household_id in (select public.current_household_ids()));

create policy "orders: members update" on public.orders
  for update to authenticated
  using (household_id in (select public.current_household_ids()))
  with check (household_id in (select public.current_household_ids()));

-- ---------------------------------------------------------------------------------------
-- confirm_order: "I placed it".
--
-- A signed-in member records the order for a run of their household that the household approved
-- and whose cart is ready (or checked out). The run decides the household and retailer. The
-- modality defaults to the run's connection, then to pickup. Refusals are plain error codes in
-- the message, like the other functions: not_authenticated, run_not_found (also for another
-- household's run), run_not_confirmable, already_confirmed, invalid_total, invalid_window.
-- ---------------------------------------------------------------------------------------

create or replace function public.confirm_order(
  run_id uuid,
  total_usd numeric,
  modality public.retailer_connections_modality default null,
  slot_start timestamptz default null,
  slot_end timestamptz default null,
  retailer_order_id text default null,
  notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_household uuid;
  v_status public.shopping_runs_status;
  v_approved timestamptz;
  v_connection uuid;
  v_modality public.retailer_connections_modality;
  v_order uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select r.household_id, r.status, r.approved_at, r.connection_id
    into v_household, v_status, v_approved, v_connection
  from public.shopping_runs r
  join public.households h on h.id = r.household_id and h.deleted_at is null
  where r.id = confirm_order.run_id;
  if v_household is null or not exists (
    select 1 from public.household_members m
    where m.household_id = v_household and m.user_id = v_uid
  ) then
    raise exception 'run_not_found';
  end if;

  -- R19: only a cart the household approved and the store filled can become an order.
  if v_approved is null or v_status not in ('cart_ready', 'checked_out') then
    raise exception 'run_not_confirmable';
  end if;

  if confirm_order.total_usd is null
    or confirm_order.total_usd < 0 or confirm_order.total_usd > 100000 then
    raise exception 'invalid_total';
  end if;
  if (confirm_order.slot_end is not null and confirm_order.slot_start is null)
    or (confirm_order.slot_end is not null and confirm_order.slot_end <= confirm_order.slot_start)
    or (
      confirm_order.slot_end is not null
      and confirm_order.slot_end - confirm_order.slot_start > interval '24 hours'
    ) then
    raise exception 'invalid_window';
  end if;

  if exists (select 1 from public.orders o where o.run_id = confirm_order.run_id) then
    raise exception 'already_confirmed';
  end if;

  v_modality := confirm_order.modality;
  if v_modality is null and v_connection is not null then
    select c.modality into v_modality
    from public.retailer_connections c
    where c.id = v_connection and c.household_id = v_household;
  end if;
  v_modality := coalesce(v_modality, 'pickup');

  begin
    insert into public.orders (
      household_id, run_id, retailer, retailer_order_id, modality, slot_start, slot_end,
      total_usd, status, confirmed_by, confirmed_at, notes
    )
    select v_household, confirm_order.run_id, r.retailer,
           nullif(btrim(confirm_order.retailer_order_id), ''), v_modality,
           confirm_order.slot_start, confirm_order.slot_end, round(confirm_order.total_usd, 2),
           'confirmed', v_uid, now(), nullif(btrim(confirm_order.notes), '')
    from public.shopping_runs r
    where r.id = confirm_order.run_id
    returning id into v_order;
  exception
    -- Two taps at once: the unique key on run_id decides, and the loser gets the same answer.
    when unique_violation then
      raise exception 'already_confirmed';
  end;
  return v_order;
end;
$$;

revoke all on function public.confirm_order(
  uuid, numeric, public.retailer_connections_modality, timestamptz, timestamptz, text, text
) from public, anon;
grant execute on function public.confirm_order(
  uuid, numeric, public.retailer_connections_modality, timestamptz, timestamptz, text, text
) to authenticated;

-- ---------------------------------------------------------------------------------------
-- The household's time zone for week boundaries. One function so there is one place to change.
-- Today it is the launch zone for every household; WS11 adds the household's own zone.
-- ---------------------------------------------------------------------------------------

create or replace function public.history_time_zone(household_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select 'America/Los_Angeles'::text
$$;

revoke all on function public.history_time_zone(uuid) from public, anon;
grant execute on function public.history_time_zone(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- Views. security_invoker makes every underlying table's row level security apply to the caller,
-- so a member reads only their household's rows through them. Postgres 17.
-- ---------------------------------------------------------------------------------------

-- Cooked meals per household per week of the plan. Only weeks with something cooked have a row.
-- entries is an array of {id, date, slot, recipe_id, title}, oldest first. The week is the
-- plan's own week_start, so no zone is involved.
create or replace view public.v_meals_cooked_weekly
with (security_invoker = true) as
select
  e.household_id,
  p.week_start,
  count(*)::integer as cooked_count,
  jsonb_agg(
    jsonb_build_object(
      'id', e.id,
      'date', e.date,
      'slot', e.slot,
      'recipe_id', e.recipe_id,
      'title', r.title
    )
    order by e.date, e.slot, e.position, e.id
  ) as entries
from public.meal_plan_entries e
join public.meal_plans p on p.id = e.plan_id
left join public.recipes r on r.id = e.recipe_id
where e.status = 'cooked'
group by e.household_id, p.week_start;

-- What a household spent per week and store: the sum of its orders' totals, cancelled orders
-- left out. The store is the one the run shopped, as the run recorded it.
create or replace view public.v_spend_weekly_by_store
with (security_invoker = true) as
select
  o.household_id,
  (date_trunc('week', o.confirmed_at at time zone public.history_time_zone(o.household_id)))::date
    as week_start,
  o.retailer,
  r.store_name,
  sum(o.total_usd)::numeric(12, 2) as total_usd,
  count(*)::integer as order_count
from public.orders o
join public.shopping_runs r on r.id = o.run_id
where o.status <> 'cancelled'
group by
  o.household_id,
  date_trunc('week', o.confirmed_at at time zone public.history_time_zone(o.household_id)),
  o.retailer,
  r.store_name;

-- Products a household buys most, from the lines of its confirmed orders. A line counts when the
-- run was approved and the store's cart holds it (cart_qty > 0), not on status alone. One row
-- per (retailer, store, ingredient, product): the key product_matches uses, so the app can pin
-- the row without another lookup. ingredient_id is null for a free-text line, which cannot be
-- pinned. pinned reads product_matches. A name, size and store name are the latest the household
-- saw. No amounts are carried.
create or replace view public.v_most_bought_products
with (security_invoker = true) as
select
  o.household_id,
  o.retailer,
  r.store_id,
  (array_agg(r.store_name order by o.confirmed_at desc, i.id) filter (where r.store_name is not null))[1]
    as store_name,
  gli.ingredient_id,
  i.product_id,
  (array_agg(i.upc order by o.confirmed_at desc, i.id) filter (where i.upc is not null))[1]
    as upc,
  (array_agg(i.product_name order by o.confirmed_at desc, i.id))[1] as product_name,
  (array_agg(i.size order by o.confirmed_at desc, i.id) filter (where i.size is not null))[1]
    as size,
  count(*)::integer as times_bought,
  sum(i.cart_qty) as units_bought,
  max(o.confirmed_at) as last_bought_at,
  coalesce(bool_or(pm.pinned), false) as pinned
from public.orders o
join public.shopping_runs r on r.id = o.run_id
join public.shopping_run_items i on i.run_id = r.id and i.household_id = o.household_id
left join public.grocery_list_items gli on gli.id = i.list_item_id
left join public.product_matches pm
  on pm.household_id = o.household_id
  and pm.retailer = o.retailer
  and pm.store_id = r.store_id
  and pm.ingredient_id = gli.ingredient_id
  and pm.product_id = i.product_id
where o.status <> 'cancelled'
  and r.approved_at is not null
  and i.product_id is not null
  and i.status in ('matched', 'substituted')
  and i.user_decision is distinct from 'removed'
  and i.cart_qty > 0
group by o.household_id, o.retailer, r.store_id, gli.ingredient_id, i.product_id
order by times_bought desc, last_bought_at desc;

comment on view public.v_meals_cooked_weekly is
  'Cooked meals per household per plan week (WS12). security_invoker.';
comment on view public.v_spend_weekly_by_store is
  'Sum of order totals per household, week, retailer and store (WS12). Weeks are Monday to Sunday in history_time_zone(). security_invoker.';
comment on view public.v_most_bought_products is
  'Products on confirmed orders, most bought first, with product_matches.pinned (WS12). security_invoker.';

revoke all on public.v_meals_cooked_weekly, public.v_spend_weekly_by_store,
  public.v_most_bought_products
  from anon, authenticated;
grant select on public.v_meals_cooked_weekly, public.v_spend_weekly_by_store,
  public.v_most_bought_products
  to authenticated;
