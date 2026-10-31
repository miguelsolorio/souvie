-- WS05: grocery lists and the pantry. docs/02-data-model.md §Lists and pantry, migration order 8.
--
-- Tables: grocery_lists, grocery_list_items, pantry_items. Also here: the triggers that keep an
-- item consistent with its list and make a check-off last-writer-wins, and the Realtime
-- publication for the two list tables.
--
-- Sort order: after the planning migration (a list points at a plan and its items at entries by
-- id), the ingredients migration (items and pantry rows point at ontology rows), and the identity
-- migrations (households, current_household_ids, set_updated_at).
--
-- Who writes what:
--   grocery_lists        the list-build Edge Function (service role) creates a week's list and
--                        rebuilds it. Members read it and may rename it, mark it shopped, set their
--                        aisle order, or soft delete it.
--   grocery_list_items   list-build writes the automatic items. Members check them off, edit the
--                        amount, unit and section, take an item off the list (excluded_reason), and
--                        add or delete items of their own (is_manual).
--   pantry_items         members mark an ingredient have, low or out, per household. No row means
--                        "the ingredient's default": a staple counts as have (docs/03 §6 step 4).
--
-- Columns beyond the docs/02 sketch, all additive and defaulted (see the "As built" note there):
--   grocery_lists.plan_fingerprint, section_order
--   grocery_list_items.qualifiers, edited, detail

-- ---------------------------------------------------------------------------------------
-- Enums (named <table>_<column>, docs/02 §Conventions)
-- ---------------------------------------------------------------------------------------

create type public.grocery_lists_status as enum ('draft', 'active', 'shopped');
create type public.grocery_list_items_excluded_reason as enum ('pantry', 'manual');
create type public.pantry_items_status as enum ('have', 'low', 'out');

-- ---------------------------------------------------------------------------------------
-- grocery_lists
-- ---------------------------------------------------------------------------------------

create table public.grocery_lists (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  -- Null for an ad-hoc list. A plan keeps its list if the plan row is ever removed.
  plan_id uuid references public.meal_plans (id) on delete set null,
  name text not null,
  status public.grocery_lists_status not null default 'active',
  -- When the items were last aggregated from the plan.
  built_at timestamptz,
  -- Build counter: 1 for the first build, +1 on every rebuild (meal_plans has no version counter).
  plan_version integer not null default 0,
  -- SHA-256 over the plan's entries as sorted (id, recipe_id, servings, status) tuples at build
  -- time. core.planFingerprint computes it here and on every phone; a difference is the
  -- "list is out of date" banner. Decided 2026-10-30: deletes leave no updated_at trace.
  plan_fingerprint text,
  -- The household's own aisle order for this list; null means core's default order.
  section_order text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint grocery_lists_name_length check (char_length(btrim(name)) between 1 and 120),
  constraint grocery_lists_plan_version_range check (plan_version >= 0),
  constraint grocery_lists_section_order_size check (
    section_order is null or cardinality(section_order) <= 40
  )
);

comment on table public.grocery_lists is
  'One live list per plan (WS05). list-build creates and rebuilds it; members use it.';
comment on column public.grocery_lists.plan_version is
  'Build counter: 1 for the first build, incremented on every rebuild.';
comment on column public.grocery_lists.plan_fingerprint is
  'SHA-256 of the plan''s entries (id, recipe_id, servings, status) when the list was built; the client recomputes it to show the out-of-date banner.';

-- One live list per plan: the build upserts on it.
create unique index grocery_lists_plan_live_key
  on public.grocery_lists (plan_id)
  where plan_id is not null and deleted_at is null;
-- The current list is the household's newest.
create index grocery_lists_household_created_idx
  on public.grocery_lists (household_id, created_at desc);

create trigger grocery_lists_set_updated_at
  before update on public.grocery_lists
  for each row execute function public.set_updated_at();

-- A list belongs to the same household as its plan. Runs as the caller, so a role under Row Level
-- Security cannot point a list at another household's plan (plan_not_found).
create or replace function public.grocery_lists_check_plan()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.plan_id is not null and not exists (
    select 1 from public.meal_plans p
    where p.id = new.plan_id and p.household_id = new.household_id
  ) then
    raise exception 'plan_not_found';
  end if;
  return new;
end;
$$;

create trigger grocery_lists_check_plan_row
  before insert or update of plan_id, household_id on public.grocery_lists
  for each row execute function public.grocery_lists_check_plan();

-- ---------------------------------------------------------------------------------------
-- grocery_list_items
-- ---------------------------------------------------------------------------------------

