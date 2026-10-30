-- WS02: pgTAP tests for recipes, recipe_ingredients, import_jobs, ai_runs, and the recipe-images
-- bucket. Run with `supabase test db`. Everything happens inside one transaction that is rolled back.
--
-- What it proves:
--   * a member of household A reads nothing of household B in any of the four tables or the bucket
--   * a member cannot write into B, move a recipe, forge attribution or ownership, or hard-delete
--   * the web-URL, attribution and range constraints hold even for a client that skips the app
--   * import_jobs and ai_runs have no client write path at all
--
-- Cast of characters (fixed ids, so the SQL below stays readable):
--   alice  owns household A       carol  is a plain member of A
--   bob    owns household B       dave   belongs to no household

begin;

select plan(82);

-- ---------------------------------------------------------------------------------------
-- Fixtures (as the postgres role, which bypasses RLS)
-- ---------------------------------------------------------------------------------------

-- Test helper: how many rows a statement touched. RLS hides rows from UPDATE and DELETE rather
-- than raising, so "denied" shows up as zero rows affected.
create function public.__t_affected(sql text) returns bigint
language plpgsql as $$
declare n bigint;
begin
  execute sql;
  get diagnostics n = row_count;
  return n;
end;
$$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a1111111-1111-4111-8111-111111111111', 'alice@example.test', '{}'),
  ('b2222222-2222-4222-8222-222222222222', 'bob@example.test', '{}'),
  ('c3333333-3333-4333-8333-333333333333', 'carol@example.test', '{}'),
  ('d4444444-4444-4444-8444-444444444444', 'dave@example.test', '{}');

insert into public.households (id, name, created_by) values
  ('0a000000-0000-4000-8000-00000000000a', 'Alice House', 'a1111111-1111-4111-8111-111111111111'),
  ('0b000000-0000-4000-8000-00000000000b', 'Bob House', 'b2222222-2222-4222-8222-222222222222');

insert into public.household_members (household_id, user_id, role) values
  ('0a000000-0000-4000-8000-00000000000a', 'a1111111-1111-4111-8111-111111111111', 'owner'),
  ('0a000000-0000-4000-8000-00000000000a', 'c3333333-3333-4333-8333-333333333333', 'member'),
  ('0b000000-0000-4000-8000-00000000000b', 'b2222222-2222-4222-8222-222222222222', 'owner');

insert into public.ingredients (id, name, category, default_unit) values
  ('11111111-0000-4000-8000-000000000001', 'test onion', 'produce', 'each');

-- A1 is a live URL import in A, A2 is a deleted manual recipe in A, B1 is a recipe in B.
insert into public.recipes (id, household_id, title, source_type, source_url, created_by, deleted_at) values
  ('aa000000-0000-4000-8000-000000000001', '0a000000-0000-4000-8000-00000000000a', 'A1 lemon chicken', 'url', 'https://example.test/lemon-chicken', 'a1111111-1111-4111-8111-111111111111', null),
  ('aa000000-0000-4000-8000-000000000002', '0a000000-0000-4000-8000-00000000000a', 'A2 old soup', 'manual', null, 'a1111111-1111-4111-8111-111111111111', now()),
  ('bb000000-0000-4000-8000-000000000001', '0b000000-0000-4000-8000-00000000000b', 'B1 secret stew', 'manual', null, 'b2222222-2222-4222-8222-222222222222', null);

insert into public.recipe_ingredients (id, recipe_id, position, raw_text) values
  ('a0000000-0000-4000-8000-0000000000a1', 'aa000000-0000-4000-8000-000000000001', 0, '8 bone-in chicken thighs'),
  ('a0000000-0000-4000-8000-0000000000a2', 'aa000000-0000-4000-8000-000000000001', 1, '4 cloves garlic, smashed'),
  ('b0000000-0000-4000-8000-0000000000b1', 'bb000000-0000-4000-8000-000000000001', 0, '2 lb secret beef'),
  ('b0000000-0000-4000-8000-0000000000b2', 'bb000000-0000-4000-8000-000000000001', 1, '1 secret onion');

insert into public.import_jobs (id, household_id, kind, input, status, result_recipe_id) values
  ('c0000000-0000-4000-8000-0000000000c1', '0a000000-0000-4000-8000-00000000000a', 'url', '{"url": "https://example.test/lemon-chicken"}', 'done', 'aa000000-0000-4000-8000-000000000001'),
  ('c0000000-0000-4000-8000-0000000000c2', '0b000000-0000-4000-8000-00000000000b', 'text', '{"length": 120}', 'failed', null);

