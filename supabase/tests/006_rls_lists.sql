-- WS05: pgTAP tests for grocery_lists, grocery_list_items, pantry_items, their triggers, and the
-- Realtime publication. Run with `supabase test db`. Everything happens inside one transaction
-- that is rolled back. Counts are scoped to the fixtures below: `db reset` loads the ontology and
-- the starter catalog, so nothing here counts a whole table.
--
-- What it proves:
--   * a member of household A reads nothing of household B in any of the three tables
--   * a member cannot add items to, edit, or delete from B's list, and cannot forge a household
--   * clients add only manual items and delete only manual items; automatic ones are list-build's
--   * checked_by must equal auth.uid() on update; the trigger stamps it, and a toggle older than
--     the one on the row is dropped (last writer wins by checked_at)
--   * the grants are column-level, so a later migration cannot widen them silently
--   * the pantry is an upsert per household and ingredient with a closed status vocabulary
--   * both list tables are in the Realtime publication, and item deletes can be filtered
--   * the service role can write lists but cannot run DDL
--
-- Cast of characters (fixed ids, so the SQL below stays readable):
--   alice  owns household A       carol  is a plain member of A
--   bob    owns household B       dave   belongs to no household

begin;

select plan(98);

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

-- Two ontology rows with names the seed will never use.
insert into public.ingredients (id, name, category, default_unit) values
  ('f1000000-0000-4000-8000-000000000001', 'zz test onion', 'produce', 'each'),
  ('f1000000-0000-4000-8000-000000000002', 'zz test salt', 'spices', 'tsp');

-- Week of Monday 2026-11-02 in both households.
insert into public.meal_plans (id, household_id, week_start) values
  ('ca000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '2026-11-02'),
  ('cb000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b', '2026-11-02');

-- One list per household. LA holds an automatic item (checked), an automatic item (unchecked) and a
-- manual item; LB holds one automatic item.
insert into public.grocery_lists (id, household_id, plan_id, name, status, built_at, plan_version) values
  ('1a000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', 'ca000000-0000-4000-8000-0000000000a1', 'Week of Nov 2', 'active', now(), 1),
  ('1b000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b', 'cb000000-0000-4000-8000-0000000000b1', 'Week of Nov 2', 'active', now(), 1);

insert into public.grocery_list_items (id, list_id, household_id, ingredient_id, display_name, qty, unit, section, position, checked, checked_by, checked_at, is_manual) values
  ('ea100000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-000000000001', 'Zz test onion', 3, 'each', 'produce', 0, true, 'c3333333-3333-4333-8333-333333333333', now() - interval '3 hours', false),
  ('ea100000-0000-4000-8000-000000000002', '1a000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-000000000002', 'Zz test salt', 1, 'package', 'spices', 1, false, null, null, false),
  ('ea100000-0000-4000-8000-000000000003', '1a000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', null, 'Paper towels', 2, null, 'household', 2, false, null, null, true),
  ('eb100000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b', 'f1000000-0000-4000-8000-000000000001', 'Zz test onion', 1, 'each', 'produce', 0, false, null, null, false);

insert into public.pantry_items (household_id, ingredient_id, status) values
  ('0a000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-000000000002', 'have'),
  ('0b000000-0000-4000-8000-00000000000b', 'f1000000-0000-4000-8000-000000000001', 'low');

-- ---------------------------------------------------------------------------------------
-- Shape: RLS on, the reviewed policy set, column-level grants, constraints, Realtime
-- ---------------------------------------------------------------------------------------

select ok((select relrowsecurity from pg_class where oid = 'public.grocery_lists'::regclass), 'grocery_lists has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.grocery_list_items'::regclass), 'grocery_list_items has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.pantry_items'::regclass), 'pantry_items has RLS enabled');

select policies_are('public', 'grocery_lists', array['grocery_lists: members read', 'grocery_lists: members update'], 'grocery_lists has exactly the reviewed policies (no insert or delete policy)');
select policies_are('public', 'grocery_list_items', array['grocery_list_items: members read', 'grocery_list_items: members insert manual', 'grocery_list_items: members update', 'grocery_list_items: members delete manual'], 'grocery_list_items has exactly the reviewed policies');
select policies_are('public', 'pantry_items', array['pantry_items: members read', 'pantry_items: members insert', 'pantry_items: members update', 'pantry_items: members delete'], 'pantry_items has exactly the reviewed policies');