create table public.grocery_list_items (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.grocery_lists (id) on delete cascade,
  -- Denormalized from the list so the standard RLS policy and Realtime filters apply without a
  -- join. The sync trigger below overwrites whatever the caller sends.
  household_id uuid not null references public.households (id) on delete cascade,
  -- Null for a free-text item: a manual add, or a recipe line the parser could not place.
  ingredient_id uuid references public.ingredients (id) on delete set null,
  display_name text not null,
  qty numeric,
  unit text,
  -- meal_plan_entries that contributed; enables re-aggregation after a swap. Not a foreign key:
  -- an entry can be deleted while the list still shows what it once needed.
  source_entry_ids uuid[] not null default '{}',
  -- Aisle group: an ingredients.category, or "other".
  section text not null default 'other',
  checked boolean not null default false,
  -- Who last toggled the item and when, for last-writer-wins. Set to auth.uid() by the trigger.
  checked_by uuid references auth.users (id) on delete set null,
  checked_at timestamptz,
  excluded_reason public.grocery_list_items_excluded_reason,
  -- Unparsed line or an amount that could not be added up.
  needs_attention boolean not null default false,
  -- Added by hand, not from a recipe.
  is_manual boolean not null default false,
  position integer not null default 0,
  -- What the recipe lines asked for beyond the ingredient ("gluten-free"). Written by list-build.
  qualifiers text[] not null default '{}',
  -- True once a person edited the quantity, unit or section; a rebuild keeps those edits.
  edited boolean not null default false,
  -- The "Why this amount" data: contributions, rounding step, attention reason. core.ItemDetail
  -- is the schema, and list-build the only writer.
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint grocery_list_items_name_length check (char_length(btrim(display_name)) between 1 and 500),
  constraint grocery_list_items_qty_range check (qty is null or (qty >= 0 and qty <= 1000000)),
  constraint grocery_list_items_unit_length check (unit is null or char_length(unit) between 1 and 40),
  constraint grocery_list_items_section_length check (char_length(section) between 1 and 40),
  constraint grocery_list_items_position_range check (position between 0 and 1000000),
  constraint grocery_list_items_qualifiers_size check (cardinality(qualifiers) <= 8),
  constraint grocery_list_items_detail_object check (jsonb_typeof(detail) = 'object')
);

comment on table public.grocery_list_items is
  'A line of a grocery list (WS05). Automatic items come from list-build; is_manual items are typed in.';
comment on column public.grocery_list_items.checked_by is
  'The member who last toggled the item. A client may only send its own id; the trigger fills it.';
comment on column public.grocery_list_items.checked_at is
  'When the last toggle happened on the device that made it. An older toggle never overwrites a newer one.';
comment on column public.grocery_list_items.detail is
  'core.ItemDetail: { contributions, rounding, attention }. Written by list-build only.';

-- docs/02 §Indexes: the list screen reads a list's items in order.
create index grocery_list_items_list_position_idx on public.grocery_list_items (list_id, position);
-- The foreign key to ingredients.
create index grocery_list_items_ingredient_id_idx on public.grocery_list_items (ingredient_id);

create trigger grocery_list_items_set_updated_at
  before update on public.grocery_list_items
  for each row execute function public.set_updated_at();

-- Keeps an item in its list's household. Runs as the caller, so Row Level Security hides other
-- households' lists from it: an insert into someone else's list fails with list_not_found. Plain
-- error codes in the message, like the planning and identity functions.
create or replace function public.grocery_list_items_sync()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  list_household uuid;
begin
  select l.household_id into list_household
  from public.grocery_lists l
  where l.id = new.list_id and l.deleted_at is null;
  if not found then
    raise exception 'list_not_found';
  end if;
  new.household_id := list_household;
  return new;
end;
$$;

create trigger grocery_list_items_sync_row
  before insert or update of list_id on public.grocery_list_items
  for each row execute function public.grocery_list_items_sync();

-- The check-off rules, for a signed-in caller (the service role has no auth.uid() and is not held
-- to them: list-build never writes the three check columns).
--
--   * checked_by must be the caller. A client may send its own id (the replay queue does) or leave
--     it out; the trigger stamps it either way. Sending another member's id is refused.
--   * Last writer wins by checked_at. A toggle made offline arrives late; if the row already holds
--     a newer toggle, the late one is dropped silently and the row keeps the newer state. Nothing
--     is raised, so a replayed queue never gets stuck on a stale item.
--   * A device clock that runs ahead cannot win forever: checked_at is capped at five minutes past
--     the server's now().
create or replace function public.grocery_list_items_check_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  toggled boolean;
begin
  if uid is null then
    return new;
  end if;

  toggled :=
    new.checked is distinct from old.checked
    or new.checked_by is distinct from old.checked_by
    or new.checked_at is distinct from old.checked_at;
  if not toggled then
    return new;
  end if;

  if new.checked_by is not null and new.checked_by is distinct from old.checked_by
     and new.checked_by <> uid then
    raise exception 'checked_by_mismatch' using errcode = '42501';
  end if;

  new.checked_by := uid;
  new.checked_at := least(coalesce(new.checked_at, now()), now() + interval '5 minutes');

  -- A newer toggle is already on the row: keep it.
  if old.checked_at is not null and new.checked_at < old.checked_at then
    new.checked := old.checked;
    new.checked_by := old.checked_by;
    new.checked_at := old.checked_at;
  end if;
  return new;
end;
$$;

