-- WS04: pgTAP tests for meal_plans, meal_plan_entries, recipe_feedback, their triggers, and the
-- Realtime publication. Run with `supabase test db`. Everything happens inside one transaction
-- that is rolled back.
--
-- What it proves:
--   * a member of household A reads nothing of household B in any of the three tables
--   * a member cannot create plans, add entries, or write feedback in B, and cannot forge a
--     household, a user, or a signal the trigger owns
--   * an entry always takes its household from its plan, stays inside the plan's week, and
--     points at a live recipe of the household
--   * saved, cooked, and skipped feedback is written with the entry change, once per real change
--   * a thumb is allowed on a household's live recipe or a catalog recipe, never on a deleted one
--   * why (the one-line reason for a suggested meal) is client-writable and capped at 200 characters
--   * the grants are column-level, so a later migration cannot widen them silently
--   * both plan tables are in the Realtime publication, and entry deletes can be filtered
--
-- Cast of characters (fixed ids, so the SQL below stays readable):
--   alice  owns household A       carol  is a plain member of A
--   bob    owns household B       dave   belongs to no household

begin;

select plan(97);

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

-- RA1 and RA3 are live recipes of A, RA2 is a deleted recipe of A, RB1 is a recipe of B.
insert into public.recipes (id, household_id, title, source_type, deleted_at) values
  ('aa000000-0000-4000-8000-000000000001', '0a000000-0000-4000-8000-00000000000a', 'A1 lemon chicken', 'manual', null),
  ('aa000000-0000-4000-8000-000000000002', '0a000000-0000-4000-8000-00000000000a', 'A2 old soup', 'manual', now()),
  ('aa000000-0000-4000-8000-000000000003', '0a000000-0000-4000-8000-00000000000a', 'A3 green curry', 'manual', null),
  ('bb000000-0000-4000-8000-000000000001', '0b000000-0000-4000-8000-00000000000b', 'B1 secret stew', 'manual', null);

-- C1 is a catalog recipe (no household). Clients can read it only where main carries the
-- recipes_catalog_read migration, and the thumbs policy below depends on that read.
insert into public.recipes (id, household_id, title, source_type, visibility) values
  ('cc000000-0000-4000-8000-000000000001', null, 'C1 catalog soup', 'manual', 'catalog');

-- Week of Monday 2026-11-02 in both households. As the service role, so no feedback is written.
insert into public.meal_plans (id, household_id, week_start) values
  ('ca000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '2026-11-02'),
  ('cb000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b', '2026-11-02');

insert into public.meal_plan_entries (id, plan_id, household_id, date, slot, recipe_id, servings) values
  ('ea000000-0000-4000-8000-0000000000a1', 'ca000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '2026-11-03', 'dinner', 'aa000000-0000-4000-8000-000000000001', 4),
  ('eb000000-0000-4000-8000-0000000000b1', 'cb000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b', '2026-11-03', 'dinner', 'bb000000-0000-4000-8000-000000000001', 2);

insert into public.recipe_feedback (id, household_id, user_id, recipe_id, signal) values
  ('f1000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', 'a1111111-1111-4111-8111-111111111111', 'aa000000-0000-4000-8000-000000000001', 'like'),
  ('f1000000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-00000000000a', 'c3333333-3333-4333-8333-333333333333', 'aa000000-0000-4000-8000-000000000001', 'dislike'),
  ('f1000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b', 'b2222222-2222-4222-8222-222222222222', 'bb000000-0000-4000-8000-000000000001', 'like');

-- ---------------------------------------------------------------------------------------
-- Shape: RLS on, the reviewed policy set, column-level grants, constraints, Realtime
-- ---------------------------------------------------------------------------------------

select ok((select relrowsecurity from pg_class where oid = 'public.meal_plans'::regclass), 'meal_plans has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.meal_plan_entries'::regclass), 'meal_plan_entries has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.recipe_feedback'::regclass), 'recipe_feedback has RLS enabled');

select policies_are('public', 'meal_plans', array['meal_plans: members read', 'meal_plans: members insert'], 'meal_plans has exactly the reviewed policies (no update or delete policy)');
select policies_are('public', 'meal_plan_entries', array['meal_plan_entries: members read', 'meal_plan_entries: members insert', 'meal_plan_entries: members update', 'meal_plan_entries: members delete'], 'meal_plan_entries has exactly the reviewed policies');
select policies_are('public', 'recipe_feedback', array['recipe_feedback: members read', 'recipe_feedback: own thumbs insert', 'recipe_feedback: own thumbs delete'], 'recipe_feedback has exactly the reviewed policies (no update policy)');