-- Grants. Column-level, so a later migration that adds a column has to grant it on purpose.
select ok(
  (select bool_and(has_column_privilege('authenticated', 'public.grocery_list_items', c, 'UPDATE'))
   from unnest(array['display_name', 'qty', 'unit', 'section', 'position', 'edited', 'excluded_reason', 'checked', 'checked_by', 'checked_at']) c),
  'clients may update the amount, section, edited flag, exclusion, and check state of an item'
);
select ok(
  not (select bool_or(has_column_privilege('authenticated', 'public.grocery_list_items', c, 'UPDATE'))
       from unnest(array['id', 'list_id', 'household_id', 'ingredient_id', 'source_entry_ids', 'needs_attention', 'is_manual', 'qualifiers', 'detail', 'created_at', 'updated_at']) c),
  'clients may not update the ids, the automatic columns, or the timestamps of an item'
);
select ok(
  (select bool_and(has_column_privilege('authenticated', 'public.grocery_list_items', c, 'INSERT'))
   from unnest(array['id', 'list_id', 'household_id', 'display_name', 'qty', 'unit', 'section', 'position', 'is_manual']) c)
  and not (select bool_or(has_column_privilege('authenticated', 'public.grocery_list_items', c, 'INSERT'))
           from unnest(array['ingredient_id', 'source_entry_ids', 'checked', 'checked_by', 'checked_at', 'excluded_reason', 'needs_attention', 'qualifiers', 'edited', 'detail', 'created_at', 'updated_at']) c),
  'clients insert the nine manual-item columns and nothing list-build owns'
);
select ok(
  (select bool_and(has_column_privilege('authenticated', 'public.grocery_lists', c, 'UPDATE'))
   from unnest(array['name', 'status', 'section_order', 'deleted_at']) c)
  and not (select bool_or(has_column_privilege('authenticated', 'public.grocery_lists', c, 'UPDATE'))
           from unnest(array['id', 'household_id', 'plan_id', 'built_at', 'plan_version', 'plan_fingerprint', 'created_at', 'updated_at']) c)
  and not has_table_privilege('authenticated', 'public.grocery_lists', 'INSERT')
  and not has_table_privilege('authenticated', 'public.grocery_lists', 'DELETE'),
  'clients rename a list, mark it shopped, order its aisles and soft delete it; list-build owns the rest'
);
select ok(
  (select bool_and(has_column_privilege('authenticated', 'public.pantry_items', c, 'INSERT'))
   from unnest(array['household_id', 'ingredient_id', 'status']) c)
  and has_column_privilege('authenticated', 'public.pantry_items', 'status', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.pantry_items', 'ingredient_id', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.pantry_items', 'household_id', 'UPDATE'),
  'clients upsert a pantry row and change only its status'
);
select ok(
  not exists (
    select 1
    from unnest(array['grocery_lists', 'grocery_list_items', 'pantry_items']) t
    where has_table_privilege('anon', 'public.' || t, 'SELECT')
       or has_table_privilege('anon', 'public.' || t, 'INSERT')
       or has_table_privilege('anon', 'public.' || t, 'UPDATE')
       or has_table_privilege('anon', 'public.' || t, 'DELETE')
  ),
  'anon has no privilege on any list table'
);