create trigger grocery_list_items_check_guard_row
  before update of checked, checked_by, checked_at on public.grocery_list_items
  for each row execute function public.grocery_list_items_check_guard();

-- ---------------------------------------------------------------------------------------
-- pantry_items
-- ---------------------------------------------------------------------------------------

create table public.pantry_items (
  household_id uuid not null references public.households (id) on delete cascade,
  ingredient_id uuid not null references public.ingredients (id) on delete cascade,
  status public.pantry_items_status not null,
  updated_at timestamptz not null default now(),

  primary key (household_id, ingredient_id)
);

comment on table public.pantry_items is
  'What a household has on hand (WS05). No row means the ingredient''s default: staples count as have.';

-- The foreign key to ingredients (the primary key covers household lookups).
create index pantry_items_ingredient_id_idx on public.pantry_items (ingredient_id);

create trigger pantry_items_set_updated_at
  before update on public.pantry_items
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------
-- Table privileges and RLS
-- ---------------------------------------------------------------------------------------
-- Supabase grants every API role all privileges on new tables in `public`. Narrow that, then let
-- policies pick the rows (supabase/README.md §RLS conventions). Anonymous users get nothing. The
-- service role keeps its default privileges and bypasses RLS.

revoke all on public.grocery_lists, public.grocery_list_items, public.pantry_items
  from anon, authenticated;

-- grocery_lists: members read. They can rename, mark shopped, order the aisles, and soft delete.
-- Only list-build creates a list, so there is no insert grant.
grant select on public.grocery_lists to authenticated;
grant update (name, status, section_order, deleted_at) on public.grocery_lists to authenticated;

-- grocery_list_items: a member adds items of their own (is_manual, enforced by the insert policy),
-- changes the check state and the amount, and deletes their own manual items. list_id and
-- household_id are fixed once the row exists; ingredient_id, source_entry_ids, qualifiers,
-- needs_attention and detail belong to list-build.
grant select, delete on public.grocery_list_items to authenticated;
grant insert (id, list_id, household_id, display_name, qty, unit, section, position, is_manual)
  on public.grocery_list_items to authenticated;
grant update (
  display_name, qty, unit, section, position, edited, excluded_reason,
  checked, checked_by, checked_at
) on public.grocery_list_items to authenticated;

-- pantry_items: the screen upserts a row per ingredient and deletes it to go back to the default.
grant select, delete on public.pantry_items to authenticated;
grant insert (household_id, ingredient_id, status) on public.pantry_items to authenticated;
grant update (status) on public.pantry_items to authenticated;

alter table public.grocery_lists enable row level security;
alter table public.grocery_list_items enable row level security;
alter table public.pantry_items enable row level security;

create policy "grocery_lists: members read" on public.grocery_lists
  for select to authenticated
  using (household_id in (select public.current_household_ids()));

create policy "grocery_lists: members update" on public.grocery_lists
  for update to authenticated
  using (household_id in (select public.current_household_ids()))
  with check (household_id in (select public.current_household_ids()));

create policy "grocery_list_items: members read" on public.grocery_list_items
  for select to authenticated
  using (household_id in (select public.current_household_ids()));

-- A client adds only items it typed itself. Automatic items are list-build's.
create policy "grocery_list_items: members insert manual" on public.grocery_list_items
  for insert to authenticated
  with check (household_id in (select public.current_household_ids()) and is_manual);

create policy "grocery_list_items: members update" on public.grocery_list_items
  for update to authenticated
  using (household_id in (select public.current_household_ids()))
  with check (household_id in (select public.current_household_ids()));

-- A client deletes only items it typed itself. To drop an automatic item it sets
-- excluded_reason = 'manual', which a rebuild respects.
create policy "grocery_list_items: members delete manual" on public.grocery_list_items
  for delete to authenticated
  using (household_id in (select public.current_household_ids()) and is_manual);

create policy "pantry_items: members read" on public.pantry_items
  for select to authenticated
  using (household_id in (select public.current_household_ids()));

create policy "pantry_items: members insert" on public.pantry_items
  for insert to authenticated
  with check (household_id in (select public.current_household_ids()));

create policy "pantry_items: members update" on public.pantry_items
  for update to authenticated
  using (household_id in (select public.current_household_ids()))
  with check (household_id in (select public.current_household_ids()));

create policy "pantry_items: members delete" on public.pantry_items
  for delete to authenticated
  using (household_id in (select public.current_household_ids()));

-- ---------------------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------------------
-- A check-off on one phone reaches the others' open list within seconds. Realtime applies RLS to
-- inserts and updates, so a member receives only their household's changes. It cannot apply RLS to
-- deletes, and it can filter a delete only when the old row is fully logged, hence replica
-- identity full on the items table: the client's list_id or household_id filter then also works
-- for deletes, and the payload a subscriber receives for a delete carries only the primary key.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end;
$$;

alter publication supabase_realtime add table public.grocery_lists, public.grocery_list_items;
alter table public.grocery_list_items replica identity full;
