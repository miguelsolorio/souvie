-- WS06: pgTAP tests for the columns the onboarding migration adds to profiles, the column-level
-- privileges on profiles and households, the CHECK on profiles.preferences, and the privacy of
-- preferences between households (acceptance criterion 12). Run with `supabase test db`.
--
-- Cast of characters:
--   ann    owns household A         cal    a member (not the owner) of household A
--   bea    owns household B

begin;

select plan(64);

-- ---------------------------------------------------------------------------------------
-- Fixtures (as the postgres role)
-- ---------------------------------------------------------------------------------------

create function public.__t_ws06_affected(sql text) returns bigint
language plpgsql as $$
declare n bigint;
begin
  execute sql;
  get diagnostics n = row_count;
  return n;
end;
$$;

insert into auth.users (id, email) values
  ('a1111111-1111-4111-8111-111111111111', 'ann@example.test'),
  ('c3333333-3333-4333-8333-333333333333', 'cal@example.test'),
  ('b2222222-2222-4222-8222-222222222222', 'bea@example.test');

insert into public.households (id, name, created_by) values
  ('0a000000-0000-4000-8000-00000000000a', 'Ann House', 'a1111111-1111-4111-8111-111111111111'),
  ('0b000000-0000-4000-8000-00000000000b', 'Bea House', 'b2222222-2222-4222-8222-222222222222');

insert into public.household_members (household_id, user_id, role) values
  ('0a000000-0000-4000-8000-00000000000a', 'a1111111-1111-4111-8111-111111111111', 'owner'),
  ('0a000000-0000-4000-8000-00000000000a', 'c3333333-3333-4333-8333-333333333333', 'member'),
  ('0b000000-0000-4000-8000-00000000000b', 'b2222222-2222-4222-8222-222222222222', 'owner');

-- ---------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------

select has_column('public', 'profiles', 'preferences', 'profiles.preferences exists');
select col_type_is('public', 'profiles', 'preferences', 'jsonb', 'preferences is jsonb');
select col_not_null('public', 'profiles', 'preferences', 'preferences is not null');
select col_default_is('public', 'profiles', 'preferences', '{}'::jsonb, 'preferences defaults to an empty object');

select has_column('public', 'profiles', 'onboarding_step', 'profiles.onboarding_step exists');
select col_type_is('public', 'profiles', 'onboarding_step', 'smallint', 'onboarding_step is smallint');
select col_not_null('public', 'profiles', 'onboarding_step', 'onboarding_step is not null');
select col_default_is('public', 'profiles', 'onboarding_step', 0::smallint, 'onboarding_step starts at 0');

select has_column('public', 'profiles', 'taste_embedding', 'profiles.taste_embedding exists');
select is(
  (select format_type(a.atttypid, a.atttypmod) like '%vector(1024)' from pg_attribute a where a.attrelid = 'public.profiles'::regclass and a.attname = 'taste_embedding'),
  true,
  'taste_embedding is a vector(1024)'
);
select col_is_null('public', 'profiles', 'taste_embedding', 'taste_embedding may be null (cold profile)');

select has_column('public', 'profiles', 'costco_member', 'profiles.costco_member exists');
select col_type_is('public', 'profiles', 'costco_member', 'boolean', 'costco_member is boolean');
select col_is_null('public', 'profiles', 'costco_member', 'costco_member is null until asked');

select is((select onboarding_step from public.profiles where user_id = 'a1111111-1111-4111-8111-111111111111'), 0::smallint, 'a new profile starts at onboarding step 0');
select is((select preferences from public.profiles where user_id = 'a1111111-1111-4111-8111-111111111111'), '{}'::jsonb, 'a new profile starts with empty preferences');
select ok(
  exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'recipes' and indexdef ilike '%using hnsw%' and indexdef ilike '%embedding%'),
  'recipes.embedding has an HNSW index (the suggest function relies on it)'
);

-- ---------------------------------------------------------------------------------------
-- Column privileges: pinned, so a later migration cannot widen them silently
-- ---------------------------------------------------------------------------------------