-- Constraints that hold even for a writer that skips the app (checked as postgres).
select throws_ok(
  $$insert into public.grocery_lists (household_id, plan_id, name) values ('0a000000-0000-4000-8000-00000000000a', 'ca000000-0000-4000-8000-0000000000a1', 'A second live list')$$,
  '23505', 'duplicate key value violates unique constraint "grocery_lists_plan_live_key"',
  'a plan has one live list'
);
select lives_ok(
  $$update public.grocery_lists set deleted_at = now() where id = '1a000000-0000-4000-8000-0000000000a1';
    insert into public.grocery_lists (id, household_id, plan_id, name) values ('1a000000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-00000000000a', 'ca000000-0000-4000-8000-0000000000a1', 'A rebuilt list');
    delete from public.grocery_lists where id = '1a000000-0000-4000-8000-0000000000a2';
    update public.grocery_lists set deleted_at = null where id = '1a000000-0000-4000-8000-0000000000a1'$$,
  'a soft-deleted list frees its plan for a new live one'
);
select throws_ok(
  $$insert into public.grocery_lists (household_id, plan_id, name) values ('0a000000-0000-4000-8000-00000000000a', 'cb000000-0000-4000-8000-0000000000b1', 'Wrong plan')$$,
  'P0001', 'plan_not_found',
  'a list cannot point at another household''s plan'
);
select throws_ok(
  $$insert into public.grocery_lists (household_id, name) values ('0a000000-0000-4000-8000-00000000000a', '   ')$$,
  '23514', 'new row for relation "grocery_lists" violates check constraint "grocery_lists_name_length"',
  'a list needs a name'
);
select throws_ok(
  $$insert into public.grocery_list_items (list_id, household_id, display_name, qty, is_manual) values ('1a000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', 'Negative', -1, true)$$,
  '23514', 'new row for relation "grocery_list_items" violates check constraint "grocery_list_items_qty_range"',
  'a quantity cannot be negative'
);
select throws_ok(
  $$insert into public.grocery_list_items (list_id, household_id, display_name, is_manual) values ('1a000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '  ', true)$$,
  '23514', 'new row for relation "grocery_list_items" violates check constraint "grocery_list_items_name_length"',
  'an item needs a name'
);
select throws_ok(
  $$insert into public.grocery_list_items (list_id, household_id, display_name, detail) values ('1a000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', 'Bad detail', '[]')$$,
  '23514', 'new row for relation "grocery_list_items" violates check constraint "grocery_list_items_detail_object"',
  'detail is a json object'
);
select throws_ok(
  $$insert into public.pantry_items (household_id, ingredient_id, status) values ('0a000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-000000000001', 'maybe')$$,
  '22P02', 'invalid input value for enum pantry_items_status: "maybe"',
  'the pantry status vocabulary is closed'
);

-- Realtime: both list tables publish, and the items table logs the full old row so a delete can be
-- filtered by list_id or household_id.
select is(
  (select count(*)::int from pg_publication_tables
   where pubname = 'supabase_realtime' and schemaname = 'public'
     and tablename in ('grocery_lists', 'grocery_list_items')),
  2,
  'grocery_lists and grocery_list_items are in the supabase_realtime publication'
);
select is(
  (select relreplident::text from pg_class where oid = 'public.grocery_list_items'::regclass),
  'f',
  'grocery_list_items logs the full old row, so Realtime can filter deletes'
);

-- ---------------------------------------------------------------------------------------
-- Signed out (anon) gets nothing
-- ---------------------------------------------------------------------------------------

set local role anon;

select throws_ok($$select count(*) from public.grocery_lists$$, '42501', 'permission denied for table grocery_lists', 'anon cannot read grocery_lists');
select throws_ok($$select count(*) from public.grocery_list_items$$, '42501', 'permission denied for table grocery_list_items', 'anon cannot read grocery_list_items');
select throws_ok($$select count(*) from public.pantry_items$$, '42501', 'permission denied for table pantry_items', 'anon cannot read pantry_items');

reset role;

-- ---------------------------------------------------------------------------------------
-- Dave (no household) sees and changes nothing
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "d4444444-4444-4444-8444-444444444444", "role": "authenticated"}';
set local role authenticated;

select is((select count(*)::int from public.grocery_lists), 0, 'dave sees no list');
select is((select count(*)::int from public.grocery_list_items), 0, 'dave sees no list item');
select is((select count(*)::int from public.pantry_items), 0, 'dave sees no pantry row');
select throws_ok(
  $$insert into public.grocery_list_items (list_id, household_id, display_name, is_manual) values ('1a000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', 'Dave was here', true)$$,
  'P0001', 'list_not_found',
  'dave cannot add an item to a list he cannot see'
);
select throws_ok(
  $$insert into public.pantry_items (household_id, ingredient_id, status) values ('0a000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-000000000001', 'have')$$,
  '42501', 'new row violates row-level security policy for table "pantry_items"',
  'dave cannot write a pantry row into household A'
);

reset role;

