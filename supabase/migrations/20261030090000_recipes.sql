-- WS02: recipe domain. docs/02-data-model.md §Recipes and §Ops (import_jobs), migration order 4.
--
-- Tables: recipes, recipe_ingredients, import_jobs. Also here: the private `recipe-images`
-- Storage bucket and its household-scoped policies.
-- The ai_runs table is in the next migration (this workstream is its first caller).
--
-- Sort order: this file must sort after 20261030072000_ingredients.sql (WS03), because
-- recipe_ingredients.ingredient_id references ingredients(id).
--
-- Who writes what:
--   recipes, recipe_ingredients   household members, through RLS. Column-level grants keep
--                                 attribution (source_type, source_url), ownership
--                                 (household_id, created_by) and the embedding out of reach.
--                                 There is no client DELETE on recipes: removal is a soft delete
--                                 (deleted_at), and lists filter it.
--   import_jobs                   the recipe-import Edge Function (service role). Members read.

-- ---------------------------------------------------------------------------------------
-- Enums (named <table>_<column>, docs/02 §Conventions)
-- ---------------------------------------------------------------------------------------

create type public.recipes_source_type as enum ('url', 'text', 'photo', 'video', 'manual', 'ai');
create type public.recipes_visibility as enum ('household', 'catalog');
create type public.import_jobs_kind as enum ('url', 'text', 'photo', 'caption');
create type public.import_jobs_status as enum ('queued', 'running', 'done', 'failed');

-- ---------------------------------------------------------------------------------------
-- recipes
-- ---------------------------------------------------------------------------------------

create table public.recipes (
  id uuid primary key default gen_random_uuid(),
  -- Null only for catalog recipes (v2). Every WS02 write sets visibility = 'household'.
  household_id uuid references public.households (id) on delete cascade,
  title text not null,
  description text,
  -- A path inside the `recipe-images` bucket (<household_id>/<file>) or an external http(s) URL.
  image_url text,
  source_type public.recipes_source_type not null,
  -- Attribution. Always set for url and video imports, and shown with the recipe.
  source_url text,
  servings numeric,
  prep_min integer,
  cook_min integer,
  -- Array of {step, text, group?}. core.RecipeInstruction is the only writer.
  instructions jsonb not null default '[]'::jsonb,
  -- Per serving, as imported. Display only.
  nutrition jsonb,
  tags text[] not null default '{}',
  cuisine text,
  -- WS06 chooses the embedding model and backfills this column.
  embedding extensions.vector(1024),
  visibility public.recipes_visibility not null default 'household',
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint recipes_household_visibility check (
    visibility = 'catalog' or household_id is not null
  ),
  constraint recipes_title_length check (char_length(btrim(title)) between 1 and 200),
  constraint recipes_description_length check (description is null or char_length(description) <= 4000),
  constraint recipes_cuisine_length check (cuisine is null or char_length(cuisine) <= 80),
  -- The app renders source_url as a link, so only web URLs may be stored (no javascript: or
  -- data: schemes). A client that skips the app still hits this.
  constraint recipes_source_url_web check (
    source_url is null or (source_url ~* '^https?://[^[:space:]]+$' and char_length(source_url) <= 2048)
  ),
  constraint recipes_source_url_required check (
    source_type not in ('url', 'video') or source_url is not null
  ),
  -- A bucket path has no URL scheme. Anything that looks like a scheme must be http(s).
  constraint recipes_image_url_safe check (
    image_url is null
    or (
      char_length(image_url) <= 2048
      and (image_url !~ '^[A-Za-z][A-Za-z0-9+.-]*:' or image_url ~* '^https?://[^[:space:]]+$')
    )
  ),
  constraint recipes_servings_positive check (servings is null or (servings > 0 and servings <= 1000)),
  constraint recipes_prep_min_range check (prep_min is null or prep_min between 0 and 20160),
  constraint recipes_cook_min_range check (cook_min is null or cook_min between 0 and 20160),
  constraint recipes_instructions_array check (
    jsonb_typeof(instructions) = 'array' and jsonb_array_length(instructions) <= 200
  ),
  constraint recipes_nutrition_object check (nutrition is null or jsonb_typeof(nutrition) = 'object'),
  constraint recipes_tags_size check (cardinality(tags) <= 50)
);

