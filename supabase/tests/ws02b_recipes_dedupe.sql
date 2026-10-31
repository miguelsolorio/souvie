-- WS02 follow-up (2026-10-31): one live recipe per link in a household. Run with `supabase test db`.
-- Everything happens inside one transaction that is rolled back. Counts and lookups are scoped to
-- the fixtures below: `db reset` loads the ontology and the starter catalog, so nothing here counts
-- a whole table.
--
-- What it proves:
--   * normalize_source_url applies the rules (lowercase host, no fragment, no tracking parameters,
--     no trailing slash) and returns null for anything that is not an http(s) link
--   * a trigger fills recipes.source_url_normalized from source_url, and recomputes it when the
--     link changes; no client can write the column
--   * a second live recipe with the same link in one household is refused, however the link is
--     spelled; the same link in another household is fine
--   * a soft-deleted recipe frees its link, and cannot be brought back over a live copy
--   * catalog rows and recipes without a link are not covered
--   * the policies on recipes are exactly the reviewed four (002_rls_recipes.sql pins them too)
--
-- Cast of characters (fixed ids, so the SQL below stays readable):
--   alice  owns household A       bob  owns household B

begin;

select plan(31);

-- ---------------------------------------------------------------------------------------
-- Fixtures (as the postgres role, which bypasses RLS)
-- ---------------------------------------------------------------------------------------

insert into auth.users (id, email, raw_user_meta_data) values
  ('a1111111-1111-4111-8111-111111111111', 'alice@example.test', '{}'),
  ('b2222222-2222-4222-8222-222222222222', 'bob@example.test', '{}');

insert into public.households (id, name, created_by) values
  ('0a000000-0000-4000-8000-00000000000a', 'Alice House', 'a1111111-1111-4111-8111-111111111111'),
  ('0b000000-0000-4000-8000-00000000000b', 'Bob House', 'b2222222-2222-4222-8222-222222222222');

insert into public.household_members (household_id, user_id, role) values
  ('0a000000-0000-4000-8000-00000000000a', 'a1111111-1111-4111-8111-111111111111', 'owner'),
  ('0b000000-0000-4000-8000-00000000000b', 'b2222222-2222-4222-8222-222222222222', 'owner');

-- ---------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------

select is(
  (select count(*)::int from pg_attribute where attrelid = 'public.recipes'::regclass and attname = 'source_url_normalized' and not attisdropped),
  1,
  'recipes has a source_url_normalized column'
);

select policies_are('public', 'recipes', array['recipes: members read', 'recipes: members insert', 'recipes: members update', 'recipes: catalog read'], 'recipes still has exactly the reviewed policies');

select is(
  (select indexdef like '%UNIQUE%' and indexdef like '%(household_id, source_url_normalized)%' and indexdef like '%deleted_at IS NULL%' from pg_indexes where schemaname = 'public' and indexname = 'recipes_household_source_url_normalized_uq'),
  true,
  'the unique index covers (household_id, source_url_normalized) for live rows only'
);

-- ---------------------------------------------------------------------------------------
-- normalize_source_url
-- ---------------------------------------------------------------------------------------

select is(public.normalize_source_url('https://Example.test/R/?utm_source=x&id=7&fbclid=y#top'), 'https://example.test/R?id=7', 'host lowercased, fragment and tracking parameters dropped, trailing slash stripped');
select is(public.normalize_source_url('HTTP://EXAMPLE.TEST'), 'http://example.test', 'the scheme and a bare host are lowercased');
select is(public.normalize_source_url('https://example.test/a?x=utm_source'), 'https://example.test/a?x=utm_source', 'only the name of a parameter counts as tracking');
select is(public.normalize_source_url('https://example.test/Path'), 'https://example.test/Path', 'the path keeps its case');
select is(public.normalize_source_url('ftp://example.test/a'), null, 'a link that is not http(s) has no key');
select is(public.normalize_source_url(null), null, 'null in, null out');

-- ---------------------------------------------------------------------------------------
-- The trigger
-- ---------------------------------------------------------------------------------------

insert into public.recipes (id, household_id, title, source_type, source_url) values
  ('ee000000-0000-4000-8000-0000000000e1', '0a000000-0000-4000-8000-00000000000a', 'Lemon chicken', 'url', 'https://Example.test/Lemon-Chicken/?utm_source=x&fbclid=y#top'),
  ('ee000000-0000-4000-8000-0000000000e2', '0a000000-0000-4000-8000-00000000000a', 'Typed soup', 'manual', null);

select is((select source_url_normalized from public.recipes where id = 'ee000000-0000-4000-8000-0000000000e1'), 'https://example.test/Lemon-Chicken', 'an insert fills the key from source_url');
select is((select source_url_normalized from public.recipes where id = 'ee000000-0000-4000-8000-0000000000e2'), null, 'a recipe without a link has no key');
select is((select source_url from public.recipes where id = 'ee000000-0000-4000-8000-0000000000e1'), 'https://Example.test/Lemon-Chicken/?utm_source=x&fbclid=y#top', 'source_url itself is stored as given');

-- ---------------------------------------------------------------------------------------
-- One live recipe per link in a household
-- ---------------------------------------------------------------------------------------