-- Grants. Column-level, so a later migration that adds a column has to grant it on purpose.
select ok(
  (select bool_and(has_column_privilege('authenticated', 'public.meal_plan_entries', c, 'UPDATE'))
   from unnest(array['date', 'slot', 'recipe_id', 'servings', 'status', 'notes', 'position', 'why']) c),
  'clients may update date, slot, recipe_id, servings, status, notes, position, and why on an entry'
);
select ok(
  not (select bool_or(has_column_privilege('authenticated', 'public.meal_plan_entries', c, 'UPDATE'))
       from unnest(array['id', 'plan_id', 'household_id', 'created_at', 'updated_at']) c),
  'clients may not update id, plan_id, household_id, or the timestamps on an entry'
);
select ok(
  (select bool_and(has_column_privilege('authenticated', 'public.meal_plan_entries', c, 'INSERT'))
   from unnest(array['id', 'plan_id', 'household_id', 'date', 'slot', 'recipe_id', 'servings', 'status', 'notes', 'position', 'why']) c)
  and not (select bool_or(has_column_privilege('authenticated', 'public.meal_plan_entries', c, 'INSERT'))
           from unnest(array['created_at', 'updated_at']) c),
  'clients insert the eleven entry columns, why included, and not the timestamps'
);
select ok(
  (select bool_and(has_column_privilege('authenticated', 'public.meal_plans', c, 'INSERT'))
   from unnest(array['id', 'household_id', 'week_start']) c)
  and not (select bool_or(has_column_privilege('authenticated', 'public.meal_plans', c, 'UPDATE'))
           from unnest(array['id', 'household_id', 'week_start', 'created_at', 'updated_at']) c),
  'clients insert a plan (id, household_id, week_start) and can update no plan column'
);
select ok(
  (select bool_and(has_column_privilege('authenticated', 'public.recipe_feedback', c, 'INSERT'))
   from unnest(array['id', 'household_id', 'recipe_id', 'signal', 'rating']) c)
  and not (select bool_or(has_column_privilege('authenticated', 'public.recipe_feedback', c, 'INSERT'))
           from unnest(array['user_id', 'created_at']) c)
  and not (select bool_or(has_column_privilege('authenticated', 'public.recipe_feedback', c, 'UPDATE'))
           from unnest(array['id', 'household_id', 'user_id', 'recipe_id', 'signal', 'rating', 'created_at']) c),
  'clients insert feedback without user_id or created_at and can update no feedback column'
);
select ok(
  not exists (
    select 1
    from unnest(array['meal_plans', 'meal_plan_entries', 'recipe_feedback']) t
    where has_table_privilege('anon', 'public.' || t, 'SELECT')
       or has_table_privilege('anon', 'public.' || t, 'INSERT')
       or has_table_privilege('anon', 'public.' || t, 'UPDATE')
       or has_table_privilege('anon', 'public.' || t, 'DELETE')
  ),
  'anon has no privilege on any planning table'
);

-- Constraints that hold even for a client that skips the app (checked as postgres).
select throws_ok(
  $$insert into public.meal_plans (household_id, week_start) values ('0a000000-0000-4000-8000-00000000000a', '2026-11-03')$$,
  '23514', 'new row for relation "meal_plans" violates check constraint "meal_plans_week_start_monday"',
  'a plan''s week_start must be a Monday'
);
select throws_ok(
  $$insert into public.meal_plans (household_id, week_start) values ('0a000000-0000-4000-8000-00000000000a', '2026-11-02')$$,
  '23505', 'duplicate key value violates unique constraint "meal_plans_household_week_key"',
  'a household has one plan per week'
);

-- Realtime: both plan tables publish, and the entries table logs the full old row so a delete can
-- be filtered by household_id.
select is(
  (select count(*)::int from pg_publication_tables
   where pubname = 'supabase_realtime' and schemaname = 'public'
     and tablename in ('meal_plans', 'meal_plan_entries')),
  2,
  'meal_plans and meal_plan_entries are in the supabase_realtime publication'
);
select is(
  (select relreplident::text from pg_class where oid = 'public.meal_plan_entries'::regclass),
  'f',
  'meal_plan_entries logs the full old row, so Realtime can filter deletes by household_id'
);