comment on table public.recipes is
  'A household''s recipes (WS02). Private to the household; catalog recipes arrive in v2.';
comment on column public.recipes.source_url is
  'Where the recipe came from. Shown as attribution; never hidden for imported recipes.';
comment on column public.recipes.embedding is
  'Nullable. WS06 fills it from title + tags + ingredient names.';
comment on column public.recipes.deleted_at is
  'Soft delete. Lists filter deleted_at is null; clients have no DELETE privilege.';

create index recipes_household_id_idx on public.recipes (household_id);
-- The recipe list: newest first, deleted rows excluded.
create index recipes_household_list_idx
  on public.recipes (household_id, created_at desc)
  where deleted_at is null;
create index recipes_embedding_hnsw_idx
  on public.recipes using hnsw (embedding extensions.vector_cosine_ops);

create trigger recipes_set_updated_at
  before update on public.recipes
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------
-- recipe_ingredients
-- ---------------------------------------------------------------------------------------
-- WS02 stores raw_text only. WS03's parse-ingredients function fills qty, qty_max, unit,
-- ingredient_id, prep_note, optional, and parse_confidence afterwards.

create table public.recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes (id) on delete cascade,
  position integer not null,
  -- "For the sauce"
  group_name text,
  -- As imported.
  raw_text text not null,
  -- Lower bound when the source line gives a range. Null for "to taste".
  qty numeric,
  -- Upper bound of a range ("1 to 2 cups"). List aggregation uses it when present.
  qty_max numeric,
  -- Canonical unit code from @mp/core units.
  unit text,
  -- Null until parsed, and for names the ontology lacks.
  ingredient_id uuid references public.ingredients (id) on delete set null,
  -- "diced"
  prep_note text,
  optional boolean not null default false,
  parse_confidence numeric,

  constraint recipe_ingredients_position_range check (position between 0 and 1000),
  constraint recipe_ingredients_raw_text_length check (char_length(btrim(raw_text)) between 1 and 500),
  constraint recipe_ingredients_group_name_length check (group_name is null or char_length(group_name) <= 200),
  constraint recipe_ingredients_qty_range check (qty is null or qty >= 0),
  constraint recipe_ingredients_qty_max_range check (qty_max is null or (qty is not null and qty_max >= qty)),
  constraint recipe_ingredients_confidence_range check (
    parse_confidence is null or parse_confidence between 0 and 1
  )
);

comment on table public.recipe_ingredients is
  'One row per ingredient line. raw_text is what the source said; the rest is parser output (WS03).';

create index recipe_ingredients_recipe_position_idx on public.recipe_ingredients (recipe_id, position);
create index recipe_ingredients_ingredient_id_idx on public.recipe_ingredients (ingredient_id);

-- ---------------------------------------------------------------------------------------
-- import_jobs
-- ---------------------------------------------------------------------------------------
-- One row per call to the recipe-import Edge Function. `input` is deliberately small: the URL,
-- the image path, or the length of pasted text, never the text itself.

create table public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  kind public.import_jobs_kind not null,
  input jsonb not null default '{}'::jsonb,
  status public.import_jobs_status not null default 'queued',
  result_recipe_id uuid references public.recipes (id) on delete set null,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,

  constraint import_jobs_input_object check (jsonb_typeof(input) = 'object')
);

comment on table public.import_jobs is
  'Recipe import attempts (WS02). Written by the recipe-import Edge Function; members read.';

create index import_jobs_household_created_idx on public.import_jobs (household_id, created_at desc);
create index import_jobs_result_recipe_id_idx on public.import_jobs (result_recipe_id);

-- ---------------------------------------------------------------------------------------
-- Table privileges and RLS
-- ---------------------------------------------------------------------------------------
-- Supabase grants every API role all privileges on new tables in `public`. Narrow that, then let
-- policies pick the rows (supabase/README.md §RLS conventions). Anonymous users get nothing.

revoke all on public.recipes, public.recipe_ingredients, public.import_jobs from anon, authenticated;

grant select on public.recipes to authenticated;
-- id, created_by, created_at, updated_at, deleted_at and embedding always come from defaults or
-- the service role. created_by defaults to auth.uid(), so it cannot be spoofed.
grant insert (
  household_id, title, description, image_url, source_type, source_url, servings, prep_min,
  cook_min, instructions, nutrition, tags, cuisine, visibility
) on public.recipes to authenticated;
-- Not updatable by clients: household_id (a recipe never moves), source_type and source_url
-- (attribution), visibility (catalog is v2), created_by, embedding.
grant update (
  title, description, image_url, servings, prep_min, cook_min, instructions, nutrition, tags,
  cuisine, deleted_at
) on public.recipes to authenticated;

