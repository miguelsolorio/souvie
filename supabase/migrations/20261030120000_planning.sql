-- WS04: planning. docs/02-data-model.md §Planning, migration order 7.
--
-- Tables: meal_plans, meal_plan_entries, recipe_feedback. Also here: the trigger that keeps an
-- entry's household and week consistent with its plan, the trigger that writes the planner's
-- feedback signals, and the Realtime publication for the two plan tables.
--
-- Sort order: after the recipes migration (entries and feedback reference recipes) and after the
-- identity migrations (households, current_household_ids, set_updated_at).
--
-- Who writes what:
--   meal_plans            members create the row for a week (lazily, on the first entry). Nobody
--                         updates or deletes it from a client. The suggest Edge Function (WS06)
--                         writes through the service role.
--   meal_plan_entries     members insert, edit (column-level), and delete entries for their
--                         household. The service role (suggest, WS06) writes drafts.
--   recipe_feedback       members insert like and dislike rows for themselves and delete their
--                         own. saved, cooked, and skipped come from the trigger below, so the
--                         entry change and its signal commit together. The service role writes
--                         the calibration seeds (WS06).

-- ---------------------------------------------------------------------------------------
-- Enums (named <table>_<column>, docs/02 §Conventions)
-- ---------------------------------------------------------------------------------------

create type public.meal_plan_entries_slot as enum ('breakfast', 'lunch', 'dinner', 'snack');
create type public.meal_plan_entries_status as enum ('planned', 'cooked', 'skipped');
create type public.recipe_feedback_signal as enum ('like', 'dislike', 'cooked', 'skipped', 'saved');

-- ---------------------------------------------------------------------------------------
-- meal_plans
-- ---------------------------------------------------------------------------------------

create table public.meal_plans (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  -- The Monday of the week (ISO weeks). core.weekStartFor computes it.
  week_start date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint meal_plans_household_week_key unique (household_id, week_start),
  constraint meal_plans_week_start_monday check (extract(isodow from week_start) = 1)
);

comment on table public.meal_plans is
  'One plan per household per week (WS04). Created lazily on the first entry, never on view.';
comment on column public.meal_plans.week_start is 'The Monday of the plan''s week.';

create trigger meal_plans_set_updated_at
  before update on public.meal_plans
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------
-- meal_plan_entries
-- ---------------------------------------------------------------------------------------

create table public.meal_plan_entries (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.meal_plans (id) on delete cascade,
  -- Denormalized from the plan so the standard RLS policy applies without a join. The sync
  -- trigger below overwrites whatever the caller sends, so it cannot drift from the plan.
  household_id uuid not null references public.households (id) on delete cascade,
  date date not null,
  slot public.meal_plan_entries_slot not null,
  recipe_id uuid not null references public.recipes (id) on delete cascade,
  -- Numeric like recipes.servings, so a half portion is storable. The app steps by whole numbers.
  servings numeric not null,
  status public.meal_plan_entries_status not null default 'planned',
  notes text,
  -- Order within a slot, 0 first.
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint meal_plan_entries_servings_range check (servings > 0 and servings <= 1000),
  constraint meal_plan_entries_notes_length check (notes is null or char_length(notes) <= 1000),
  constraint meal_plan_entries_position_range check (position between 0 and 1000)
);

comment on table public.meal_plan_entries is
  'A recipe in a slot on a day (WS04). household_id is kept in step with the plan by a trigger.';

-- docs/02 §Indexes: the week view reads a plan's entries by date.
create index meal_plan_entries_plan_date_idx on public.meal_plan_entries (plan_id, date);
-- Recent recipes in the picker, and the household-wide Realtime filter.
create index meal_plan_entries_household_created_idx
  on public.meal_plan_entries (household_id, created_at desc);
-- The foreign key to recipes.
create index meal_plan_entries_recipe_id_idx on public.meal_plan_entries (recipe_id);

create trigger meal_plan_entries_set_updated_at
  before update on public.meal_plan_entries
  for each row execute function public.set_updated_at();

