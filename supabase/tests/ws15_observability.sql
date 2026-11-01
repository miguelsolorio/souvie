-- WS15: pgTAP tests for the observability migration (20261031190000_ws15_observability.sql). Run
-- with `supabase test db`. Everything happens inside one transaction that is rolled back. Counts
-- are scoped to these fixtures (their own prompt versions and households): `db reset` loads the
-- ontology and the starter catalog, so nothing here counts a whole table.
--
-- What it proves:
--   * households.ai_daily_cap_usd defaults to 2.00, is readable by members and writable by no
--     client (UPDATE is granted by column and the new column is not on the list), is bounded, and
--     the service role can raise it
--   * v_ai_cost_daily totals equal the sum of ai_runs.cost_usd per household and day, grouped by
--     kind and model; a row the cap refused (error = 'cost_cap') is not counted as a call
--   * v_ai_cost_by_prompt gives calls, average latency and error rate per prompt version
--   * both views are security_invoker: a member sees only their household's rows, a user with no
--     household sees nothing, anon sees nothing
--   * user_ai_spend_since sums one user's household-less spend, for the service role only
--   * v_runs_stalled lists a running or checking_out run with no heartbeat for 10 minutes (or
--     waiting on a worker for that long), never a fresh one and never one waiting on a human, and
--     a member sees only their household's
--
-- Cast (fixed ids, matching the other test files):
--   alice  owns household A       carol  is a plain member of A
--   bob    owns household B       dave   belongs to no household

begin;

select plan(47);

-- ---------------------------------------------------------------------------------------
-- Fixtures (as the postgres role, which bypasses RLS)
-- ---------------------------------------------------------------------------------------

create function public.__t_affected(sql text) returns bigint
language plpgsql as $$
declare n bigint;
begin
  execute sql;
  get diagnostics n = row_count;
  return n;
end;
$$;
grant execute on function public.__t_affected(text) to authenticated, service_role;

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

-- Model calls. Household A over two days (one call refused by the cap), household B on one day,
-- and dave's household-less parsing calls. Prompt versions are this file's own.
insert into public.ai_runs (household_id, user_id, kind, model, prompt_version, cost_usd, latency_ms, ok, error, created_at) values
  ('0a000000-0000-4000-8000-00000000000a', 'a1111111-1111-4111-8111-111111111111', 'extract_recipe', 'claude-sonnet-5-5', 'ws15-extract.v1', 0.10, 2000, true, null, '2026-10-30 10:00:00+00'),
  ('0a000000-0000-4000-8000-00000000000a', 'a1111111-1111-4111-8111-111111111111', 'extract_recipe', 'claude-sonnet-5-5', 'ws15-extract.v1', 0.05, 1000, false, 'invalid', '2026-10-30 11:00:00+00'),
  ('0a000000-0000-4000-8000-00000000000a', null, 'suggest', 'claude-sonnet-5-5', 'ws15-compose.v1', 0.30, 4000, true, null, '2026-10-30 12:00:00+00'),
  ('0a000000-0000-4000-8000-00000000000a', 'a1111111-1111-4111-8111-111111111111', 'extract_recipe', 'claude-sonnet-5-5', 'ws15-extract.v1', 0.20, 3000, true, null, '2026-10-31 09:00:00+00'),
  ('0a000000-0000-4000-8000-00000000000a', 'a1111111-1111-4111-8111-111111111111', 'extract_recipe', 'claude-sonnet-5-5', 'ws15-extract.v1', 0, 0, false, 'cost_cap', '2026-10-31 09:30:00+00'),
  ('0b000000-0000-4000-8000-00000000000b', 'b2222222-2222-4222-8222-222222222222', 'extract_recipe', 'claude-sonnet-5-5', 'ws15-extract.v1', 1.00, 5000, true, null, '2026-10-30 10:00:00+00'),
  (null, 'd4444444-4444-4444-8444-444444444444', 'parse_ingredients', 'claude-haiku-5-5', 'ws15-parse.v1', 0.01, 400, true, null, '2026-10-30 08:00:00+00'),
  (null, 'd4444444-4444-4444-8444-444444444444', 'parse_ingredients', 'claude-haiku-5-5', 'ws15-parse.v1', 0.02, 600, true, null, '2026-10-31 08:00:00+00'),
  (null, 'a1111111-1111-4111-8111-111111111111', 'parse_ingredients', 'claude-haiku-5-5', 'ws15-parse.v1', 0.50, 700, true, null, '2026-10-31 08:00:00+00');

