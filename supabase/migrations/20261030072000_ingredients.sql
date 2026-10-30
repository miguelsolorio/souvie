-- WS03: ingredient ontology, alias index, parser cache, alias proposals.
-- docs/02-data-model.md §Migration ownership, order 6. Global reference data: no household_id,
-- readable by every signed-in user, written only by the service role (Edge Functions, seed).
--
-- Order notes for other workstreams:
--   * WS02's recipes migration adds recipe_ingredients.ingredient_id -> ingredients(id), so its
--     timestamp must sort after this file.
--   * ingredient_alias_proposals.household_id has no foreign key yet. households belongs to
--     WS01 and may sort after this file. The orchestrator adds the constraint in a small
--     follow-up migration (see the WS03 completion report, contract change request 2).

-- Enums mirror docs/02-data-model.md (named <table>_<column>).
create type public.ingredient_aliases_source as enum ('seed', 'llm', 'user');
create type public.ingredient_parse_cache_source as enum ('grammar', 'llm');
create type public.ingredient_alias_proposals_status as enum ('pending', 'accepted', 'rejected');

-- Keeps updated_at honest on the two tables here that are edited in place.
create or replace function public.ingredients_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- ingredients: the canonical ontology
-- ---------------------------------------------------------------------------
create table public.ingredients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plural text,
  category text not null,
  default_unit text not null,
  density_g_per_ml numeric,
  typical_unit_weight_g numeric,
  usda_fdc_id integer,
  is_staple_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ingredients_name_key unique (name),
  constraint ingredients_name_normalized check (name <> '' and name = lower(btrim(name))),
  constraint ingredients_category_check check (
    category in (
      'produce', 'meat', 'seafood', 'dairy', 'eggs', 'bakery', 'pantry', 'spices', 'canned',
      'frozen', 'beverages', 'snacks', 'baking', 'international', 'household', 'other'
    )
  ),
  constraint ingredients_default_unit_check check (default_unit <> ''),
  constraint ingredients_density_check check (density_g_per_ml is null or density_g_per_ml > 0),
  constraint ingredients_unit_weight_check check (
    typical_unit_weight_g is null or typical_unit_weight_g > 0
  )
);

comment on table public.ingredients is
  'Canonical ingredient ontology. Global reference data; service role writes.';
comment on column public.ingredients.density_g_per_ml is
  'One representative density (grams per milliliter) for volume to weight conversion.';
comment on column public.ingredients.typical_unit_weight_g is
  'Grams in one unmarked "each" (a medium onion, a large egg). Size words scale from it.';

create trigger ingredients_touch_updated_at
  before update on public.ingredients
  for each row execute function public.ingredients_touch_updated_at();

-- ---------------------------------------------------------------------------
-- ingredient_aliases: every spelling the parser can resolve to an ingredient
-- ---------------------------------------------------------------------------
create table public.ingredient_aliases (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references public.ingredients (id) on delete cascade,
  alias text not null,
  source public.ingredient_aliases_source not null default 'seed',
  created_at timestamptz not null default now(),
  constraint ingredient_aliases_alias_key unique (alias),
  constraint ingredient_aliases_alias_normalized check (alias <> '' and alias = lower(btrim(alias)))
);

comment on table public.ingredient_aliases is
  'Lowercase spellings that resolve to an ingredient. source = user is reserved for household aliases.';