select column_privs_are('public', 'profiles', 'user_id', 'authenticated', array['SELECT', 'INSERT'], 'profiles.user_id: select and insert, never update');
select column_privs_are('public', 'profiles', 'display_name', 'authenticated', array['SELECT', 'INSERT', 'UPDATE'], 'profiles.display_name is client-editable');
select column_privs_are('public', 'profiles', 'avatar_url', 'authenticated', array['SELECT', 'INSERT', 'UPDATE'], 'profiles.avatar_url is client-editable');
select column_privs_are('public', 'profiles', 'preferences', 'authenticated', array['SELECT', 'INSERT', 'UPDATE'], 'profiles.preferences is client-editable');
select column_privs_are('public', 'profiles', 'onboarding_step', 'authenticated', array['SELECT', 'INSERT', 'UPDATE'], 'profiles.onboarding_step is client-editable');
select column_privs_are('public', 'profiles', 'costco_member', 'authenticated', array['SELECT', 'INSERT', 'UPDATE'], 'profiles.costco_member is client-editable');
select column_privs_are('public', 'profiles', 'taste_embedding', 'authenticated', array['SELECT'], 'profiles.taste_embedding is read-only for clients');
select column_privs_are('public', 'profiles', 'created_at', 'authenticated', array['SELECT'], 'profiles.created_at is read-only for clients');
select column_privs_are('public', 'profiles', 'updated_at', 'authenticated', array['SELECT'], 'profiles.updated_at is read-only for clients');
select table_privs_are('public', 'profiles', 'anon', array[]::text[], 'anon has no privileges on profiles');

select column_privs_are('public', 'households', 'name', 'authenticated', array['SELECT', 'UPDATE'], 'households.name is owner-editable');
select column_privs_are('public', 'households', 'zip', 'authenticated', array['SELECT', 'UPDATE'], 'households.zip is owner-editable');
select column_privs_are('public', 'households', 'id', 'authenticated', array['SELECT'], 'households.id is read-only for clients');
select column_privs_are('public', 'households', 'created_by', 'authenticated', array['SELECT'], 'households.created_by is read-only for clients');
select column_privs_are('public', 'households', 'default_connection_id', 'authenticated', array['SELECT'], 'households.default_connection_id is read-only for clients');
select column_privs_are('public', 'households', 'deleted_at', 'authenticated', array['SELECT'], 'households.deleted_at is read-only for clients');
select table_privs_are('public', 'households', 'anon', array[]::text[], 'anon has no privileges on households');

-- ---------------------------------------------------------------------------------------
-- Ann (owner of A) works through onboarding
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;

select is(
  public.__t_ws06_affected($$update public.profiles set preferences = '{"allergies": ["shellfish"], "dinners_per_week": 5}'::jsonb, onboarding_step = 3 where user_id = 'a1111111-1111-4111-8111-111111111111'$$),
  1::bigint,
  'ann can save preferences and her onboarding step'
);
select is((select onboarding_step from public.profiles where user_id = 'a1111111-1111-4111-8111-111111111111'), 3::smallint, 'the step she saved is the step that comes back (resume reads it)');
select is(
  public.__t_ws06_affected($$update public.profiles set costco_member = true where user_id = 'a1111111-1111-4111-8111-111111111111'$$),
  1::bigint,
  'ann can record her Costco membership'
);
select is(
  public.__t_ws06_affected($$update public.households set zip = '98019' where id = '0a000000-0000-4000-8000-00000000000a'$$),
  1::bigint,
  'the owner can set the household zip on the stores screen'
);

select throws_ok(
  $$update public.profiles set taste_embedding = array_fill(0.1::real, array[1024])::extensions.vector where user_id = 'a1111111-1111-4111-8111-111111111111'$$,
  '42501', 'permission denied for table profiles',
  'ann cannot write the taste embedding'
);
select throws_ok(
  $$update public.profiles set user_id = 'b2222222-2222-4222-8222-222222222222' where user_id = 'a1111111-1111-4111-8111-111111111111'$$,
  '42501', 'permission denied for table profiles',
  'ann cannot change which user a profile belongs to'
);
select throws_ok(
  $$update public.profiles set created_at = now() where user_id = 'a1111111-1111-4111-8111-111111111111'$$,
  '42501', 'permission denied for table profiles',
  'ann cannot rewrite created_at'
);

