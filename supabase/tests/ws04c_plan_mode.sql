-- WS04 follow-up (simple mode): pgTAP tests for households.plan_mode, the column the planner's
-- "Just dinners / Every meal" setting writes. Run with `supabase test db`. Everything happens inside
-- one transaction that is rolled back, and every fixture is created here.
--
-- The migration (20261031120000_households_plan_mode.sql) added the column and granted clients
-- update on it, relying on the existing "households: owners update" policy to decide who may write
-- it. This file is the regression test for that reliance.
--
-- What it proves:
--   * a member's update of plan_mode touches zero rows, and so does an outsider's, in any shape
--   * an owner's update touches one row and takes effect, both ways
--   * the update grant on plan_mode did not open created_by, alone or in the same statement
--   * a value outside the enum, and a null, are refused
--   * the column is not null, defaults to simple, and the policy set did not grow
--
-- Cast of characters (fixed ids, so the SQL below stays readable):
--   olive  owns household P          max     is a plain member of P
--   xena   owns household Q, and belongs to nothing of P (the outsider)

begin;

select plan(28);

-- ---------------------------------------------------------------------------------------
-- Fixtures (as the postgres role, which bypasses RLS)
-- ---------------------------------------------------------------------------------------

-- Test helper: how many rows a statement touched. RLS hides rows from UPDATE rather than raising,
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
  ('0e000000-0000-4000-8000-0000000000e1', 'olive@example.test', '{}'),
  ('0e000000-0000-4000-8000-0000000000e2', 'max@example.test', '{}'),
  ('0e000000-0000-4000-8000-0000000000e3', 'xena@example.test', '{}');

-- No plan_mode in the insert: the default is part of what is tested.
insert into public.households (id, name, created_by) values
  ('0f000000-0000-4000-8000-0000000000f1', 'Olive House', '0e000000-0000-4000-8000-0000000000e1'),
  ('0f000000-0000-4000-8000-0000000000f2', 'Xena House', '0e000000-0000-4000-8000-0000000000e3');

insert into public.household_members (household_id, user_id, role) values
  ('0f000000-0000-4000-8000-0000000000f1', '0e000000-0000-4000-8000-0000000000e1', 'owner'),
  ('0f000000-0000-4000-8000-0000000000f1', '0e000000-0000-4000-8000-0000000000e2', 'member'),
  ('0f000000-0000-4000-8000-0000000000f2', '0e000000-0000-4000-8000-0000000000e3', 'owner');

-- ---------------------------------------------------------------------------------------
-- Shape: the column, its default, its grants, and the unchanged policy set
-- ---------------------------------------------------------------------------------------

select is((select udt_name::text from information_schema.columns where table_schema = 'public' and table_name = 'households' and column_name = 'plan_mode'), 'households_plan_mode', 'plan_mode is the households_plan_mode enum');
select ok((select attnotnull from pg_attribute where attrelid = 'public.households'::regclass and attname = 'plan_mode'), 'plan_mode is not null');
select is((select plan_mode::text from public.households where id = '0f000000-0000-4000-8000-0000000000f1'), 'simple', 'a household created without a mode starts on simple');
select is((select array_agg(enumlabel::text order by enumsortorder)::text from pg_enum where enumtypid = 'public.households_plan_mode'::regtype), '{simple,full}', 'the two modes are simple and full');
select policies_are('public', 'households', array['households: members read', 'households: owners update'], 'households still has exactly the reviewed policies');
select ok(has_column_privilege('authenticated', 'public.households', 'plan_mode', 'update'), 'signed-in users hold update on plan_mode (the policy decides which rows)');
select ok(not has_column_privilege('authenticated', 'public.households', 'created_by', 'update'), 'signed-in users do not hold update on created_by');
select ok(not has_column_privilege('anon', 'public.households', 'plan_mode', 'update'), 'signed-out users do not hold update on plan_mode');

-- ---------------------------------------------------------------------------------------
-- Signed out
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"role": "anon"}';
set local role anon;

select throws_ok($$update public.households set plan_mode = 'full' where id = '0f000000-0000-4000-8000-0000000000f1'$$, '42501', 'permission denied for table households', 'a signed-out user cannot update plan_mode');

reset role;

-- ---------------------------------------------------------------------------------------
-- Max, a member of P: reads the mode, cannot change it
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "0e000000-0000-4000-8000-0000000000e2", "role": "authenticated"}';
set local role authenticated;

