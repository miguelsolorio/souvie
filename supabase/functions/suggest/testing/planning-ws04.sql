-- Test harness only (WS06). A copy of the docs/02-data-model.md §Planning shapes, which WS04 owns
-- and builds in the same wave. The suggest function reads and writes these tables; its tests need
-- them to exist. This file is never a migration: WS04's migration is the real one.
--
-- When WS04 merges, compare this file with its planning migration. The columns the suggest
-- function touches are listed in supabase/functions/suggest/README.md.

create type public.meal_plan_entries_slot as enum ('breakfast', 'lunch', 'dinner', 'snack');
create type public.meal_plan_entries_status as enum ('planned', 'cooked', 'skipped');
create type public.recipe_feedback_signal as enum ('like', 'dislike', 'cooked', 'skipped', 'saved');

create table public.meal_plans (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  week_start date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, week_start)
);

create table public.meal_plan_entries (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.meal_plans (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  date date not null,
  slot public.meal_plan_entries_slot not null,
  recipe_id uuid not null references public.recipes (id) on delete cascade,
  servings integer,
  status public.meal_plan_entries_status not null default 'planned',
  notes text,
  position integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.recipe_feedback (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  recipe_id uuid not null references public.recipes (id) on delete cascade,
  signal public.recipe_feedback_signal not null,
  rating smallint check (rating between 1 and 5),
  created_at timestamptz not null default now()
);