-- ---------------------------------------------------------------------------------------
-- Signed out (anon) gets nothing
-- ---------------------------------------------------------------------------------------

set local role anon;

select throws_ok($$select count(*) from public.meal_plans$$, '42501', 'permission denied for table meal_plans', 'anon cannot read meal_plans');
select throws_ok($$select count(*) from public.meal_plan_entries$$, '42501', 'permission denied for table meal_plan_entries', 'anon cannot read meal_plan_entries');
select throws_ok($$select count(*) from public.recipe_feedback$$, '42501', 'permission denied for table recipe_feedback', 'anon cannot read recipe_feedback');

reset role;

-- ---------------------------------------------------------------------------------------
-- Alice (owner of A): reads only household A
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;

select is((select count(*)::int from public.meal_plans), 1, 'alice sees the one plan of household A');
select is((select count(*)::int from public.meal_plan_entries), 1, 'alice sees the one entry of household A');
select is((select count(*)::int from public.recipe_feedback), 2, 'alice sees both feedback rows of household A, including carol''s');
select is_empty($$select 1 from public.meal_plans where household_id = '0b000000-0000-4000-8000-00000000000b'$$, 'alice reads no plan of household B');
select is_empty($$select 1 from public.meal_plan_entries where id = 'eb000000-0000-4000-8000-0000000000b1'$$, 'alice cannot fetch an entry of B by id');
select is_empty($$select 1 from public.recipe_feedback where household_id = '0b000000-0000-4000-8000-00000000000b'$$, 'alice reads no feedback of household B');

-- Plans: created lazily by a member, only for their own household.
select throws_ok(
  $$insert into public.meal_plans (household_id, week_start) values ('0b000000-0000-4000-8000-00000000000b', '2026-11-09')$$,
  '42501', 'new row violates row-level security policy for table "meal_plans"',
  'alice cannot create a plan in household B'
);
select lives_ok(
  $$insert into public.meal_plans (id, household_id, week_start) values ('ca000000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-00000000000a', '2026-11-09')$$,
  'alice creates the plan for the next week with an id she picked'
);
select is(
  public.__t_affected($$insert into public.meal_plans (id, household_id, week_start) values ('ca000000-0000-4000-8000-0000000000a9', '0a000000-0000-4000-8000-00000000000a', '2026-11-09') on conflict (household_id, week_start) do nothing$$),
  0::bigint,
  'a second device creating the same week gets ON CONFLICT DO NOTHING, not a duplicate'
);
select throws_ok($$update public.meal_plans set week_start = '2026-11-16' where id = 'ca000000-0000-4000-8000-0000000000a2'$$, '42501', 'permission denied for table meal_plans', 'clients cannot move a plan to another week');
select throws_ok($$delete from public.meal_plans where id = 'ca000000-0000-4000-8000-0000000000a2'$$, '42501', 'permission denied for table meal_plans', 'clients cannot delete a plan');

