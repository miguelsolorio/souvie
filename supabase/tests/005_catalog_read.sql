-- Orchestrator (2026-10-30): catalog recipes are readable by every signed-in member and writable
-- by no client. Run with `supabase test db`. Everything happens inside one transaction that is
-- rolled back.
--
-- Cast of characters (fixed ids):
--   alice  owns household A       dave  belongs to no household

begin;

select plan(11);

-- ---------------------------------------------------------------------------------------
-- Fixtures (as the postgres role, which bypasses RLS)
-- ---------------------------------------------------------------------------------------

-- How many rows a statement touched. RLS hides rows from UPDATE and DELETE rather than raising,
-- so "denied" shows up as zero rows affected.
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
  ('d4444444-4444-4444-8444-444444444444', 'dave@example.test', '{}');

insert into public.households (id, name, created_by) values
  ('0a000000-0000-4000-8000-00000000000a', 'Alice House', 'a1111111-1111-4111-8111-111111111111');

insert into public.household_members (household_id, user_id, role) values
  ('0a000000-0000-4000-8000-00000000000a', 'a1111111-1111-4111-8111-111111111111', 'owner');

-- C1 is a live catalog recipe, C2 a retired one, A1 belongs to household A.
insert into public.recipes (id, household_id, title, source_type, visibility, created_by, deleted_at) values
  ('cc000000-0000-4000-8000-000000000001', null, 'C1 catalog skillet', 'ai', 'catalog', null, null),
  ('cc000000-0000-4000-8000-000000000002', null, 'C2 retired catalog', 'ai', 'catalog', null, now()),
  ('aa000000-0000-4000-8000-000000000001', '0a000000-0000-4000-8000-00000000000a', 'A1 lemon chicken', 'manual', 'household', 'a1111111-1111-4111-8111-111111111111', null);

insert into public.recipe_ingredients (id, recipe_id, position, raw_text) values
  ('c0000000-0000-4000-8000-0000000000c1', 'cc000000-0000-4000-8000-000000000001', 0, '1 lb chicken thighs'),
  ('c0000000-0000-4000-8000-0000000000c2', 'cc000000-0000-4000-8000-000000000001', 1, '2 cups rice'),
  ('c0000000-0000-4000-8000-0000000000c3', 'cc000000-0000-4000-8000-000000000002', 0, '1 onion'),
  ('a0000000-0000-4000-8000-0000000000a1', 'aa000000-0000-4000-8000-000000000001', 0, '8 bone-in chicken thighs');

-- ---------------------------------------------------------------------------------------
-- Signed out (anon) gets nothing
-- ---------------------------------------------------------------------------------------

set local role anon;

select throws_ok(
  $$select count(*) from public.recipes where visibility = 'catalog'$$,
  '42501', 'permission denied for table recipes',
  'anon cannot read the catalog');

reset role;

-- ---------------------------------------------------------------------------------------
-- Dave (no household): reads the catalog and nothing else, writes nothing
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "d4444444-4444-4444-8444-444444444444", "role": "authenticated"}';
set local role authenticated;

select results_eq(
  $$select id::text from public.recipes order by id$$,
  $$values ('cc000000-0000-4000-8000-000000000001'), ('cc000000-0000-4000-8000-000000000002')$$,
  'dave reads both catalog recipes, retired included, and no household recipe');

select is(
  (select count(*)::int from public.recipe_ingredients where recipe_id = 'cc000000-0000-4000-8000-000000000001'),
  2,
  'dave reads the catalog recipe lines');

select is(
  (select count(*)::int from public.recipe_ingredients where recipe_id = 'aa000000-0000-4000-8000-000000000001'),
  0,
  'dave reads no household lines');

select is(
  public.__t_affected($$update public.recipes set title = 'hacked' where id = 'cc000000-0000-4000-8000-000000000001'$$),
  0::bigint,
  'dave cannot update a catalog recipe');

select is(
  public.__t_affected($$update public.recipe_ingredients set raw_text = 'hacked' where id = 'c0000000-0000-4000-8000-0000000000c1'$$),
  0::bigint,
  'dave cannot update a catalog line');

select is(
  public.__t_affected($$delete from public.recipe_ingredients where id = 'c0000000-0000-4000-8000-0000000000c1'$$),
  0::bigint,
  'dave cannot delete a catalog line');

select throws_ok(
  $$insert into public.recipes (household_id, title, source_type, visibility) values (null, 'forged catalog', 'ai', 'catalog')$$,
  '42501', null,
  'dave cannot insert a catalog recipe');

select throws_ok(
  $$insert into public.recipe_ingredients (recipe_id, position, raw_text) values ('cc000000-0000-4000-8000-000000000001', 9, 'forged line')$$,
  '42501', null,
  'dave cannot add a line to a catalog recipe');

reset role;

-- ---------------------------------------------------------------------------------------
-- Alice (owner of A): the catalog plus household A, still no catalog writes
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;

select is(
  (select count(*)::int from public.recipes),
  3,
  'alice reads the two catalog recipes and her own');

select is(
  public.__t_affected($$update public.recipes set title = 'hacked' where id = 'cc000000-0000-4000-8000-000000000001'$$),
  0::bigint,
  'alice cannot update a catalog recipe');

reset role;

select * from finish();

rollback;