insert into public.ai_runs (id, household_id, kind, model, prompt_version, ok) values
  ('d0000000-0000-4000-8000-0000000000d1', '0a000000-0000-4000-8000-00000000000a', 'extract_recipe', 'claude-sonnet-5-5', 'recipe-extract.v1', true),
  ('d0000000-0000-4000-8000-0000000000d2', '0b000000-0000-4000-8000-00000000000b', 'extract_recipe', 'claude-sonnet-5-5', 'recipe-extract.v1', true),
  ('d0000000-0000-4000-8000-0000000000d3', null, 'embed', 'system-job', 'embed.v1', true);

insert into storage.objects (bucket_id, name) values
  ('recipe-images', '0a000000-0000-4000-8000-00000000000a/card-a.jpg'),
  ('recipe-images', '0b000000-0000-4000-8000-00000000000b/card-b.jpg');

-- ---------------------------------------------------------------------------------------
-- Shape: RLS on, the reviewed policy set, private bucket
-- ---------------------------------------------------------------------------------------

select ok((select relrowsecurity from pg_class where oid = 'public.recipes'::regclass), 'recipes has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.recipe_ingredients'::regclass), 'recipe_ingredients has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.import_jobs'::regclass), 'import_jobs has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.ai_runs'::regclass), 'ai_runs has RLS enabled');

select policies_are('public', 'recipes', array['recipes: members read', 'recipes: members insert', 'recipes: members update', 'recipes: catalog read'], 'recipes has exactly the reviewed policies (no delete policy; catalog read added 2026-10-30)');
select policies_are('public', 'recipe_ingredients', array['recipe_ingredients: members read', 'recipe_ingredients: members insert', 'recipe_ingredients: members update', 'recipe_ingredients: members delete', 'recipe_ingredients: catalog read'], 'recipe_ingredients has exactly the reviewed policies (catalog read added 2026-10-30)');
select policies_are('public', 'import_jobs', array['import_jobs: members read'], 'import_jobs has one read policy and no write policy');
select policies_are('public', 'ai_runs', array['ai_runs: members read'], 'ai_runs has one read policy and no write policy');

select is((select public from storage.buckets where id = 'recipe-images'), false, 'the recipe-images bucket is private');
select is((select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'recipe-images:%'), 4, 'recipe-images has read, write, update, and delete policies');

-- ---------------------------------------------------------------------------------------
-- Signed out (anon) gets nothing
-- ---------------------------------------------------------------------------------------

set local role anon;

select throws_ok($$select count(*) from public.recipes$$, '42501', 'permission denied for table recipes', 'anon cannot read recipes');
select throws_ok($$select count(*) from public.recipe_ingredients$$, '42501', 'permission denied for table recipe_ingredients', 'anon cannot read recipe_ingredients');
select throws_ok($$select count(*) from public.import_jobs$$, '42501', 'permission denied for table import_jobs', 'anon cannot read import_jobs');
select throws_ok($$select count(*) from public.ai_runs$$, '42501', 'permission denied for table ai_runs', 'anon cannot read ai_runs');

reset role;

-- ---------------------------------------------------------------------------------------
-- Alice (owner of A): sees only household A
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;

select is((select count(*)::int from public.recipes), 2, 'alice sees the two recipes of household A, including the soft-deleted one');
select is_empty($$select 1 from public.recipes where household_id = '0b000000-0000-4000-8000-00000000000b'$$, 'alice reads no recipe of household B');
select is_empty($$select 1 from public.recipes where id = 'bb000000-0000-4000-8000-000000000001'$$, 'alice cannot fetch a recipe of B by id');
select is((select count(*)::int from public.recipe_ingredients), 2, 'alice sees only the ingredient lines of A''s recipes');
select is_empty($$select 1 from public.recipe_ingredients where recipe_id = 'bb000000-0000-4000-8000-000000000001'$$, 'alice reads no ingredient line of B''s recipe');
select is((select count(*)::int from public.import_jobs), 1, 'alice sees one import job');
select is_empty($$select 1 from public.import_jobs where household_id = '0b000000-0000-4000-8000-00000000000b'$$, 'alice reads no import job of household B');
select is((select count(*)::int from public.ai_runs), 1, 'alice sees only household A''s ai_runs row, not B''s or the system row');
select is((select count(*)::int from storage.objects where bucket_id = 'recipe-images'), 1, 'alice sees one recipe image, the one in her household folder');
select is_empty($$select 1 from storage.objects where name like '0b000000-0000-4000-8000-00000000000b/%'$$, 'alice cannot list household B''s images');