select is((select plan_mode::text from public.households where id = '0f000000-0000-4000-8000-0000000000f1'), 'simple', 'a member can read the household''s mode');
select is(public.__t_affected($$update public.households set plan_mode = 'full' where id = '0f000000-0000-4000-8000-0000000000f1'$$), 0::bigint, 'a member''s update of plan_mode affects zero rows');
select is(public.__t_affected($$update public.households set plan_mode = 'full'$$), 0::bigint, 'a member''s update with no where clause affects zero rows');
select is((select plan_mode::text from public.households where id = '0f000000-0000-4000-8000-0000000000f1'), 'simple', 'the mode is still simple after the member tried');

reset role;

-- ---------------------------------------------------------------------------------------
-- Xena, owner of Q and an outsider to P: owns a household, not this one
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "0e000000-0000-4000-8000-0000000000e3", "role": "authenticated"}';
set local role authenticated;

select is_empty($$select 1 from public.households where id = '0f000000-0000-4000-8000-0000000000f1'$$, 'an outsider cannot read the household at all');
select is(public.__t_affected($$update public.households set plan_mode = 'full' where id = '0f000000-0000-4000-8000-0000000000f1'$$), 0::bigint, 'an outsider''s update of plan_mode affects zero rows');
-- Control: the same statement shape on her own household works, so the zero above is the policy
-- and not a broken statement.
select is(public.__t_affected($$update public.households set plan_mode = 'full' where id = '0f000000-0000-4000-8000-0000000000f2'$$), 1::bigint, 'the same update on her own household affects one row');

reset role;

select is((select plan_mode::text from public.households where id = '0f000000-0000-4000-8000-0000000000f1'), 'simple', 'neither the member nor the outsider changed the mode of P');

-- ---------------------------------------------------------------------------------------
-- Olive, owner of P: can change the mode, and nothing the grant did not give her
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "0e000000-0000-4000-8000-0000000000e1", "role": "authenticated"}';
set local role authenticated;

select is(public.__t_affected($$update public.households set plan_mode = 'full' where id = '0f000000-0000-4000-8000-0000000000f1'$$), 1::bigint, 'an owner''s update of plan_mode affects one row');
select is((select plan_mode::text from public.households where id = '0f000000-0000-4000-8000-0000000000f1'), 'full', 'the owner''s change took effect');
select is(public.__t_affected($$update public.households set plan_mode = 'simple' where id = '0f000000-0000-4000-8000-0000000000f1'$$), 1::bigint, 'an owner can switch back');
select is((select plan_mode::text from public.households where id = '0f000000-0000-4000-8000-0000000000f1'), 'simple', 'the switch back took effect');

-- The update grant on plan_mode must not have opened created_by, in either statement shape.
select throws_ok($$update public.households set created_by = '0e000000-0000-4000-8000-0000000000e2' where id = '0f000000-0000-4000-8000-0000000000f1'$$, '42501', 'permission denied for table households', 'an owner cannot change created_by on its own');
select throws_ok($$update public.households set plan_mode = 'full', created_by = '0e000000-0000-4000-8000-0000000000e2' where id = '0f000000-0000-4000-8000-0000000000f1'$$, '42501', 'permission denied for table households', 'an owner cannot change created_by in the same statement as plan_mode');
select is((select plan_mode::text from public.households where id = '0f000000-0000-4000-8000-0000000000f1'), 'simple', 'the refused statement changed nothing, plan_mode included');
select is((select created_by from public.households where id = '0f000000-0000-4000-8000-0000000000f1'), '0e000000-0000-4000-8000-0000000000e1'::uuid, 'created_by is still the creator');

-- A value outside the enum, or no value, never lands.
select throws_ok($$update public.households set plan_mode = 'weekly' where id = '0f000000-0000-4000-8000-0000000000f1'$$, '22P02', 'invalid input value for enum households_plan_mode: "weekly"', 'an invalid mode is refused');
select throws_ok($$update public.households set plan_mode = null where id = '0f000000-0000-4000-8000-0000000000f1'$$, '23502', 'null value in column "plan_mode" of relation "households" violates not-null constraint', 'a null mode is refused');
select is((select plan_mode::text from public.households where id = '0f000000-0000-4000-8000-0000000000f1'), 'simple', 'the mode is still simple after the refused values');

reset role;

select * from finish();

rollback;