-- Runs for the stalled view: four lists for A, two for B.
insert into public.grocery_lists (id, household_id, name) values
  ('9a000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', 'ws15 A one'),
  ('9a000000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-00000000000a', 'ws15 A two'),
  ('9a000000-0000-4000-8000-0000000000a3', '0a000000-0000-4000-8000-00000000000a', 'ws15 A three'),
  ('9a000000-0000-4000-8000-0000000000a4', '0a000000-0000-4000-8000-00000000000a', 'ws15 A four'),
  ('9b000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b', 'ws15 B one'),
  ('9b000000-0000-4000-8000-0000000000b2', '0b000000-0000-4000-8000-00000000000b', 'ws15 B two');

insert into public.shopping_runs (id, household_id, list_id, retailer, status, heartbeat_at) values
  -- silent for 11 minutes: stalled
  ('5a000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-0000000000a1', 'kroger', 'running', now() - interval '11 minutes'),
  -- beat 9 minutes ago: alive enough
  ('5a000000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-0000000000a2', 'kroger', 'running', now() - interval '9 minutes'),
  -- checking out, silent for 30 minutes: stalled
  ('5a000000-0000-4000-8000-0000000000a3', '0a000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-0000000000a3', 'safeway', 'checking_out', now() - interval '30 minutes'),
  -- waiting on a human: never stalled, however old
  ('5a000000-0000-4000-8000-0000000000a4', '0a000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-0000000000a4', 'kroger', 'needs_review', null),
  -- B's stalled run
  ('5b000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b', '9b000000-0000-4000-8000-0000000000b1', 'kroger', 'running', now() - interval '20 minutes'),
  -- waiting for a worker (running, no heartbeat) since 15 minutes ago: stalled by its status age
  ('5b000000-0000-4000-8000-0000000000b2', '0b000000-0000-4000-8000-00000000000b', '9b000000-0000-4000-8000-0000000000b2', 'kroger', 'running', null);
update public.shopping_runs
   set status_changed_at = now() - interval '15 minutes'
 where id = '5b000000-0000-4000-8000-0000000000b2';
update public.shopping_runs
   set status_changed_at = now() - interval '3 days'
 where id = '5a000000-0000-4000-8000-0000000000a4';

-- ---------------------------------------------------------------------------------------
-- households.ai_daily_cap_usd
-- ---------------------------------------------------------------------------------------

select is((select ai_daily_cap_usd from public.households where id = '0a000000-0000-4000-8000-00000000000a'), 2.00::numeric, 'a household starts with a $2.00 daily cap');
select ok((select attnotnull from pg_attribute where attrelid = 'public.households'::regclass and attname = 'ai_daily_cap_usd'), 'the cap is not null');
select ok(has_column_privilege('authenticated', 'public.households', 'ai_daily_cap_usd', 'SELECT'), 'members can read the cap');
select ok(not has_column_privilege('authenticated', 'public.households', 'ai_daily_cap_usd', 'UPDATE'), 'no client can update the cap (UPDATE is granted by column)');
select ok(has_column_privilege('authenticated', 'public.households', 'name', 'UPDATE'), 'the column grants for name still stand');
select throws_ok($$ update public.households set ai_daily_cap_usd = -1 where id = '0a000000-0000-4000-8000-00000000000a' $$, '23514', null, 'a negative cap is refused');
select throws_ok($$ update public.households set ai_daily_cap_usd = 1001 where id = '0a000000-0000-4000-8000-00000000000a' $$, '23514', null, 'a cap over $1000 is refused');
select lives_ok($$ update public.households set ai_daily_cap_usd = 0 where id = '0b000000-0000-4000-8000-00000000000b' $$, 'a cap of zero is allowed (it switches model calls off)');
select is((select ai_daily_cap_usd from public.households where id = '0b000000-0000-4000-8000-00000000000b'), 0::numeric, 'and it reads back as zero');
update public.households set ai_daily_cap_usd = 2.00 where id = '0b000000-0000-4000-8000-00000000000b';