-- ---------------------------------------------------------------------------------------
-- Alice (owner of A): reads only household A
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;

select is((select count(*)::int from public.grocery_lists), 1, 'alice sees the one list of household A');
select is((select count(*)::int from public.grocery_list_items), 3, 'alice sees the three items of household A');
select is((select count(*)::int from public.pantry_items), 1, 'alice sees the one pantry row of household A');
select is_empty($$select 1 from public.grocery_lists where household_id = '0b000000-0000-4000-8000-00000000000b'$$, 'alice reads no list of household B');
select is_empty($$select 1 from public.grocery_list_items where id = 'eb100000-0000-4000-8000-000000000001'$$, 'alice cannot fetch an item of B by id');
select is_empty($$select 1 from public.grocery_list_items where list_id = '1b000000-0000-4000-8000-0000000000b1'$$, 'alice cannot list the items of B''s list');
select is_empty($$select 1 from public.pantry_items where household_id = '0b000000-0000-4000-8000-00000000000b'$$, 'alice reads no pantry row of household B');

-- Another household's list: nothing to add, change, or remove.
select throws_ok(
  $$insert into public.grocery_list_items (list_id, household_id, display_name, is_manual) values ('1b000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b', 'Alice was here', true)$$,
  'P0001', 'list_not_found',
  'alice cannot add an item to household B''s list (she cannot even see it)'
);
select is(public.__t_affected($$update public.grocery_list_items set qty = 99 where id = 'eb100000-0000-4000-8000-000000000001'$$), 0::bigint, 'alice cannot update an item of B');
select is(public.__t_affected($$update public.grocery_list_items set checked = true where list_id = '1b000000-0000-4000-8000-0000000000b1'$$), 0::bigint, 'alice cannot check off an item of B');
select is(public.__t_affected($$delete from public.grocery_list_items where id = 'eb100000-0000-4000-8000-000000000001'$$), 0::bigint, 'alice cannot delete an item of B');
select is(public.__t_affected($$update public.grocery_lists set name = 'Mine now' where id = '1b000000-0000-4000-8000-0000000000b1'$$), 0::bigint, 'alice cannot rename B''s list');
select is(public.__t_affected($$update public.pantry_items set status = 'out' where household_id = '0b000000-0000-4000-8000-00000000000b'$$), 0::bigint, 'alice cannot change B''s pantry');
select is(public.__t_affected($$delete from public.pantry_items where household_id = '0b000000-0000-4000-8000-00000000000b'$$), 0::bigint, 'alice cannot delete B''s pantry rows');
select throws_ok(
  $$insert into public.pantry_items (household_id, ingredient_id, status) values ('0b000000-0000-4000-8000-00000000000b', 'f1000000-0000-4000-8000-000000000002', 'have')$$,
  '42501', 'new row violates row-level security policy for table "pantry_items"',
  'alice cannot write a pantry row into household B'
);

-- Lists: members rename and mark shopped, nothing else.
select lives_ok($$update public.grocery_lists set name = 'Our week', status = 'shopped' where id = '1a000000-0000-4000-8000-0000000000a1'$$, 'alice renames the list and marks it shopped');
select throws_ok($$update public.grocery_lists set plan_version = 9 where id = '1a000000-0000-4000-8000-0000000000a1'$$, '42501', 'permission denied for table grocery_lists', 'clients cannot change plan_version');
select throws_ok($$update public.grocery_lists set household_id = '0b000000-0000-4000-8000-00000000000b' where id = '1a000000-0000-4000-8000-0000000000a1'$$, '42501', 'permission denied for table grocery_lists', 'clients cannot move a list to another household');
select throws_ok($$insert into public.grocery_lists (household_id, name) values ('0a000000-0000-4000-8000-00000000000a', 'My own list')$$, '42501', 'permission denied for table grocery_lists', 'clients cannot create a list');
select throws_ok($$delete from public.grocery_lists where id = '1a000000-0000-4000-8000-0000000000a1'$$, '42501', 'permission denied for table grocery_lists', 'clients cannot hard delete a list');