-- Writing recipes in A
select lives_ok($$insert into public.recipes (household_id, title, source_type) values ('0a000000-0000-4000-8000-00000000000a', 'Alice soup', 'manual')$$, 'alice can add a recipe to her household');
select is((select created_by from public.recipes where title = 'Alice soup'), 'a1111111-1111-4111-8111-111111111111'::uuid, 'created_by is filled from the signed-in user');
select lives_ok($$insert into public.recipes (household_id, title, source_type, source_url, image_url, servings, prep_min, cook_min, instructions, tags, cuisine) values ('0a000000-0000-4000-8000-00000000000a', 'Full import', 'url', 'https://example.test/full', 'https://example.test/full.jpg', 4, 10, 35, '[{"step": 1, "text": "Roast."}]', array['weeknight'], 'american')$$, 'a full URL import row is accepted');
select lives_ok($$insert into public.recipes (household_id, title, source_type, image_url) values ('0a000000-0000-4000-8000-00000000000a', 'Photo card', 'photo', '0a000000-0000-4000-8000-00000000000a/card-a.jpg')$$, 'a bucket path is accepted as image_url');

-- Writing into B, forging, and catalog rows are all refused
select throws_ok($$insert into public.recipes (household_id, title, source_type) values ('0b000000-0000-4000-8000-00000000000b', 'Planted', 'manual')$$, '42501', 'new row violates row-level security policy for table "recipes"', 'alice cannot add a recipe to household B');
select throws_ok($$insert into public.recipes (household_id, title, source_type, visibility) values (null, 'Catalog grab', 'manual', 'catalog')$$, '42501', 'new row violates row-level security policy for table "recipes"', 'alice cannot add a catalog recipe');
select throws_ok($$insert into public.recipes (household_id, title, source_type, visibility) values ('0a000000-0000-4000-8000-00000000000a', 'Pretend catalog', 'manual', 'catalog')$$, '42501', 'new row violates row-level security policy for table "recipes"', 'alice cannot mark her own recipe as catalog');
select throws_ok($$insert into public.recipes (household_id, title, source_type, created_by) values ('0a000000-0000-4000-8000-00000000000a', 'Forged', 'manual', 'b2222222-2222-4222-8222-222222222222')$$, '42501', 'permission denied for table recipes', 'alice cannot set created_by');
select throws_ok($$insert into public.recipes (household_id, title, source_type, embedding) values ('0a000000-0000-4000-8000-00000000000a', 'Embedded', 'manual', array_fill(0.1::real, array[1024])::extensions.vector)$$, '42501', 'permission denied for table recipes', 'alice cannot write the embedding');

-- Constraints hold for clients that skip the app
select throws_ok($$insert into public.recipes (household_id, title, source_type, source_url) values ('0a000000-0000-4000-8000-00000000000a', 'Bad link', 'url', 'javascript:alert(1)')$$, '23514', 'new row for relation "recipes" violates check constraint "recipes_source_url_web"', 'a javascript: source_url is rejected');
select throws_ok($$insert into public.recipes (household_id, title, source_type) values ('0a000000-0000-4000-8000-00000000000a', 'No attribution', 'url')$$, '23514', 'new row for relation "recipes" violates check constraint "recipes_source_url_required"', 'a url recipe must carry its source_url');
select throws_ok($$insert into public.recipes (household_id, title, source_type, image_url) values ('0a000000-0000-4000-8000-00000000000a', 'Data image', 'manual', 'data:image/png;base64,AAAA')$$, '23514', 'new row for relation "recipes" violates check constraint "recipes_image_url_safe"', 'a data: image_url is rejected');
select throws_ok($$insert into public.recipes (household_id, title, source_type) values ('0a000000-0000-4000-8000-00000000000a', '   ', 'manual')$$, '23514', 'new row for relation "recipes" violates check constraint "recipes_title_length"', 'a blank title is rejected');
select throws_ok($$insert into public.recipes (household_id, title, source_type, instructions) values ('0a000000-0000-4000-8000-00000000000a', 'Object steps', 'manual', '{"a": 1}')$$, '23514', 'new row for relation "recipes" violates check constraint "recipes_instructions_array"', 'instructions must be a JSON array');