select throws_ok($$insert into public.recipes (household_id, title, source_type, source_url) values ('0a000000-0000-4000-8000-00000000000a', 'Lemon chicken again', 'url', 'https://example.test/Lemon-Chicken')$$, '23505', 'duplicate key value violates unique constraint "recipes_household_source_url_normalized_uq"', 'the same link twice in one household is refused');
select throws_ok($$insert into public.recipes (household_id, title, source_type, source_url) values ('0a000000-0000-4000-8000-00000000000a', 'Shared link', 'url', 'HTTPS://EXAMPLE.TEST/Lemon-Chicken/?gclid=1#reviews')$$, '23505', 'duplicate key value violates unique constraint "recipes_household_source_url_normalized_uq"', 'a different spelling of the same link is refused too');
select lives_ok($$insert into public.recipes (household_id, title, source_type, source_url) values ('0a000000-0000-4000-8000-00000000000a', 'Other case', 'url', 'https://example.test/lemon-chicken')$$, 'a path that differs in case is another page');
select lives_ok($$insert into public.recipes (household_id, title, source_type, source_url) values ('0a000000-0000-4000-8000-00000000000a', 'Other query', 'url', 'https://example.test/Lemon-Chicken?id=2')$$, 'a query that is not tracking is another page');
select lives_ok($$insert into public.recipes (household_id, title, source_type, source_url) values ('0b000000-0000-4000-8000-00000000000b', 'Lemon chicken (Bob)', 'url', 'https://example.test/Lemon-Chicken')$$, 'the same link in another household is fine');
select lives_ok($$insert into public.recipes (household_id, title, source_type) values ('0a000000-0000-4000-8000-00000000000a', 'Typed soup', 'manual'), ('0a000000-0000-4000-8000-00000000000a', 'Typed soup', 'manual')$$, 'recipes without a link are not covered, even with the same title');
select lives_ok($$insert into public.recipes (household_id, title, source_type, source_url, visibility) values (null, 'Catalog one', 'ai', 'https://catalog.example.test/a', 'catalog'), (null, 'Catalog two', 'ai', 'https://catalog.example.test/a', 'catalog')$$, 'catalog rows (no household) are not covered');

-- ---------------------------------------------------------------------------------------
-- Soft delete frees the link
-- ---------------------------------------------------------------------------------------

update public.recipes set deleted_at = now() where id = 'ee000000-0000-4000-8000-0000000000e1';

select is((select source_url_normalized from public.recipes where id = 'ee000000-0000-4000-8000-0000000000e1'), 'https://example.test/Lemon-Chicken', 'a soft-deleted recipe keeps its key');
select lives_ok($$insert into public.recipes (id, household_id, title, source_type, source_url) values ('ee000000-0000-4000-8000-0000000000e3', '0a000000-0000-4000-8000-00000000000a', 'Lemon chicken, again', 'url', 'https://example.test/Lemon-Chicken')$$, 'a soft-deleted recipe frees its link');
select lives_ok($$insert into public.recipes (household_id, title, source_type, source_url, deleted_at) values ('0a000000-0000-4000-8000-00000000000a', 'Old copy', 'url', 'https://example.test/Lemon-Chicken', now())$$, 'any number of soft-deleted copies of a link can exist');
select throws_ok($$update public.recipes set deleted_at = null where id = 'ee000000-0000-4000-8000-0000000000e1'$$, '23505', 'duplicate key value violates unique constraint "recipes_household_source_url_normalized_uq"', 'a deleted recipe cannot be brought back over a live copy of its link');

-- ---------------------------------------------------------------------------------------
-- The key follows source_url
-- ---------------------------------------------------------------------------------------

update public.recipes set source_url = 'https://Example.test/Moved/' where id = 'ee000000-0000-4000-8000-0000000000e3';
select is((select source_url_normalized from public.recipes where id = 'ee000000-0000-4000-8000-0000000000e3'), 'https://example.test/Moved', 'changing source_url (service role only) recomputes the key');

update public.recipes set title = 'Renamed' where id = 'ee000000-0000-4000-8000-0000000000e3';
select is((select source_url_normalized from public.recipes where id = 'ee000000-0000-4000-8000-0000000000e3'), 'https://example.test/Moved', 'changing something else leaves the key alone');

-- ---------------------------------------------------------------------------------------
-- Alice (a client): the same rules through RLS, and no way to write the key
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;

select throws_ok($$insert into public.recipes (household_id, title, source_type, source_url) values ('0a000000-0000-4000-8000-00000000000a', 'From the app', 'url', 'https://example.test/Moved?utm_medium=app')$$, '23505', 'duplicate key value violates unique constraint "recipes_household_source_url_normalized_uq"', 'a client save of an existing link is refused');
select lives_ok($$insert into public.recipes (household_id, title, source_type, source_url) values ('0a000000-0000-4000-8000-00000000000a', 'Fresh link', 'url', 'https://example.test/Fresh/')$$, 'a client can save a new link');
select is((select source_url_normalized from public.recipes where title = 'Fresh link' and household_id = '0a000000-0000-4000-8000-00000000000a'), 'https://example.test/Fresh', 'and the trigger fills its key');
select throws_ok($$insert into public.recipes (household_id, title, source_type, source_url, source_url_normalized) values ('0a000000-0000-4000-8000-00000000000a', 'Forged key', 'url', 'https://example.test/Forged', 'https://example.test/other')$$, '42501', 'permission denied for table recipes', 'a client cannot insert the key');
select throws_ok($$update public.recipes set source_url_normalized = null where title = 'Fresh link'$$, '42501', 'permission denied for table recipes', 'a client cannot update the key');

-- ---------------------------------------------------------------------------------------
-- Bob (another household) sees none of it
-- ---------------------------------------------------------------------------------------

reset role;
set local request.jwt.claims = '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}';
set local role authenticated;

select is_empty($$select 1 from public.recipes where household_id = '0a000000-0000-4000-8000-00000000000a'$$, 'bob reads no recipe of household A, so he learns no link of theirs');

reset role;

select finish();

rollback;