create index ingredient_aliases_ingredient_id_idx on public.ingredient_aliases (ingredient_id);
create index ingredient_aliases_alias_trgm_idx
  on public.ingredient_aliases using gin (alias extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- ingredient_parse_cache: parser results keyed by normalized raw text (global)
-- ---------------------------------------------------------------------------
create table public.ingredient_parse_cache (
  normalized_text text primary key,
  result jsonb not null,
  source public.ingredient_parse_cache_source not null,
  model text,
  prompt_version text,
  created_at timestamptz not null default now()
);

comment on table public.ingredient_parse_cache is
  'Parsed ingredient lines keyed by normalized raw text, so a line is never sent to the model twice.';

-- ---------------------------------------------------------------------------
-- ingredient_alias_proposals: unknown ingredients awaiting review
-- ---------------------------------------------------------------------------
create table public.ingredient_alias_proposals (
  id uuid primary key default gen_random_uuid(),
  raw_text text not null,
  proposed_name text not null,
  proposed_category text,
  suggested_ingredient_id uuid references public.ingredients (id) on delete set null,
  household_id uuid,
  count integer not null default 1,
  status public.ingredient_alias_proposals_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ingredient_alias_proposals_name_normalized check (
    proposed_name <> '' and proposed_name = lower(btrim(proposed_name))
  ),
  constraint ingredient_alias_proposals_category_check check (
    proposed_category is null
    or proposed_category in (
      'produce', 'meat', 'seafood', 'dairy', 'eggs', 'bakery', 'pantry', 'spices', 'canned',
      'frozen', 'beverages', 'snacks', 'baking', 'international', 'household', 'other'
    )
  ),
  constraint ingredient_alias_proposals_count_check check (count >= 1)
);

comment on table public.ingredient_alias_proposals is
  'Names the ontology lacks. One pending row per proposed_name; count grows as the name recurs.';
comment on column public.ingredient_alias_proposals.household_id is
  'First household that hit the unknown name. Foreign key to households is added after WS01 merges.';

create unique index ingredient_alias_proposals_pending_name_key
  on public.ingredient_alias_proposals (proposed_name)
  where status = 'pending';

create trigger ingredient_alias_proposals_touch_updated_at
  before update on public.ingredient_alias_proposals
  for each row execute function public.ingredients_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Fuzzy lookup used by the parser's lookup stage
-- ---------------------------------------------------------------------------
-- The % operator uses pg_trgm.similarity_threshold (default 0.3) to hit the GIN index, then
-- similarity() applies the caller's threshold. Callers must pass min_similarity >= 0.3.
create or replace function public.match_ingredient_alias(
  query text,
  min_similarity real default 0.85,
  max_results integer default 5
)
returns table (ingredient_id uuid, alias text, similarity real)
language sql
stable
set search_path = ''
as $$
  select
    a.ingredient_id,
    a.alias,
    extensions.similarity(a.alias, query) as similarity
  from public.ingredient_aliases as a
  where a.alias operator(extensions.%) query
    and extensions.similarity(a.alias, query) >= min_similarity
  order by 3 desc, a.alias
  limit greatest(max_results, 1);
$$;

comment on function public.match_ingredient_alias(text, real, integer) is
  'Trigram match of a noun phrase against ingredient_aliases. Returns the best aliases first.';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- ingredients and ingredient_aliases: any signed-in user reads; nobody but the service role writes.
alter table public.ingredients enable row level security;
alter table public.ingredient_aliases enable row level security;

create policy "ingredients: authenticated read"
  on public.ingredients for select to authenticated using (true);
create policy "ingredient_aliases: authenticated read"
  on public.ingredient_aliases for select to authenticated using (true);

revoke all on table public.ingredients from public, anon, authenticated;
revoke all on table public.ingredient_aliases from public, anon, authenticated;
grant select on table public.ingredients to authenticated;
grant select on table public.ingredient_aliases to authenticated;

-- The cache and the proposals hold raw recipe text from households, so clients never touch
-- them. RLS is on with no policies, and table privileges are revoked as a second wall.
alter table public.ingredient_parse_cache enable row level security;
alter table public.ingredient_alias_proposals enable row level security;

revoke all on table public.ingredient_parse_cache from public, anon, authenticated;
revoke all on table public.ingredient_alias_proposals from public, anon, authenticated;

revoke all on function public.match_ingredient_alias(text, real, integer) from public, anon;
grant execute on function public.match_ingredient_alias(text, real, integer)
  to authenticated, service_role;