-- Updating and soft-deleting
select is(public.__t_affected($$update public.recipes set title = 'A1 lemon chicken, revised' where id = 'aa000000-0000-4000-8000-000000000001'$$), 1::bigint, 'alice can edit her recipe');
select is(public.__t_affected($$update public.recipes set title = 'Hijacked' where id = 'bb000000-0000-4000-8000-000000000001'$$), 0::bigint, 'alice''s update of B''s recipe touches no rows');
select throws_ok($$update public.recipes set source_url = 'https://evil.test/' where id = 'aa000000-0000-4000-8000-000000000001'$$, '42501', 'permission denied for table recipes', 'attribution (source_url) is not editable');
select throws_ok($$update public.recipes set household_id = '0b000000-0000-4000-8000-00000000000b' where id = 'aa000000-0000-4000-8000-000000000001'$$, '42501', 'permission denied for table recipes', 'a recipe cannot be moved to another household');
select is(public.__t_affected($$update public.recipes set deleted_at = now() where id = 'aa000000-0000-4000-8000-000000000001'$$), 1::bigint, 'alice can soft-delete her recipe');
select is((select count(*)::int from public.recipes where id = 'aa000000-0000-4000-8000-000000000001' and deleted_at is not null), 1, 'a soft-deleted recipe keeps its row');
select throws_ok($$delete from public.recipes where id = 'aa000000-0000-4000-8000-000000000001'$$, '42501', 'permission denied for table recipes', 'clients have no hard-delete on recipes');

-- Ingredient lines follow the parent recipe
select lives_ok($$insert into public.recipe_ingredients (recipe_id, position, group_name, raw_text, ingredient_id) values ('aa000000-0000-4000-8000-000000000001', 2, 'For the pan', '1 lemon, sliced', '11111111-0000-4000-8000-000000000001')$$, 'alice can add an ingredient line to her recipe');
select throws_ok($$insert into public.recipe_ingredients (recipe_id, position, raw_text) values ('bb000000-0000-4000-8000-000000000001', 5, 'planted line')$$, '42501', 'new row violates row-level security policy for table "recipe_ingredients"', 'alice cannot add a line to B''s recipe');
select is(public.__t_affected($$update public.recipe_ingredients set raw_text = 'hijacked' where recipe_id = 'bb000000-0000-4000-8000-000000000001'$$), 0::bigint, 'alice''s update of B''s lines touches no rows');
select is(public.__t_affected($$delete from public.recipe_ingredients where recipe_id = 'bb000000-0000-4000-8000-000000000001'$$), 0::bigint, 'alice''s delete of B''s lines touches no rows');
select throws_ok($$update public.recipe_ingredients set recipe_id = 'bb000000-0000-4000-8000-000000000001' where id = 'a0000000-0000-4000-8000-0000000000a1'$$, '42501', 'permission denied for table recipe_ingredients', 'a line cannot be moved to another recipe');
select throws_ok($$insert into public.recipe_ingredients (recipe_id, position, raw_text, qty, qty_max) values ('aa000000-0000-4000-8000-000000000001', 3, '2 to 1 cups flour', 2, 1)$$, '23514', 'new row for relation "recipe_ingredients" violates check constraint "recipe_ingredients_qty_max_range"', 'qty_max cannot be below qty');
select throws_ok($$insert into public.recipe_ingredients (recipe_id, position, raw_text) values ('aa000000-0000-4000-8000-000000000001', 3, '')$$, '23514', 'new row for relation "recipe_ingredients" violates check constraint "recipe_ingredients_raw_text_length"', 'a blank ingredient line is rejected');
select is(public.__t_affected($$update public.recipe_ingredients set qty = 8, unit = 'each', parse_confidence = 0.97 where id = 'a0000000-0000-4000-8000-0000000000a1'$$), 1::bigint, 'the parser can fill qty, unit, and confidence on A''s lines');
select is(public.__t_affected($$delete from public.recipe_ingredients where recipe_id = 'aa000000-0000-4000-8000-000000000001' and position = 2$$), 1::bigint, 'alice can delete a line from her recipe');

-- import_jobs and ai_runs: read only
select throws_ok($$insert into public.import_jobs (household_id, kind) values ('0a000000-0000-4000-8000-00000000000a', 'url')$$, '42501', 'permission denied for table import_jobs', 'clients cannot insert import_jobs');
select throws_ok($$update public.import_jobs set status = 'done'$$, '42501', 'permission denied for table import_jobs', 'clients cannot update import_jobs');
select throws_ok($$delete from public.import_jobs$$, '42501', 'permission denied for table import_jobs', 'clients cannot delete import_jobs');
select throws_ok($$insert into public.ai_runs (household_id, kind, model, ok) values ('0a000000-0000-4000-8000-00000000000a', 'extract_recipe', 'claude-sonnet-5-5', true)$$, '42501', 'permission denied for table ai_runs', 'clients cannot insert ai_runs');
select throws_ok($$update public.ai_runs set cost_usd = 0$$, '42501', 'permission denied for table ai_runs', 'clients cannot rewrite ai_runs');