set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;
select throws_ok($$ update public.households set ai_daily_cap_usd = 500 where id = '0a000000-0000-4000-8000-00000000000a' $$, '42501', null, 'alice, an owner, cannot raise her own cap');
select is(public.__t_affected($$ update public.households set name = 'Alice House 2' where id = '0a000000-0000-4000-8000-00000000000a' $$), 1::bigint, 'alice can still rename her household');
select is((select ai_daily_cap_usd from public.households where id = '0a000000-0000-4000-8000-00000000000a'), 2.00::numeric, 'alice reads her cap');
select is_empty($$ select 1 from public.households where id = '0b000000-0000-4000-8000-00000000000b' $$, 'and she reads none of bob''s household');
reset role;

set local request.jwt.claims = '{"role": "service_role"}';
set local role service_role;
select lives_ok($$ update public.households set ai_daily_cap_usd = 5.50 where id = '0a000000-0000-4000-8000-00000000000a' $$, 'the service role raises a cap');
select is((select ai_daily_cap_usd from public.households where id = '0a000000-0000-4000-8000-00000000000a'), 5.50::numeric, 'and the new cap reads back');
reset role;

-- ---------------------------------------------------------------------------------------
-- v_ai_cost_daily and v_ai_cost_by_prompt (service role sees every row)
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"role": "service_role"}';
set local role service_role;

select is((select cost_usd from public.v_ai_cost_daily where household_id = '0a000000-0000-4000-8000-00000000000a' and day = '2026-10-30' and kind = 'extract_recipe' and model = 'claude-sonnet-5-5'), 0.15::numeric, 'A, 30 October, extract_recipe: the two calls total $0.15');
select is((select calls from public.v_ai_cost_daily where household_id = '0a000000-0000-4000-8000-00000000000a' and day = '2026-10-30' and kind = 'extract_recipe'), 2, 'and that is two calls');
select is((select cost_usd from public.v_ai_cost_daily where household_id = '0a000000-0000-4000-8000-00000000000a' and day = '2026-10-30' and kind = 'suggest'), 0.30::numeric, 'A, 30 October, suggest: $0.30');
select is((select cost_usd from public.v_ai_cost_daily where household_id = '0a000000-0000-4000-8000-00000000000a' and day = '2026-10-31' and kind = 'extract_recipe'), 0.20::numeric, 'A, 31 October: $0.20');
select is((select calls from public.v_ai_cost_daily where household_id = '0a000000-0000-4000-8000-00000000000a' and day = '2026-10-31' and kind = 'extract_recipe'), 1, 'and the refused call is not counted as a call');
select is((select sum(cost_usd) from public.v_ai_cost_daily where household_id = '0a000000-0000-4000-8000-00000000000a'), (select sum(cost_usd) from public.ai_runs where household_id = '0a000000-0000-4000-8000-00000000000a'), 'the view totals equal the sum of ai_runs.cost_usd for household A');
select is((select sum(cost_usd) from public.v_ai_cost_daily where household_id = '0b000000-0000-4000-8000-00000000000b'), 1.00::numeric, 'and for household B');
select is((select sum(cost_usd) from public.v_ai_cost_daily where household_id is null and kind = 'parse_ingredients' and day = '2026-10-31'), 0.52::numeric, 'household-less calls group under a null household');

select is((select calls from public.v_ai_cost_by_prompt where prompt_version = 'ws15-extract.v1'), 4, 'ws15-extract.v1: four calls across both households, the refused one left out');
select is((select avg_latency_ms from public.v_ai_cost_by_prompt where prompt_version = 'ws15-extract.v1'), 2750.0::numeric, 'ws15-extract.v1: average latency of the four calls');
select is((select error_rate from public.v_ai_cost_by_prompt where prompt_version = 'ws15-extract.v1'), 0.25::numeric, 'ws15-extract.v1: one failure in four is an error rate of 0.25');
select is((select error_rate from public.v_ai_cost_by_prompt where prompt_version = 'ws15-compose.v1'), 0::numeric, 'ws15-compose.v1: no failures');

reset role;

-- ---------------------------------------------------------------------------------------
-- The views are security_invoker: RLS on ai_runs decides the rows
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}';
set local role authenticated;
select is((select count(*) from public.v_ai_cost_daily where household_id = '0a000000-0000-4000-8000-00000000000a'), 3::bigint, 'carol, a member of A, sees A''s three day-kind rows');
select is((select count(*) from public.v_ai_cost_daily where household_id is distinct from '0a000000-0000-4000-8000-00000000000a'), 0::bigint, 'and nothing of B or of household-less calls');
select is((select calls from public.v_ai_cost_by_prompt where prompt_version = 'ws15-extract.v1'), 3, 'carol''s prompt view counts A''s three extract calls, not B''s');
select is((select error_rate from public.v_ai_cost_by_prompt where prompt_version = 'ws15-extract.v1'), 0.3333::numeric, 'and its error rate is A''s alone');
reset role;