-- The CHECK on preferences.
select throws_ok(
  $$update public.profiles set preferences = '{"allergies": ["shellfsh"]}'::jsonb where user_id = 'a1111111-1111-4111-8111-111111111111'$$,
  '23514', null,
  'a misspelled allergen is refused (it would silently filter nothing)'
);
select throws_ok(
  $$update public.profiles set preferences = '{"allergies": "peanut"}'::jsonb where user_id = 'a1111111-1111-4111-8111-111111111111'$$,
  '23514', null,
  'allergies must be a list'
);
select throws_ok(
  $$update public.profiles set preferences = '{"allergies": ["Peanut"]}'::jsonb where user_id = 'a1111111-1111-4111-8111-111111111111'$$,
  '23514', null,
  'allergen names are exact and lowercase'
);
select throws_ok(
  $$update public.profiles set preferences = '{"diets": ["carnivore"]}'::jsonb where user_id = 'a1111111-1111-4111-8111-111111111111'$$,
  '23514', null,
  'an unknown diet is refused'
);
select throws_ok(
  $$update public.profiles set preferences = '[]'::jsonb where user_id = 'a1111111-1111-4111-8111-111111111111'$$,
  '23514', null,
  'preferences must be an object'
);
select throws_ok(
  $$update public.profiles set preferences = jsonb_build_object('notes', repeat('x', 20000)) where user_id = 'a1111111-1111-4111-8111-111111111111'$$,
  '23514', null,
  'preferences are capped in size'
);
select lives_ok(
  $$update public.profiles set preferences = '{"allergies": ["peanut", "tree_nut", "milk", "egg", "wheat", "soy", "fish", "shellfish", "sesame"], "diets": ["vegan", "gluten_free"], "future_key": 1}'::jsonb where user_id = 'a1111111-1111-4111-8111-111111111111'$$,
  'all nine allergens, real diets, and unknown extra keys are accepted'
);
select throws_ok(
  $$update public.profiles set onboarding_step = 9 where user_id = 'a1111111-1111-4111-8111-111111111111'$$,
  '23514', null,
  'onboarding_step cannot pass 8'
);
select throws_ok(
  $$update public.profiles set onboarding_step = -1 where user_id = 'a1111111-1111-4111-8111-111111111111'$$,
  '23514', null,
  'onboarding_step cannot be negative'
);

-- Insert is column level too.
select throws_ok(
  $$insert into public.profiles (user_id, taste_embedding) values ('a1111111-1111-4111-8111-111111111111', array_fill(0.1::real, array[1024])::extensions.vector)$$,
  '42501', 'permission denied for table profiles',
  'a client insert cannot carry a taste embedding either'
);

-- Privacy between households (acceptance criterion 12).
select is((select count(*)::int from public.profiles), 1, 'ann sees only her own profile row');
select is_empty(
  $$select 1 from public.profiles where user_id = 'b2222222-2222-4222-8222-222222222222'$$,
  'ann cannot read bea''s preferences (another household)'
);
select is_empty(
  $$select 1 from public.profiles where user_id = 'c3333333-3333-4333-8333-333333333333'$$,
  'ann cannot read her housemate cal''s preferences either; they reach the suggest function, not the client'
);
select is(
  public.__t_ws06_affected($$update public.profiles set preferences = '{}'::jsonb, onboarding_step = 0 where user_id = 'b2222222-2222-4222-8222-222222222222'$$),
  0::bigint,
  'ann cannot overwrite bea''s preferences or progress'
);

reset role;

-- ---------------------------------------------------------------------------------------
-- Cal (a member, not the owner) can complete onboarding (acceptance criterion 12)
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}';
set local role authenticated;

select is(
  public.__t_ws06_affected($$update public.profiles set preferences = '{"allergies": [], "dinners_per_week": 4}'::jsonb, onboarding_step = 8, costco_member = false where user_id = 'c3333333-3333-4333-8333-333333333333'$$),
  1::bigint,
  'a member who is not the owner can save preferences and finish onboarding'
);
select is((select onboarding_step from public.profiles where user_id = 'c3333333-3333-4333-8333-333333333333'), 8::smallint, 'cal''s step is 8');
select is_empty(
  $$select 1 from public.profiles where user_id = 'a1111111-1111-4111-8111-111111111111'$$,
  'cal cannot read the owner''s preferences'
);
select is(
  public.__t_ws06_affected($$update public.households set zip = '98052' where id = '0a000000-0000-4000-8000-00000000000a'$$),
  0::bigint,
  'a member cannot change the household zip (only the owner can)'
);
select is((select zip from public.households where id = '0a000000-0000-4000-8000-00000000000a'), '98019', 'the household zip is still the owner''s');
select is((select count(*)::int from public.households), 1, 'cal can read their household');

reset role;

-- ---------------------------------------------------------------------------------------
-- The service role writes the embedding the suggest function builds
-- ---------------------------------------------------------------------------------------

set local role service_role;

select lives_ok(
  $$update public.profiles set taste_embedding = array_fill(0.1::real, array[1024])::extensions.vector where user_id = 'a1111111-1111-4111-8111-111111111111'$$,
  'the service role can write taste_embedding'
);
select throws_ok(
  $$update public.profiles set taste_embedding = array_fill(0.1::real, array[3])::extensions.vector where user_id = 'a1111111-1111-4111-8111-111111111111'$$,
  '22000', null,
  'taste_embedding holds exactly 1024 dimensions'
);

reset role;

select is(
  (select taste_embedding is not null from public.profiles where user_id = 'a1111111-1111-4111-8111-111111111111'),
  true,
  'the embedding the service role wrote is stored'
);

select * from finish();

rollback;