-- recipe-images
select lives_ok($$insert into storage.objects (bucket_id, name) values ('recipe-images', '0a000000-0000-4000-8000-00000000000a/new-card.jpg')$$, 'alice can upload into her household folder');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('recipe-images', '0b000000-0000-4000-8000-00000000000b/planted.jpg')$$, '42501', 'new row violates row-level security policy for table "objects"', 'alice cannot upload into household B''s folder');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('recipe-images', 'loose-file.jpg')$$, '42501', 'new row violates row-level security policy for table "objects"', 'alice cannot upload outside a household folder');
-- Storage refuses direct DELETEs (storage.protect_delete) unless the Storage API's own switch is on.
-- The switch only lets the statement reach RLS; the policy still decides. Same pattern as 001.
set local storage.allow_delete_query = 'true';
select is(public.__t_affected($$delete from storage.objects where name = '0b000000-0000-4000-8000-00000000000b/card-b.jpg'$$), 0::bigint, 'alice cannot delete household B''s image');
set local storage.allow_delete_query = 'false';

reset role;

-- ---------------------------------------------------------------------------------------
-- Carol (plain member of A): members write, not only owners
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}';
set local role authenticated;

select lives_ok($$insert into public.recipes (household_id, title, source_type) values ('0a000000-0000-4000-8000-00000000000a', 'Carol salad', 'manual')$$, 'a plain member can add a recipe');
select is((select count(*)::int from public.recipes where title = 'Alice soup'), 1, 'a plain member reads recipes the owner added');

reset role;

-- ---------------------------------------------------------------------------------------
-- Bob (owner of B): sees only household B
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}';
set local role authenticated;

select is((select count(*)::int from public.recipes), 1, 'bob sees one recipe, his own');
select is_empty($$select 1 from public.recipes where household_id = '0a000000-0000-4000-8000-00000000000a'$$, 'bob reads no recipe of household A');
select is((select count(*)::int from public.recipe_ingredients), 2, 'bob sees only his own ingredient lines');
select is((select count(*)::int from public.import_jobs), 1, 'bob sees only his own import job');
select is((select count(*)::int from public.ai_runs), 1, 'bob sees only his own ai_runs row');
select is(public.__t_affected($$update public.recipes set title = 'Hijacked' where id = 'aa000000-0000-4000-8000-000000000001'$$), 0::bigint, 'bob cannot edit a recipe of A');
select throws_ok($$insert into public.recipe_ingredients (recipe_id, position, raw_text) values ('aa000000-0000-4000-8000-000000000001', 9, 'planted by bob')$$, '42501', 'new row violates row-level security policy for table "recipe_ingredients"', 'bob cannot add a line to A''s recipe');

reset role;

-- ---------------------------------------------------------------------------------------
-- Dave (no household): sees and writes nothing
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "d4444444-4444-4444-8444-444444444444", "role": "authenticated"}';
set local role authenticated;

select is((select count(*)::int from public.recipes), 0, 'a user with no household sees no recipes');
select is((select count(*)::int from public.recipe_ingredients), 0, 'a user with no household sees no ingredient lines');
select is((select count(*)::int from public.import_jobs), 0, 'a user with no household sees no import jobs');
select is((select count(*)::int from public.ai_runs), 0, 'a user with no household sees no ai_runs');
select is((select count(*)::int from storage.objects where bucket_id = 'recipe-images'), 0, 'a user with no household sees no recipe images');
select throws_ok($$insert into public.recipes (household_id, title, source_type) values ('0a000000-0000-4000-8000-00000000000a', 'Intruder', 'manual')$$, '42501', 'new row violates row-level security policy for table "recipes"', 'a user with no household cannot add recipes anywhere');

reset role;

-- ---------------------------------------------------------------------------------------
-- Cascades: deleting a household removes what it owned
-- ---------------------------------------------------------------------------------------

select lives_ok($$delete from public.households where id = '0b000000-0000-4000-8000-00000000000b'$$, 'deleting a household cascades cleanly');
select is((select count(*)::int from public.recipes where household_id = '0b000000-0000-4000-8000-00000000000b'), 0, 'its recipes go with it');
select is((select count(*)::int from public.recipe_ingredients where recipe_id = 'bb000000-0000-4000-8000-000000000001'), 0, 'its recipe ingredient lines go with it');
select is((select count(*)::int from public.import_jobs where household_id = '0b000000-0000-4000-8000-00000000000b'), 0, 'its import jobs go with it');

select * from finish();

rollback;