-- Items: manual ones are the client's own.
select lives_ok(
  $$insert into public.grocery_list_items (id, list_id, household_id, display_name, qty, unit, section, position, is_manual)
    values ('ea100000-0000-4000-8000-000000000004', '1a000000-0000-4000-8000-0000000000a1', '0b000000-0000-4000-8000-00000000000b', 'Birthday candles', 1, 'box', 'household', 3, true)$$,
  'alice adds a manual item (even with a forged household_id in the payload)'
);
select is(
  (select household_id from public.grocery_list_items where id = 'ea100000-0000-4000-8000-000000000004'),
  '0a000000-0000-4000-8000-00000000000a'::uuid,
  'the item took its household from the list, not from the payload'
);
select is(
  (select checked::text || ':' || edited::text || ':' || needs_attention::text from public.grocery_list_items where id = 'ea100000-0000-4000-8000-000000000004'),
  'false:false:false',
  'a new manual item is unchecked, unedited, and needs no attention'
);
select lives_ok(
  $$insert into public.grocery_list_items (id, list_id, household_id, display_name, is_manual)
    values ('ea100000-0000-4000-8000-000000000004', '1a000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', 'Birthday candles', true)
    on conflict (id) do nothing$$,
  'a replayed add with the same id changes nothing, so the offline queue cannot duplicate it'
);
select is(
  (select count(*)::int from public.grocery_list_items where list_id = '1a000000-0000-4000-8000-0000000000a1' and display_name = 'Birthday candles'),
  1,
  'there is one Birthday candles item after the replay'
);
select throws_ok(
  $$insert into public.grocery_list_items (list_id, household_id, display_name, is_manual) values ('1a000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', 'Forged automatic item', false)$$,
  '42501', 'new row violates row-level security policy for table "grocery_list_items"',
  'a client cannot add an automatic item'
);
select throws_ok(
  $$insert into public.grocery_list_items (list_id, household_id, display_name, is_manual, needs_attention) values ('1a000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', 'Flagged', true, true)$$,
  '42501', 'permission denied for table grocery_list_items',
  'a client cannot set the columns list-build owns when it adds an item'
);
select throws_ok(
  $$update public.grocery_list_items set is_manual = true where id = 'ea100000-0000-4000-8000-000000000001'$$,
  '42501', 'permission denied for table grocery_list_items',
  'a client cannot turn an automatic item into a manual one'
);
select throws_ok(
  $$update public.grocery_list_items set list_id = '1b000000-0000-4000-8000-0000000000b1' where id = 'ea100000-0000-4000-8000-000000000002'$$,
  '42501', 'permission denied for table grocery_list_items',
  'a client cannot move an item to another list'
);
select throws_ok(
  $$update public.grocery_list_items set detail = '{}' where id = 'ea100000-0000-4000-8000-000000000002'$$,
  '42501', 'permission denied for table grocery_list_items',
  'a client cannot rewrite the Why this amount data'
);
select is(public.__t_affected($$delete from public.grocery_list_items where id = 'ea100000-0000-4000-8000-000000000002'$$), 0::bigint, 'a client cannot delete an automatic item');
select is(public.__t_affected($$delete from public.grocery_list_items where id = 'ea100000-0000-4000-8000-000000000004'$$), 1::bigint, 'a client deletes a manual item');

-- Editing an amount marks the item edited, and taking an item off the list is an exclusion.
select lives_ok(
  $$update public.grocery_list_items set qty = 4, unit = 'bag', section = 'produce', edited = true where id = 'ea100000-0000-4000-8000-000000000001'$$,
  'alice edits the amount, unit and section of an automatic item'
);
select is(
  (select checked_by from public.grocery_list_items where id = 'ea100000-0000-4000-8000-000000000001'),
  'c3333333-3333-4333-8333-333333333333'::uuid,
  'editing the amount leaves the last check-off alone (checked_by is still carol)'
);
select lives_ok(
  $$update public.grocery_list_items set excluded_reason = 'manual' where id = 'ea100000-0000-4000-8000-000000000002'$$,
  'alice takes an automatic item off the list'
);
select lives_ok(
  $$update public.grocery_list_items set excluded_reason = null where id = 'ea100000-0000-4000-8000-000000000002'$$,
  'and puts it back'
);