-- Keeps an entry consistent with its plan and its recipe. Runs for every writer, including the
-- service role, and as the caller, so Row Level Security hides other households' plans and
-- recipes from it:
--   * the household comes from the plan, whatever the row says
--   * the date falls inside the plan's week
--   * the recipe belongs to the household (or is a catalog recipe) and is not deleted
-- Plain error codes in the message, like the identity functions: plan_not_found,
-- date_outside_plan_week, recipe_not_found.
create or replace function public.meal_plan_entries_sync()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  plan_row public.meal_plans%rowtype;
  -- OLD exists only on UPDATE, so it is read inside the branch that has it.
  check_recipe boolean := true;
begin
  if tg_op = 'UPDATE' then
    check_recipe := new.recipe_id is distinct from old.recipe_id;
  end if;

  select p.* into plan_row from public.meal_plans p where p.id = new.plan_id;
  if not found then
    raise exception 'plan_not_found';
  end if;

  new.household_id := plan_row.household_id;

  if new.date < plan_row.week_start or new.date > plan_row.week_start + 6 then
    raise exception 'date_outside_plan_week';
  end if;

  if check_recipe and not exists (
    select 1
    from public.recipes r
    where r.id = new.recipe_id
      and r.deleted_at is null
      and (r.household_id = new.household_id or r.visibility = 'catalog')
  ) then
    raise exception 'recipe_not_found';
  end if;

  return new;
end;
$$;

create trigger meal_plan_entries_sync_row
  before insert or update of plan_id, date, recipe_id on public.meal_plan_entries
  for each row execute function public.meal_plan_entries_sync();

-- ---------------------------------------------------------------------------------------
-- recipe_feedback
-- ---------------------------------------------------------------------------------------
-- An append-only log of what a person did with a recipe. The suggestion engine (WS06) reads it.

create table public.recipe_feedback (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- A catalog recipe (v2) has no household, so this references recipes, not household recipes.
  recipe_id uuid not null references public.recipes (id) on delete cascade,
  signal public.recipe_feedback_signal not null,
  rating smallint,
  created_at timestamptz not null default now(),

  constraint recipe_feedback_rating_range check (rating is null or rating between 1 and 5)
);

comment on table public.recipe_feedback is
  'What a person did with a recipe: like, dislike, cooked, skipped, saved (WS04, WS06).';
comment on column public.recipe_feedback.user_id is
  'The person the signal belongs to. Defaults to the caller; clients cannot set it.';

-- The picker reads the caller's latest thumb per recipe; WS06 reads a household's history.
create index recipe_feedback_household_user_idx
  on public.recipe_feedback (household_id, user_id, created_at desc);
create index recipe_feedback_recipe_id_idx on public.recipe_feedback (recipe_id);

-- ---------------------------------------------------------------------------------------
-- The planner's feedback signals
-- ---------------------------------------------------------------------------------------
-- saved   a recipe was added to a plan (an entry inserted, or an entry swapped to a new recipe)
-- cooked  an entry's status became cooked
-- skipped an entry's status became skipped
-- Written here, not by the client, so the entry change and its signal commit together and a
-- retried request (a phone that was offline) cannot write the signal twice: the trigger only
-- fires on a real change. Only a signed-in person's writes count. The service role (auth.uid()
-- is null) writes drafts for the suggestion engine, and a draft is not something a person saved.
-- Security definer because clients have no insert privilege for these three signals.

create or replace function public.meal_plan_entries_feedback()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  -- OLD exists only on UPDATE, so it is read inside the branch that has it.
  recipe_added boolean := true;
  status_marked boolean := new.status <> 'planned';
begin
  if uid is null then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    recipe_added := new.recipe_id is distinct from old.recipe_id;
    status_marked := new.status is distinct from old.status and new.status <> 'planned';
  end if;

  if recipe_added then
    insert into public.recipe_feedback (household_id, user_id, recipe_id, signal)
    values (new.household_id, uid, new.recipe_id, 'saved');
  end if;

  if status_marked then
    insert into public.recipe_feedback (household_id, user_id, recipe_id, signal)
    values (
      new.household_id,
      uid,
      new.recipe_id,
      case new.status
        when 'cooked' then 'cooked'::public.recipe_feedback_signal
        else 'skipped'::public.recipe_feedback_signal
      end
    );
  end if;

  return new;
end;
$$;

revoke all on function public.meal_plan_entries_feedback() from public, anon, authenticated;

create trigger meal_plan_entries_feedback_row
  after insert or update of recipe_id, status on public.meal_plan_entries
  for each row execute function public.meal_plan_entries_feedback();

