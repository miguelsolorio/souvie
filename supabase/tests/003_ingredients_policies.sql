-- WS03: the ingredient ontology is global reference data.
--   ingredients, ingredient_aliases   readable by signed-in users, writable by the service role only
--   ingredient_parse_cache,           invisible to clients (they hold raw recipe text); the
--   ingredient_alias_proposals        service role reads and writes
-- Run with `supabase test db` after `supabase db reset`, which loads supabase/seed/10_ingredients.sql.

begin;

select plan(40);

-- Structure -----------------------------------------------------------------------------
select has_table('public', 'ingredients', 'ingredients exists');
select has_table('public', 'ingredient_aliases', 'ingredient_aliases exists');
select has_table('public', 'ingredient_parse_cache', 'ingredient_parse_cache exists');
select has_table('public', 'ingredient_alias_proposals', 'ingredient_alias_proposals exists');
select has_index(
  'public', 'ingredient_aliases', 'ingredient_aliases_alias_trgm_idx',
  'trigram index on ingredient_aliases.alias'
);
select col_is_unique('public', 'ingredients', 'name', 'ingredient names are unique');
select col_is_unique('public', 'ingredient_aliases', 'alias', 'aliases are unique');
select has_function(
  'public', 'match_ingredient_alias', array['text', 'real', 'integer'],
  'match_ingredient_alias exists'
);
select has_function(
  'public', 'record_ingredient_alias_proposal', array['text', 'text', 'text', 'uuid'],
  'record_ingredient_alias_proposal exists'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.ingredients'::regclass),
  'RLS is on for ingredients'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.ingredient_aliases'::regclass),
  'RLS is on for ingredient_aliases'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.ingredient_parse_cache'::regclass),
  'RLS is on for ingredient_parse_cache'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.ingredient_alias_proposals'::regclass),
  'RLS is on for ingredient_alias_proposals'
);

-- Seed ----------------------------------------------------------------------------------
select cmp_ok(
  (select count(*) from public.ingredients), '>=', 600::bigint, 'at least 600 ingredients seeded'
);
select cmp_ok(
  (select count(*) from public.ingredient_aliases), '>=', 1200::bigint,
  'at least 1,200 aliases seeded'
);
select is(
  (select count(distinct category) from public.ingredients), 16::bigint,
  'all 16 store sections are in use'
);
select is(
  (select count(*) from public.ingredients where default_unit is null or default_unit = ''),
  0::bigint,
  'every ingredient has a default unit'
);

-- A signed-in user: read the ontology, write nothing ---------------------------------------
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub": "00000000-0000-4000-8000-000000000003", "role": "authenticated"}',
  true
);

select cmp_ok(
  (select count(*) from public.ingredients), '>=', 600::bigint,
  'authenticated user can select ingredients'
);
select cmp_ok(
  (select count(*) from public.ingredient_aliases), '>=', 1200::bigint,
  'authenticated user can select ingredient_aliases'
);
select is(
  (select ingredient_id from public.match_ingredient_alias('yellow onions', 0.85::real, 1)),
  (select id from public.ingredients where name = 'yellow onion'),
  'authenticated user can call match_ingredient_alias'
);

select throws_ok(
  $$insert into public.ingredients (name, category, default_unit) values ('pgtap test thing', 'other', 'each')$$,
  '42501', null, 'authenticated user cannot insert an ingredient'
);
select throws_ok(
  $$update public.ingredients set plural = 'x' where name = 'garlic'$$,
  '42501', null, 'authenticated user cannot update an ingredient'
);
select throws_ok(
  $$delete from public.ingredients where name = 'garlic'$$,
  '42501', null, 'authenticated user cannot delete an ingredient'
);
select throws_ok(
  $$insert into public.ingredient_aliases (ingredient_id, alias)
    select id, 'pgtap test alias' from public.ingredients where name = 'garlic'$$,
  '42501', null, 'authenticated user cannot insert an alias'
);
select throws_ok(
  $$update public.ingredient_aliases set alias = 'pgtap changed' where alias = 'garlic'$$,
  '42501', null, 'authenticated user cannot update an alias'
);
select throws_ok(
  $$delete from public.ingredient_aliases where alias = 'garlic'$$,
  '42501', null, 'authenticated user cannot delete an alias'
);
select throws_ok(
  $$select count(*) from public.ingredient_parse_cache$$,
  '42501', null, 'authenticated user cannot read the parse cache'
);
select throws_ok(
  $$insert into public.ingredient_parse_cache (normalized_text, result, source) values ('x', '{}', 'llm')$$,
  '42501', null, 'authenticated user cannot write the parse cache'
);
select throws_ok(
  $$select count(*) from public.ingredient_alias_proposals$$,
  '42501', null, 'authenticated user cannot read alias proposals'
);
select throws_ok(
  $$insert into public.ingredient_alias_proposals (raw_text, proposed_name) values ('x', 'x')$$,
  '42501', null, 'authenticated user cannot write alias proposals'
);
select throws_ok(
  $$select public.record_ingredient_alias_proposal('1 tbsp x', 'x')$$,
  '42501', null, 'authenticated user cannot call record_ingredient_alias_proposal'
);

-- Signed out ----------------------------------------------------------------------------
reset role;
set local role anon;
select throws_ok(
  $$select count(*) from public.ingredients$$,
  '42501', null, 'anon cannot read ingredients'
);
select throws_ok(
  $$select count(*) from public.ingredient_aliases$$,
  '42501', null, 'anon cannot read ingredient_aliases'
);

-- The service role: the only writer -----------------------------------------------------------
reset role;
set local role service_role;
select lives_ok(
  $$insert into public.ingredient_alias_proposals (raw_text, proposed_name, proposed_category)
    values ('1 tablespoon gochugaru', 'gochugaru', 'international')$$,
  'service role can write alias proposals'
);
select throws_ok(
  $$insert into public.ingredient_alias_proposals (raw_text, proposed_name) values ('2 tsp gochugaru', 'gochugaru')$$,
  '23505', null, 'only one pending proposal per name'
);
select lives_ok(
  $$insert into public.ingredient_parse_cache (normalized_text, result, source, model)
    values ('1 tbsp gochugaru', '{"items": []}', 'llm', 'claude-haiku-5-5')$$,
  'service role can write the parse cache'
);
select lives_ok(
  $$select public.record_ingredient_alias_proposal('1 cup freekeh', ' Freekeh ', 'pantry')$$,
  'service role can record a proposal'
);
select lives_ok(
  $$select public.record_ingredient_alias_proposal('2 cups freekeh', 'freekeh')$$,
  'recording the same name again does not fail'
);
select is(
  (select count from public.ingredient_alias_proposals where proposed_name = 'freekeh'),
  2,
  'the second report increments the count'
);
select is(
  (select proposed_category from public.ingredient_alias_proposals where proposed_name = 'freekeh'),
  'pantry',
  'the first category sticks'
);

select * from finish();
rollback;