-- Check-off. The item starts checked by carol three hours ago.
select lives_ok(
  $$update public.grocery_list_items set checked = false, checked_by = 'a1111111-1111-4111-8111-111111111111', checked_at = now() - interval '2 hours' where id = 'ea100000-0000-4000-8000-000000000001'$$,
  'alice unchecks the item, sending her own id as checked_by'
);
select is(
  (select checked::text || ':' || checked_by::text from public.grocery_list_items where id = 'ea100000-0000-4000-8000-000000000001'),
  'false:a1111111-1111-4111-8111-111111111111',
  'checked_by is alice after her toggle'
);
select throws_ok(
  $$update public.grocery_list_items set checked = true, checked_by = 'c3333333-3333-4333-8333-333333333333', checked_at = now() - interval '1 hour' where id = 'ea100000-0000-4000-8000-000000000001'$$,
  '42501', 'checked_by_mismatch',
  'checked_by must equal auth.uid(): alice cannot check an item as carol'
);
select lives_ok(
  $$update public.grocery_list_items set checked = true, checked_at = now() - interval '1 hour' where id = 'ea100000-0000-4000-8000-000000000001'$$,
  'alice checks the item without sending checked_by'
);
select is(
  (select checked::text || ':' || checked_by::text from public.grocery_list_items where id = 'ea100000-0000-4000-8000-000000000001'),
  'true:a1111111-1111-4111-8111-111111111111',
  'the trigger stamps checked_by with auth.uid()'
);
select lives_ok(
  $$update public.grocery_list_items set checked = false, checked_by = 'a1111111-1111-4111-8111-111111111111', checked_at = now() - interval '90 minutes' where id = 'ea100000-0000-4000-8000-000000000001'$$,
  'a toggle made earlier than the one on the row is accepted without an error'
);
select ok(
  (select checked and checked_at = now() - interval '1 hour' from public.grocery_list_items where id = 'ea100000-0000-4000-8000-000000000001'),
  'last writer wins: the older toggle was dropped and the check-off from an hour ago stands'
);
select lives_ok(
  $$update public.grocery_list_items set checked = true, checked_by = 'a1111111-1111-4111-8111-111111111111', checked_at = now() + interval '2 days' where id = 'ea100000-0000-4000-8000-000000000002'$$,
  'a phone with its clock two days ahead checks an item'
);
select ok(
  (select checked_at <= now() + interval '6 minutes' from public.grocery_list_items where id = 'ea100000-0000-4000-8000-000000000002'),
  'checked_at is capped a few minutes past the server clock'
);
select lives_ok(
  $$update public.grocery_list_items set checked = false, checked_by = 'a1111111-1111-4111-8111-111111111111' where id = 'ea100000-0000-4000-8000-000000000003'$$,
  'a toggle with no checked_at is stamped with the server time'
);
select ok(
  (select checked_at is not null and checked_at <= now() + interval '1 minute' from public.grocery_list_items where id = 'ea100000-0000-4000-8000-000000000003'),
  'checked_at was filled in by the server'
);

-- Pantry: an upsert per household and ingredient, closed vocabulary, delete returns to default.
select lives_ok(
  $$insert into public.pantry_items (household_id, ingredient_id, status) values ('0a000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-000000000001', 'low')
    on conflict (household_id, ingredient_id) do update set status = excluded.status$$,
  'alice marks an ingredient low'
);
select lives_ok(
  $$insert into public.pantry_items (household_id, ingredient_id, status) values ('0a000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-000000000001', 'out')
    on conflict (household_id, ingredient_id) do update set status = excluded.status$$,
  'and then out, with the same upsert'
);
select is(
  (select status::text from public.pantry_items where household_id = '0a000000-0000-4000-8000-00000000000a' and ingredient_id = 'f1000000-0000-4000-8000-000000000001'),
  'out',
  'the second upsert changed the one row'
);
select is(
  (select count(*)::int from public.pantry_items where household_id = '0a000000-0000-4000-8000-00000000000a'),
  2,
  'household A has two pantry rows now'
);
select throws_ok(
  $$update public.pantry_items set ingredient_id = 'f1000000-0000-4000-8000-000000000002' where household_id = '0a000000-0000-4000-8000-00000000000a' and ingredient_id = 'f1000000-0000-4000-8000-000000000001'$$,
  '42501', 'permission denied for table pantry_items',
  'a pantry row cannot be re-pointed at another ingredient'
);
select is(public.__t_affected($$delete from public.pantry_items where household_id = '0a000000-0000-4000-8000-00000000000a' and ingredient_id = 'f1000000-0000-4000-8000-000000000001'$$), 1::bigint, 'alice deletes a pantry row to go back to the default');