-- Entries: the trigger decides the household, the week, and the recipe.
select lives_ok(
  $$insert into public.meal_plan_entries (id, plan_id, household_id, date, slot, recipe_id, servings, position)
    values ('ea000000-0000-4000-8000-0000000000a2', 'ca000000-0000-4000-8000-0000000000a1', '0b000000-0000-4000-8000-00000000000b', '2026-11-04', 'lunch', 'aa000000-0000-4000-8000-000000000001', 4, 0)$$,
  'alice adds a recipe to Wednesday lunch (even with a forged household_id in the payload)'
);
select is(
  (select household_id from public.meal_plan_entries where id = 'ea000000-0000-4000-8000-0000000000a2'),
  '0a000000-0000-4000-8000-00000000000a'::uuid,
  'the entry took its household from the plan, not from the payload'
);
select is(
  (select status::text from public.meal_plan_entries where id = 'ea000000-0000-4000-8000-0000000000a2'),
  'planned',
  'a new entry is planned by default'
);
select throws_ok(
  $$insert into public.meal_plan_entries (plan_id, household_id, date, slot, recipe_id, servings)
    values ('cb000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b', '2026-11-04', 'lunch', 'aa000000-0000-4000-8000-000000000001', 2)$$,
  'P0001', 'plan_not_found',
  'alice cannot add an entry to household B''s plan (she cannot even see it)'
);
select throws_ok(
  $$insert into public.meal_plan_entries (plan_id, household_id, date, slot, recipe_id, servings)
    values ('ca000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '2026-11-09', 'lunch', 'aa000000-0000-4000-8000-000000000001', 2)$$,
  'P0001', 'date_outside_plan_week',
  'a date after the plan''s week is rejected'
);
select throws_ok(
  $$insert into public.meal_plan_entries (plan_id, household_id, date, slot, recipe_id, servings)
    values ('ca000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '2026-11-01', 'lunch', 'aa000000-0000-4000-8000-000000000001', 2)$$,
  'P0001', 'date_outside_plan_week',
  'a date before the plan''s week is rejected'
);
select throws_ok(
  $$insert into public.meal_plan_entries (plan_id, household_id, date, slot, recipe_id, servings)
    values ('ca000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '2026-11-04', 'lunch', 'bb000000-0000-4000-8000-000000000001', 2)$$,
  'P0001', 'recipe_not_found',
  'a recipe of household B cannot be planned in household A'
);
select throws_ok(
  $$insert into public.meal_plan_entries (plan_id, household_id, date, slot, recipe_id, servings)
    values ('ca000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '2026-11-04', 'lunch', 'aa000000-0000-4000-8000-000000000002', 2)$$,
  'P0001', 'recipe_not_found',
  'a deleted recipe cannot be planned'
);
select throws_ok(
  $$insert into public.meal_plan_entries (plan_id, household_id, date, slot, recipe_id, servings)
    values ('ca000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '2026-11-04', 'lunch', 'aa000000-0000-4000-8000-000000000001', 0)$$,
  '23514', 'new row for relation "meal_plan_entries" violates check constraint "meal_plan_entries_servings_range"',
  'servings must be positive'
);
select throws_ok(
  $$insert into public.meal_plan_entries (plan_id, household_id, date, slot, recipe_id, servings)
    values ('ca000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '2026-11-04', 'brunch', 'aa000000-0000-4000-8000-000000000001', 2)$$,
  '22P02', 'invalid input value for enum meal_plan_entries_slot: "brunch"',
  'the slot is breakfast, lunch, dinner, or snack'
);

-- Editing: column-level.
select is(public.__t_affected($$update public.meal_plan_entries set servings = 6, notes = 'double it', position = 1 where id = 'ea000000-0000-4000-8000-0000000000a1'$$), 1::bigint, 'alice changes servings, notes, and position of her entry');
select is(public.__t_affected($$update public.meal_plan_entries set why = 'Uses the leftover lemons' where id = 'ea000000-0000-4000-8000-0000000000a1'$$), 1::bigint, 'alice sets the why of her entry (the client does this when it applies a suggested swap)');
select throws_ok(
  $$update public.meal_plan_entries set why = repeat('x', 201) where id = 'ea000000-0000-4000-8000-0000000000a1'$$,
  '23514', 'new row for relation "meal_plan_entries" violates check constraint "meal_plan_entries_why_length"',
  'a why is 200 characters at most'
);
select throws_ok($$update public.meal_plan_entries set plan_id = 'ca000000-0000-4000-8000-0000000000a2' where id = 'ea000000-0000-4000-8000-0000000000a1'$$, '42501', 'permission denied for table meal_plan_entries', 'an entry cannot move to another plan');
select throws_ok($$update public.meal_plan_entries set household_id = '0b000000-0000-4000-8000-00000000000b' where id = 'ea000000-0000-4000-8000-0000000000a1'$$, '42501', 'permission denied for table meal_plan_entries', 'an entry cannot be handed to another household');
select throws_ok($$update public.meal_plan_entries set date = '2026-11-12' where id = 'ea000000-0000-4000-8000-0000000000a1'$$, 'P0001', 'date_outside_plan_week', 'moving an entry outside its plan''s week is rejected');
select is(public.__t_affected($$update public.meal_plan_entries set date = '2026-11-05', slot = 'dinner' where id = 'ea000000-0000-4000-8000-0000000000a1'$$), 1::bigint, 'moving an entry to another day in the same week works');
select is(public.__t_affected($$update public.meal_plan_entries set servings = 9 where id = 'eb000000-0000-4000-8000-0000000000b1'$$), 0::bigint, 'alice updates no entry of household B');
select is(public.__t_affected($$delete from public.meal_plan_entries where id = 'eb000000-0000-4000-8000-0000000000b1'$$), 0::bigint, 'alice deletes no entry of household B');

-- Feedback written with the entry: saved on add, cooked and skipped on a status change, once each.
select is(
  (select count(*)::int from public.recipe_feedback where user_id = 'a1111111-1111-4111-8111-111111111111' and recipe_id = 'aa000000-0000-4000-8000-000000000001' and signal = 'saved'),
  1,
  'adding a recipe to a plan wrote one saved signal for alice'
);
select is(public.__t_affected($$update public.meal_plan_entries set status = 'cooked' where id = 'ea000000-0000-4000-8000-0000000000a2'$$), 1::bigint, 'alice marks Wednesday lunch cooked');
select is(
  (select count(*)::int from public.recipe_feedback where user_id = 'a1111111-1111-4111-8111-111111111111' and signal = 'cooked'),
  1,
  'marking an entry cooked wrote one cooked signal'
);
select is(public.__t_affected($$update public.meal_plan_entries set status = 'cooked', servings = 5 where id = 'ea000000-0000-4000-8000-0000000000a2'$$), 1::bigint, 'a retried request that sets cooked again changes nothing else');
select is(
  (select count(*)::int from public.recipe_feedback where signal = 'cooked'),
  1,
  'setting cooked twice wrote the cooked signal once'
);
select is(public.__t_affected($$update public.meal_plan_entries set status = 'skipped' where id = 'ea000000-0000-4000-8000-0000000000a1'$$), 1::bigint, 'alice skips Thursday dinner');
select is(
  (select count(*)::int from public.recipe_feedback where user_id = 'a1111111-1111-4111-8111-111111111111' and signal = 'skipped'),
  1,
  'skipping an entry wrote one skipped signal'
);
select is(public.__t_affected($$update public.meal_plan_entries set status = 'planned' where id = 'ea000000-0000-4000-8000-0000000000a1'$$), 1::bigint, 'alice undoes the skip');
select is(
  (select count(*)::int from public.recipe_feedback where signal in ('cooked', 'skipped')),
  2,
  'undoing a status writes no signal'
);
select is(public.__t_affected($$update public.meal_plan_entries set recipe_id = 'aa000000-0000-4000-8000-000000000003' where id = 'ea000000-0000-4000-8000-0000000000a1'$$), 1::bigint, 'alice swaps Thursday dinner for another recipe');
select is(
  (select count(*)::int from public.recipe_feedback where recipe_id = 'aa000000-0000-4000-8000-000000000003' and signal = 'saved'),
  1,
  'the recipe swapped in counts as saved'
);
select throws_ok($$update public.meal_plan_entries set recipe_id = 'bb000000-0000-4000-8000-000000000001' where id = 'ea000000-0000-4000-8000-0000000000a1'$$, 'P0001', 'recipe_not_found', 'a swap to a recipe of another household is rejected');

-- Thumbs: a person writes and removes only their own like and dislike.
select lives_ok(
  $$insert into public.recipe_feedback (id, household_id, recipe_id, signal) values ('f1000000-0000-4000-8000-0000000000a3', '0a000000-0000-4000-8000-00000000000a', 'aa000000-0000-4000-8000-000000000003', 'like')$$,
  'alice thumbs a recipe up'
);
select is(
  (select user_id from public.recipe_feedback where id = 'f1000000-0000-4000-8000-0000000000a3'),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'the thumb belongs to alice (user_id defaults to the caller)'
);
select throws_ok(
  $$insert into public.recipe_feedback (household_id, user_id, recipe_id, signal) values ('0a000000-0000-4000-8000-00000000000a', 'c3333333-3333-4333-8333-333333333333', 'aa000000-0000-4000-8000-000000000003', 'dislike')$$,
  '42501', 'permission denied for table recipe_feedback',
  'alice cannot write feedback as carol'
);
select throws_ok(
  $$insert into public.recipe_feedback (household_id, recipe_id, signal) values ('0a000000-0000-4000-8000-00000000000a', 'aa000000-0000-4000-8000-000000000003', 'cooked')$$,
  '42501', 'new row violates row-level security policy for table "recipe_feedback"',
  'alice cannot write a cooked signal by hand; only the planner trigger does'
);
select throws_ok(
  $$insert into public.recipe_feedback (household_id, recipe_id, signal) values ('0b000000-0000-4000-8000-00000000000b', 'bb000000-0000-4000-8000-000000000001', 'like')$$,
  '42501', 'new row violates row-level security policy for table "recipe_feedback"',
  'alice cannot write feedback into household B'
);
select throws_ok(
  $$insert into public.recipe_feedback (household_id, recipe_id, signal) values ('0a000000-0000-4000-8000-00000000000a', 'bb000000-0000-4000-8000-000000000001', 'like')$$,
  '42501', 'new row violates row-level security policy for table "recipe_feedback"',
  'alice cannot thumb a recipe that is not her household''s'
);
select lives_ok(
  $$insert into public.recipe_feedback (id, household_id, recipe_id, signal) values ('f1000000-0000-4000-8000-0000000000a4', '0a000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-000000000001', 'like')$$,
  'alice thumbs a catalog recipe up (the onboarding calibration deck does this)'
);
select throws_ok(
  $$insert into public.recipe_feedback (household_id, recipe_id, signal) values ('0a000000-0000-4000-8000-00000000000a', 'aa000000-0000-4000-8000-000000000002', 'like')$$,
  '42501', 'new row violates row-level security policy for table "recipe_feedback"',
  'alice cannot thumb a deleted recipe, even one of her own household'
);
select throws_ok(
  $$insert into public.recipe_feedback (household_id, recipe_id, signal, rating) values ('0a000000-0000-4000-8000-00000000000a', 'aa000000-0000-4000-8000-000000000003', 'like', 6)$$,
  '23514', 'new row for relation "recipe_feedback" violates check constraint "recipe_feedback_rating_range"',
  'a rating is 1 to 5'
);
select throws_ok($$update public.recipe_feedback set signal = 'dislike' where id = 'f1000000-0000-4000-8000-0000000000a1'$$, '42501', 'permission denied for table recipe_feedback', 'feedback is append-only: no client update');
select is(public.__t_affected($$delete from public.recipe_feedback where id = 'f1000000-0000-4000-8000-0000000000a2'$$), 0::bigint, 'alice cannot delete carol''s thumb');
select is(public.__t_affected($$delete from public.recipe_feedback where id = 'f1000000-0000-4000-8000-0000000000a1'$$), 1::bigint, 'alice removes her own thumb');
select is(public.__t_affected($$delete from public.recipe_feedback where signal = 'saved' and user_id = 'a1111111-1111-4111-8111-111111111111'$$), 0::bigint, 'alice cannot delete her saved signals, only thumbs');

-- Deleting an entry.
select is(public.__t_affected($$delete from public.meal_plan_entries where id = 'ea000000-0000-4000-8000-0000000000a2'$$), 1::bigint, 'alice removes an entry of her household');

reset role;

-- ---------------------------------------------------------------------------------------
-- Carol (member of A): the same household, the same access
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}';
set local role authenticated;

select is((select count(*)::int from public.meal_plan_entries), 1, 'carol sees the household''s entries (alice''s Thursday dinner)');
select is((select why from public.meal_plan_entries where id = 'ea000000-0000-4000-8000-0000000000a1'), 'Uses the leftover lemons', 'carol reads the why on the entry alice set');
select is(public.__t_affected($$update public.meal_plan_entries set servings = 3 where id = 'ea000000-0000-4000-8000-0000000000a1'$$), 1::bigint, 'carol edits an entry alice made');
select lives_ok(
  $$insert into public.meal_plan_entries (plan_id, household_id, date, slot, recipe_id, servings)
    values ('ca000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '2026-11-06', 'breakfast', 'aa000000-0000-4000-8000-000000000003', 2)$$,
  'carol adds an entry'
);
select is(
  (select count(*)::int from public.recipe_feedback where user_id = 'c3333333-3333-4333-8333-333333333333' and signal = 'saved'),
  1,
  'the saved signal belongs to carol, who added it'
);

reset role;

-- ---------------------------------------------------------------------------------------
-- Bob (owner of B): sees only household B
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}';
set local role authenticated;

select is((select count(*)::int from public.meal_plans), 1, 'bob sees one plan');
select is((select count(*)::int from public.meal_plan_entries), 1, 'bob sees one entry');
select is_empty($$select 1 from public.meal_plan_entries where household_id = '0a000000-0000-4000-8000-00000000000a'$$, 'bob reads no entry of household A');
select is_empty($$select 1 from public.recipe_feedback where household_id = '0a000000-0000-4000-8000-00000000000a'$$, 'bob reads no feedback of household A');
select throws_ok(
  $$insert into public.meal_plan_entries (plan_id, household_id, date, slot, recipe_id, servings)
    values ('ca000000-0000-4000-8000-0000000000a1', '0b000000-0000-4000-8000-00000000000b', '2026-11-05', 'dinner', 'bb000000-0000-4000-8000-000000000001', 2)$$,
  'P0001', 'plan_not_found',
  'bob cannot add an entry to A''s plan'
);
select is(public.__t_affected($$update public.meal_plan_entries set servings = 9 where id = 'ea000000-0000-4000-8000-0000000000a1'$$), 0::bigint, 'bob updates no entry of household A');
select is(public.__t_affected($$delete from public.meal_plan_entries where household_id = '0a000000-0000-4000-8000-00000000000a'$$), 0::bigint, 'bob deletes no entry of household A');
select throws_ok(
  $$insert into public.meal_plans (household_id, week_start) values ('0a000000-0000-4000-8000-00000000000a', '2026-11-16')$$,
  '42501', 'new row violates row-level security policy for table "meal_plans"',
  'bob cannot create a plan in household A'
);
select is(public.__t_affected($$delete from public.recipe_feedback where household_id = '0a000000-0000-4000-8000-00000000000a'$$), 0::bigint, 'bob deletes no feedback of household A');

reset role;

-- ---------------------------------------------------------------------------------------
-- Dave (no household): nothing at all
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "d4444444-4444-4444-8444-444444444444", "role": "authenticated"}';
set local role authenticated;

select is((select count(*)::int from public.meal_plans), 0, 'a user with no household sees no plans');
select is((select count(*)::int from public.meal_plan_entries), 0, 'a user with no household sees no entries');
select is((select count(*)::int from public.recipe_feedback), 0, 'a user with no household sees no feedback');
select throws_ok(
  $$insert into public.meal_plans (household_id, week_start) values ('0a000000-0000-4000-8000-00000000000a', '2026-11-23')$$,
  '42501', 'new row violates row-level security policy for table "meal_plans"',
  'a user with no household cannot create plans anywhere'
);

reset role;

-- ---------------------------------------------------------------------------------------
-- The service role (suggest, WS06): writes drafts, and a draft is not a person's save
-- ---------------------------------------------------------------------------------------
-- A real service-role request carries a JWT with no `sub`, so auth.uid() is null. Setting the
-- claims matters: they outlive `reset role` for the rest of the transaction.

set local request.jwt.claims = '{"role": "service_role"}';
set local role service_role;

select lives_ok(
  $$insert into public.meal_plan_entries (plan_id, household_id, date, slot, recipe_id, servings, why)
    values ('ca000000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-00000000000a', '2026-11-10', 'dinner', 'aa000000-0000-4000-8000-000000000003', 4, 'Fits a busy Tuesday')$$,
  'the service role drafts an entry with a why'
);
select is(
  (select why from public.meal_plan_entries where plan_id = 'ca000000-0000-4000-8000-0000000000a2' and date = '2026-11-10'),
  'Fits a busy Tuesday',
  'the draft keeps the reason suggest gave'
);
select is(
  (select count(*)::int from public.recipe_feedback where recipe_id = 'aa000000-0000-4000-8000-000000000003' and signal = 'saved'),
  2,
  'the draft wrote no saved signal (only alice''s swap and carol''s add did)'
);
select throws_ok(
  $$insert into public.meal_plan_entries (plan_id, household_id, date, slot, recipe_id, servings)
    values ('ca000000-0000-4000-8000-0000000000a2', '0b000000-0000-4000-8000-00000000000b', '2026-11-11', 'dinner', 'bb000000-0000-4000-8000-000000000001', 4)$$,
  'P0001', 'recipe_not_found',
  'even the service role cannot cross households: the trigger takes A from the plan and B''s recipe is not A''s'
);

reset role;

select * from finish();

rollback;