set local request.jwt.claims = '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}';
set local role authenticated;
select is((select sum(cost_usd) from public.v_ai_cost_daily), 1.00::numeric, 'bob sees only B''s $1.00');
reset role;

set local request.jwt.claims = '{"sub": "d4444444-4444-4444-8444-444444444444", "role": "authenticated"}';
set local role authenticated;
select is_empty($$ select 1 from public.v_ai_cost_daily $$, 'dave, with no household, sees no cost rows, not even his own household-less calls');
select is_empty($$ select 1 from public.v_ai_cost_by_prompt $$, 'nor any prompt rows');
reset role;

set local request.jwt.claims = '{}';
set local role anon;
select throws_ok($$ select 1 from public.v_ai_cost_daily $$, '42501', null, 'anon cannot read the cost view');
select throws_ok($$ select 1 from public.v_runs_stalled $$, '42501', null, 'anon cannot read the stalled view');
reset role;

-- ---------------------------------------------------------------------------------------
-- user_ai_spend_since: household-less spend per user, service role only
-- ---------------------------------------------------------------------------------------

select ok(not has_function_privilege('authenticated', 'public.user_ai_spend_since(uuid, timestamptz)', 'EXECUTE'), 'authenticated cannot read anyone''s spend');
select ok(not has_function_privilege('anon', 'public.user_ai_spend_since(uuid, timestamptz)', 'EXECUTE'), 'anon cannot either');

set local request.jwt.claims = '{"role": "service_role"}';
set local role service_role;
select is(public.user_ai_spend_since('d4444444-4444-4444-8444-444444444444', '2026-10-30 00:00:00+00'), 0.03::numeric, 'dave''s household-less spend sums both days');
select is(public.user_ai_spend_since('d4444444-4444-4444-8444-444444444444', '2026-10-31 00:00:00+00'), 0.02::numeric, 'and only the days since the cutoff');
select is(public.user_ai_spend_since('a1111111-1111-4111-8111-111111111111', '2026-10-30 00:00:00+00'), 0.50::numeric, 'alice''s household calls do not count, her household-less one does');
select is(public.user_ai_spend_since('c3333333-3333-4333-8333-333333333333', '2026-10-30 00:00:00+00'), 0::numeric, 'a user with no calls has spent nothing');
reset role;

-- ---------------------------------------------------------------------------------------
-- v_runs_stalled
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"role": "service_role"}';
set local role service_role;
select is((select array_agg(run_id order by run_id) from public.v_runs_stalled where run_id::text like '5_000000-0000-4000-8000-0000000000%'),
  array['5a000000-0000-4000-8000-0000000000a1', '5a000000-0000-4000-8000-0000000000a3', '5b000000-0000-4000-8000-0000000000b1', '5b000000-0000-4000-8000-0000000000b2']::uuid[],
  'running 11 minutes silent, checking_out 30 minutes silent, B''s two: all stalled; the fresh run and the review wait are not');
select ok((select silent_seconds between 655 and 700 from public.v_runs_stalled where run_id = '5a000000-0000-4000-8000-0000000000a1'), 'silent_seconds counts from the last heartbeat');
select ok((select silent_seconds between 895 and 940 from public.v_runs_stalled where run_id = '5b000000-0000-4000-8000-0000000000b2'), 'and from the last status change for a run still waiting on a worker');
reset role;

set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;
select is((select array_agg(run_id order by run_id) from public.v_runs_stalled), array['5a000000-0000-4000-8000-0000000000a1', '5a000000-0000-4000-8000-0000000000a3']::uuid[], 'alice sees her household''s two stalled runs and none of B''s');
reset role;

set local request.jwt.claims = '{"sub": "d4444444-4444-4444-8444-444444444444", "role": "authenticated"}';
set local role authenticated;
select is_empty($$ select 1 from public.v_runs_stalled $$, 'dave sees no stalled runs');
reset role;

select * from finish();

rollback;