reset role;

-- ---------------------------------------------------------------------------------------
-- Carol (plain member of A): shares the list, and her toggle is newer than alice's
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}';
set local role authenticated;

select is((select count(*)::int from public.grocery_list_items), 3, 'carol sees the same three items alice does (the manual candles are gone)');
select is((select name from public.grocery_lists), 'Our week', 'carol sees the new list name');
select lives_ok(
  $$update public.grocery_list_items set checked = false, checked_at = now() - interval '30 minutes' where id = 'ea100000-0000-4000-8000-000000000001'$$,
  'carol unchecks the item later in the day'
);
select is(
  (select checked::text || ':' || checked_by::text from public.grocery_list_items where id = 'ea100000-0000-4000-8000-000000000001'),
  'false:c3333333-3333-4333-8333-333333333333',
  'her newer toggle wins and checked_by is carol'
);
select throws_ok(
  $$update public.grocery_list_items set checked = true, checked_by = 'a1111111-1111-4111-8111-111111111111', checked_at = now() - interval '10 minutes' where id = 'ea100000-0000-4000-8000-000000000001'$$,
  '42501', 'checked_by_mismatch',
  'carol cannot check an item as alice either'
);

reset role;

-- ---------------------------------------------------------------------------------------
-- Bob (owner of B): reads only household B
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}';
set local role authenticated;

select is((select count(*)::int from public.grocery_lists), 1, 'bob sees the one list of household B');
select is((select count(*)::int from public.grocery_list_items), 1, 'bob sees the one item of household B');
select is((select count(*)::int from public.pantry_items), 1, 'bob sees the one pantry row of household B');
select is_empty($$select 1 from public.grocery_list_items where list_id = '1a000000-0000-4000-8000-0000000000a1'$$, 'bob reads no item of household A');

reset role;

-- ---------------------------------------------------------------------------------------
-- The service role (list-build): writes lists, is not held to the check-off rules, cannot run DDL
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"role": "service_role"}';
set local role service_role;

select lives_ok(
  $$insert into public.grocery_lists (id, household_id, plan_id, name, status, built_at, plan_version, plan_fingerprint, section_order)
    values ('1a000000-0000-4000-8000-0000000000a3', '0a000000-0000-4000-8000-00000000000a', null, 'Ad hoc', 'draft', now(), 0, null, array['meat', 'produce'])$$,
  'the service role creates a list'
);
select throws_ok(
  $$insert into public.grocery_lists (household_id, plan_id, name) values ('0a000000-0000-4000-8000-00000000000a', 'cb000000-0000-4000-8000-0000000000b1', 'Crossed plan')$$,
  'P0001', 'plan_not_found',
  'not even the service role can point a list at another household''s plan'
);
select lives_ok(
  $$insert into public.grocery_list_items (list_id, household_id, ingredient_id, display_name, qty, unit, source_entry_ids, section, qualifiers, detail, needs_attention)
    values ('1a000000-0000-4000-8000-0000000000a3', '0a000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-000000000001', 'Zz test onion (gluten-free)', 2, 'each', array['e0000000-0000-4000-8000-000000000001']::uuid[], 'produce', array['gluten-free'], '{"contributions": []}', true)$$,
  'the service role writes an automatic item with qualifiers and detail'
);
select lives_ok(
  $$update public.grocery_list_items set checked = true where list_id = '1a000000-0000-4000-8000-0000000000a3'$$,
  'the service role changes a check state without an auth.uid() (list-build never does, but it is not blocked)'
);
select throws_ok(
  $$create table public.zz_ddl_probe (id int)$$,
  '42501', null,
  'the service role cannot create a table: list-build runs as it so it loses DDL'
);
select throws_ok(
  $$drop table public.grocery_lists cascade$$,
  '42501', 'must be owner of table grocery_lists',
  'the service role cannot drop a table either'
);

reset role;

select * from finish();

rollback;