-- ---------------------------------------------------------------------------------------
-- Table privileges and RLS
-- ---------------------------------------------------------------------------------------
-- Supabase grants every API role all privileges on new tables in `public`. Narrow that, then let
-- policies pick the rows (supabase/README.md §RLS conventions). Anonymous users get nothing.
-- The service role keeps its default privileges and bypasses RLS.

revoke all on public.meal_plans, public.meal_plan_entries, public.recipe_feedback
  from anon, authenticated;

-- meal_plans: members read and create. id is grantable so a phone can pick the id before it is
-- online (the optimistic update needs it). No update or delete: a plan's week never changes.
grant select on public.meal_plans to authenticated;
grant insert (id, household_id, week_start) on public.meal_plans to authenticated;

-- meal_plan_entries: plan_id, household_id, and id are fixed once the row exists. An entry never
-- moves to another plan, and its household follows the plan. Everything the person edits in the
-- app is updatable: servings, status, notes, position, and (for swap and move) recipe_id, date,
-- slot. The upsert in @mp/db inserts with ON CONFLICT DO NOTHING and then updates these columns,
-- so it never needs update privilege on the key columns.
grant select, delete on public.meal_plan_entries to authenticated;
grant insert (
  id, plan_id, household_id, date, slot, recipe_id, servings, status, notes, position
) on public.meal_plan_entries to authenticated;
grant update (date, slot, recipe_id, servings, status, notes, position)
  on public.meal_plan_entries to authenticated;

-- recipe_feedback: user_id and created_at come from defaults, so a client cannot write feedback
-- as someone else. Clients insert only like and dislike (policy below).
grant select, delete on public.recipe_feedback to authenticated;
grant insert (id, household_id, recipe_id, signal, rating) on public.recipe_feedback to authenticated;

alter table public.meal_plans enable row level security;
alter table public.meal_plan_entries enable row level security;
alter table public.recipe_feedback enable row level security;

create policy "meal_plans: members read" on public.meal_plans
  for select to authenticated
  using (household_id in (select public.current_household_ids()));

create policy "meal_plans: members insert" on public.meal_plans
  for insert to authenticated
  with check (household_id in (select public.current_household_ids()));

create policy "meal_plan_entries: members read" on public.meal_plan_entries
  for select to authenticated
  using (household_id in (select public.current_household_ids()));

create policy "meal_plan_entries: members insert" on public.meal_plan_entries
  for insert to authenticated
  with check (household_id in (select public.current_household_ids()));

create policy "meal_plan_entries: members update" on public.meal_plan_entries
  for update to authenticated
  using (household_id in (select public.current_household_ids()))
  with check (household_id in (select public.current_household_ids()));

create policy "meal_plan_entries: members delete" on public.meal_plan_entries
  for delete to authenticated
  using (household_id in (select public.current_household_ids()));

-- recipe_feedback: members read the household's log (WS06 learns from all of it). A person writes
-- and removes only their own thumbs, for a recipe their household owns.
create policy "recipe_feedback: members read" on public.recipe_feedback
  for select to authenticated
  using (household_id in (select public.current_household_ids()));

create policy "recipe_feedback: own thumbs insert" on public.recipe_feedback
  for insert to authenticated
  with check (
    household_id in (select public.current_household_ids())
    and user_id = (select auth.uid())
    and signal in ('like', 'dislike')
    and exists (
      select 1
      from public.recipes r
      where r.id = recipe_feedback.recipe_id
        and r.household_id = recipe_feedback.household_id
    )
  );

create policy "recipe_feedback: own thumbs delete" on public.recipe_feedback
  for delete to authenticated
  using (
    household_id in (select public.current_household_ids())
    and user_id = (select auth.uid())
    and signal in ('like', 'dislike')
  );

-- ---------------------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------------------
-- A change by one member reaches the others' open week view within seconds. Realtime applies RLS
-- to inserts and updates, so a member receives only their household's changes. It cannot apply
-- RLS to deletes, and it can filter a delete only when the old row is fully logged, hence
-- replica identity full on the entries table: the client's household_id filter then also works for
-- deletes, and the payload a subscriber receives carries only the primary key.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end;
$$;

alter publication supabase_realtime add table public.meal_plans, public.meal_plan_entries;
alter table public.meal_plan_entries replica identity full;