grant select, delete on public.recipe_ingredients to authenticated;
grant insert (
  recipe_id, position, group_name, raw_text, qty, qty_max, unit, ingredient_id, prep_note,
  optional, parse_confidence
) on public.recipe_ingredients to authenticated;
-- recipe_id is not updatable: a line never moves to another recipe.
grant update (
  position, group_name, raw_text, qty, qty_max, unit, ingredient_id, prep_note, optional,
  parse_confidence
) on public.recipe_ingredients to authenticated;

grant select on public.import_jobs to authenticated;

alter table public.recipes enable row level security;
alter table public.recipe_ingredients enable row level security;
alter table public.import_jobs enable row level security;

-- recipes: members of the household read and write. Catalog rows (household_id null) match no
-- policy, so no client can read or write them in v1.
create policy "recipes: members read" on public.recipes
  for select to authenticated
  using (household_id in (select public.current_household_ids()));

create policy "recipes: members insert" on public.recipes
  for insert to authenticated
  with check (
    household_id in (select public.current_household_ids())
    and visibility = 'household'
  );

create policy "recipes: members update" on public.recipes
  for update to authenticated
  using (household_id in (select public.current_household_ids()))
  with check (household_id in (select public.current_household_ids()));

-- recipe_ingredients has no household_id; access follows the parent recipe.
create policy "recipe_ingredients: members read" on public.recipe_ingredients
  for select to authenticated
  using (
    exists (
      select 1 from public.recipes r
      where r.id = recipe_ingredients.recipe_id
        and r.household_id in (select public.current_household_ids())
    )
  );

create policy "recipe_ingredients: members insert" on public.recipe_ingredients
  for insert to authenticated
  with check (
    exists (
      select 1 from public.recipes r
      where r.id = recipe_ingredients.recipe_id
        and r.household_id in (select public.current_household_ids())
    )
  );

create policy "recipe_ingredients: members update" on public.recipe_ingredients
  for update to authenticated
  using (
    exists (
      select 1 from public.recipes r
      where r.id = recipe_ingredients.recipe_id
        and r.household_id in (select public.current_household_ids())
    )
  )
  with check (
    exists (
      select 1 from public.recipes r
      where r.id = recipe_ingredients.recipe_id
        and r.household_id in (select public.current_household_ids())
    )
  );

create policy "recipe_ingredients: members delete" on public.recipe_ingredients
  for delete to authenticated
  using (
    exists (
      select 1 from public.recipes r
      where r.id = recipe_ingredients.recipe_id
        and r.household_id in (select public.current_household_ids())
    )
  );

-- import_jobs: members read their household's jobs. No client write policy exists.
create policy "import_jobs: members read" on public.import_jobs
  for select to authenticated
  using (household_id in (select public.current_household_ids()));

-- ---------------------------------------------------------------------------------------
-- Storage: recipe-images
-- ---------------------------------------------------------------------------------------
-- Private bucket. Objects live at <household_id>/<file>: photos of recipe cards and cookbook
-- pages that the person imports. Members of that household read and write inside the folder;
-- nobody else can. The app uses signed URLs. Phones send JPEG after the client resizes.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'recipe-images', 'recipe-images', false, 8388608,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "recipe-images: members read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'recipe-images'
    and (storage.foldername(name))[1] in (
      select h::text from public.current_household_ids() as h
    )
  );

create policy "recipe-images: members write" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'recipe-images'
    and (storage.foldername(name))[1] in (
      select h::text from public.current_household_ids() as h
    )
  );

create policy "recipe-images: members update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'recipe-images'
    and (storage.foldername(name))[1] in (
      select h::text from public.current_household_ids() as h
    )
  )
  with check (
    bucket_id = 'recipe-images'
    and (storage.foldername(name))[1] in (
      select h::text from public.current_household_ids() as h
    )
  );

create policy "recipe-images: members delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'recipe-images'
    and (storage.foldername(name))[1] in (
      select h::text from public.current_household_ids() as h
    )
  );
