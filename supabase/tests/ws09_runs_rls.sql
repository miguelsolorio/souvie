-- WS09: pgTAP tests for shopping_runs, shopping_run_items, push_tokens, the shopping_run queue, and
-- the run functions. Run with `supabase test db`. Everything happens inside one transaction that
-- is rolled back. Counts are scoped to the fixtures below: `db reset` loads the ontology and the
-- starter catalog, so nothing here counts a whole table.
--
-- What it proves:
--   * a member of household A reads none of household B's runs, items, or transcripts; the service
--     role reads both
--   * clients cannot write runs or items at all; they start a run through enqueue_shopping_run and
--     stop one through cancel_shopping_run, and both check membership
--   * enqueue_shopping_run validates the policy against core.RunPolicy's keys (unknown keys
--     refused, auto_checkout needs a cap), fills the defaults, refuses a second active run of the
--     same list, and sends one {"run_id"} message to the shopping_run queue
--   * the status guard refuses transitions the state machine does not allow, for every writer
--   * push tokens are per user: nobody reads or writes another user's
--   * retention clears cart_snapshot and alternatives 24 hours after a run closes, not before
--   * the service role cannot run DDL, and has no access to the pgmq schema (so the worker calls
--     pgmq as the connection role and run-approve goes through shopping_run_dispatch)
--
-- Cast (fixed ids, matching the other test files):
--   alice  owns household A       carol  is a plain member of A
--   bob    owns household B       dave   belongs to no household

begin;

select plan(94);

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

-- Lists: two for A, one for B. Items for A's first list.
insert into public.grocery_lists (id, household_id, name) values
  ('9a000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', 'ws09 A week'),
  ('9a000000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-00000000000a', 'ws09 A extra'),
  ('9b000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b', 'ws09 B week');

insert into public.grocery_list_items (id, list_id, household_id, display_name, qty, unit, section) values
  ('8a000000-0000-4000-8000-0000000000a1', '9a000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', 'Yellow onions', 2, 'each', 'produce'),
  ('8a000000-0000-4000-8000-0000000000a2', '9a000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', 'Whole milk', 1, 'gallon', 'dairy');

-- Connections with no secret (auth_type none), so no Vault is needed here; WS07's file covers
-- the Vault path. A's second connection needs a new sign-in.
insert into public.retailer_connections (
  id, household_id, user_id, retailer, auth_type, store_id, store_name, modality, status
) values
  ('7a000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', 'a1111111-1111-4111-8111-111111111111', 'kroger', 'none', 'MOCK0001', 'Mock QFC Duvall', 'pickup', 'active'),
  ('7a000000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-00000000000a', 'c3333333-3333-4333-8333-333333333333', 'kroger', 'none', 'MOCK0003', 'Mock QFC Redmond', 'pickup', 'needs_reauth'),
  ('7b000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b', 'b2222222-2222-4222-8222-222222222222', 'kroger', 'none', 'MOCK0002', 'Mock Fred Meyer Monroe', 'pickup', 'active');

create temp table __t_runs (name text primary key, id uuid) on commit drop;
grant all on __t_runs to authenticated, service_role;

create function public.__t_run(p_name text) returns uuid
language sql stable as $$ select id from __t_runs where name = p_name $$;
grant execute on function public.__t_run(text) to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------

select ok((select relrowsecurity from pg_class where oid = 'public.shopping_runs'::regclass), 'shopping_runs has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.shopping_run_items'::regclass), 'shopping_run_items has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.push_tokens'::regclass), 'push_tokens has RLS enabled');

select policies_are('public', 'shopping_runs', array['shopping_runs: members read'], 'shopping_runs has one read policy and no client write policy');
select policies_are('public', 'shopping_run_items', array['shopping_run_items: members read'], 'shopping_run_items has one read policy and no client write policy');
select policies_are('public', 'push_tokens', array['push_tokens: own read', 'push_tokens: own insert', 'push_tokens: own update', 'push_tokens: own delete'], 'push_tokens has the four own-row policies');

select ok(exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'shopping_runs'), 'shopping_runs is in the Realtime publication');
select ok(not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'shopping_run_items'), 'shopping_run_items is not published');

select ok(exists (select 1 from pgmq.list_queues() q where q.queue_name = 'shopping_run'), 'the shopping_run queue exists');
select ok(exists (select 1 from cron.job j where j.jobname = 'shopping-runs-retention' and j.command like '%shopping_runs_clear_expired%'), 'the retention job is scheduled');

select ok(not has_table_privilege('authenticated', 'public.shopping_runs', 'INSERT'), 'authenticated cannot insert runs');
select ok(not has_table_privilege('authenticated', 'public.shopping_runs', 'UPDATE'), 'authenticated cannot update runs');
select ok(not has_table_privilege('authenticated', 'public.shopping_run_items', 'UPDATE'), 'authenticated cannot update run items');
select ok(not has_table_privilege('anon', 'public.shopping_runs', 'SELECT'), 'anon cannot read runs');
select ok(not has_function_privilege('anon', 'public.enqueue_shopping_run(uuid, uuid, text, jsonb)', 'EXECUTE'), 'anon cannot enqueue a run');
select ok(not has_function_privilege('authenticated', 'public.shopping_run_dispatch(uuid)', 'EXECUTE'), 'only the service role dispatches a run');
select ok(not has_function_privilege('authenticated', 'public.shopping_runs_clear_expired(interval)', 'EXECUTE'), 'only the service role runs retention');

-- ---------------------------------------------------------------------------------------
-- RunPolicy in SQL (core.RunPolicy, CCR6)
-- ---------------------------------------------------------------------------------------

select ok(public.shopping_run_policy_is_valid('{}'), 'an empty policy is valid (defaults apply)');
select ok(public.shopping_run_policy_is_valid(public.shopping_run_default_policy()), 'the default policy is valid');
select ok(not public.shopping_run_policy_is_valid('{"budgetCapUsd": 100}'), 'an unknown key is refused (strict keys)');
select ok(not public.shopping_run_policy_is_valid('{"budget_cap_usd": 0}'), 'a zero budget cap is refused');
select ok(not public.shopping_run_policy_is_valid('{"budget_cap_usd": "100"}'), 'a budget cap given as text is refused');
select ok(not public.shopping_run_policy_is_valid('{"substitution": "brand"}'), 'an unknown substitution level is refused');
select ok(not public.shopping_run_policy_is_valid('{"auto_checkout": true}'), 'auto_checkout without a cap is refused');
select ok(public.shopping_run_policy_is_valid('{"auto_checkout": true, "auto_checkout_cap_usd": 150}'), 'auto_checkout with a cap is valid');
select ok(not public.shopping_run_policy_is_valid('{"max_tool_calls": 1.5}'), 'a fractional tool-call limit is refused');
select ok(not public.shopping_run_policy_is_valid('{"max_wall_clock_seconds": 4000}'), 'a wall clock over an hour is refused');

-- ---------------------------------------------------------------------------------------
-- enqueue_shopping_run as alice
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;

insert into __t_runs (name, id) values (
  'a1',
  public.enqueue_shopping_run('9a000000-0000-4000-8000-0000000000a1', '7a000000-0000-4000-8000-0000000000a1', 'manual', '{"budget_cap_usd": 150}')
);
select isnt(public.__t_run('a1'), null, 'alice starts a run of her list and gets its id');

select throws_ok($$ select public.enqueue_shopping_run('9a000000-0000-4000-8000-0000000000a1', '7a000000-0000-4000-8000-0000000000a1', 'manual', '{}') $$, 'P0001', 'run_in_progress', 'a second run of the same list waits for the first');
select throws_ok($$ select public.enqueue_shopping_run('9b000000-0000-4000-8000-0000000000b1', '7b000000-0000-4000-8000-0000000000b1', 'manual', '{}') $$, 'P0001', 'list_not_found', 'alice cannot start a run of B''s list');
select throws_ok($$ select public.enqueue_shopping_run('9a000000-0000-4000-8000-0000000000a2', '7b000000-0000-4000-8000-0000000000b1', 'manual', '{}') $$, 'P0001', 'connection_not_found', 'alice cannot shop at B''s connection');
select throws_ok($$ select public.enqueue_shopping_run('9a000000-0000-4000-8000-0000000000a2', '7a000000-0000-4000-8000-0000000000a2', 'manual', '{}') $$, 'P0001', 'connection_inactive', 'a connection that needs a new sign-in cannot start a run');
select throws_ok($$ select public.enqueue_shopping_run('9a000000-0000-4000-8000-0000000000a2', '7a000000-0000-4000-8000-0000000000a1', 'scheduled', '{}') $$, 'P0001', 'invalid_trigger', 'a person cannot start a scheduled run');
select throws_ok($$ select public.enqueue_shopping_run('9a000000-0000-4000-8000-0000000000a2', '7a000000-0000-4000-8000-0000000000a1', 'manual', '{"maxToolCalls": 5}') $$, 'P0001', 'invalid_policy', 'a policy with an unknown key is refused');
select throws_ok($$ select public.enqueue_shopping_run('9a000000-0000-4000-8000-0000000000a2', '7a000000-0000-4000-8000-0000000000a1', 'manual', '{"auto_checkout": true}') $$, 'P0001', 'invalid_policy', 'auto_checkout without a cap is refused at enqueue');
select throws_ok($$ insert into public.shopping_runs (household_id, list_id, retailer, policy) values ('0a000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-0000000000a2', 'kroger', '{}') $$, '42501', null, 'alice cannot insert a run directly');

reset role;

select is((select status::text from public.shopping_runs where id = public.__t_run('a1')), 'queued', 'the new run is queued');
select is((select trigger::text from public.shopping_runs where id = public.__t_run('a1')), 'manual', 'the new run is manual');
select is((select created_by from public.shopping_runs where id = public.__t_run('a1')), 'a1111111-1111-4111-8111-111111111111'::uuid, 'the run records who started it');
select is((select store_name || '/' || store_id || '/' || retailer::text from public.shopping_runs where id = public.__t_run('a1')), 'Mock QFC Duvall/MOCK0001/kroger', 'the run copies the store from the connection');
select is((select (policy ->> 'budget_cap_usd')::numeric from public.shopping_runs where id = public.__t_run('a1')), 150::numeric, 'the given policy key is kept');
select is((select policy - 'budget_cap_usd' from public.shopping_runs where id = public.__t_run('a1')), public.shopping_run_default_policy() - 'budget_cap_usd', 'every other key gets its default');
select is((select count(*)::int from pgmq.q_shopping_run m where m.message ->> 'run_id' = public.__t_run('a1')::text), 1, 'enqueue sends one message for the run');
select is((select (m.message - 'run_id') from pgmq.q_shopping_run m where m.message ->> 'run_id' = public.__t_run('a1')::text), '{}'::jsonb, 'the message carries the run id and nothing else');

-- The scheduler (no signed-in user) may start a scheduled run.
set local request.jwt.claims = '{"role": "service_role"}';
set local role service_role;
insert into __t_runs (name, id) values (
  'a2',
  public.enqueue_shopping_run('9a000000-0000-4000-8000-0000000000a2', '7a000000-0000-4000-8000-0000000000a1', 'scheduled', null)
);
reset role;
select is((select trigger::text || '/' || coalesce(created_by::text, 'nobody') from public.shopping_runs where id = public.__t_run('a2')), 'scheduled/nobody', 'the service role starts a scheduled run');

-- B's run, and items for A's run, written the way the worker writes them.
set local request.jwt.claims = '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}';
set local role authenticated;
insert into __t_runs (name, id) values (
  'b1',
  public.enqueue_shopping_run('9b000000-0000-4000-8000-0000000000b1', '7b000000-0000-4000-8000-0000000000b1', 'manual', '{}')
);
reset role;

insert into public.shopping_run_items (id, run_id, household_id, list_item_id, position, display_name, section, product_id, upc, product_name, size, qty, unit_price_usd, line_total_usd, status, alternatives) values
  ('6a000000-0000-4000-8000-0000000000a1', public.__t_run('a1'), '0b000000-0000-4000-8000-00000000000b', '8a000000-0000-4000-8000-0000000000a1', 0, 'Yellow onions', 'produce', '0099010000004', '0099010000004', 'Harbor Fields Yellow Onions', '3 lb bag', 1, 3.49, 3.49, 'matched', '[{"product_id": "0099010000005", "upc": "0099010000005", "name": "Cedar Valley Farms Red Onion", "size": "1 lb", "price": 1.49, "qty": 1}]'),
  ('6a000000-0000-4000-8000-0000000000a2', public.__t_run('a1'), '0a000000-0000-4000-8000-00000000000a', '8a000000-0000-4000-8000-0000000000a2', 1, 'Whole milk', 'dairy', '0099020000001', '0099020000001', 'Northfork Creamery Whole Milk', '1 gal', 1, 4.29, 4.29, 'matched', null);
update public.shopping_runs set transcript = '[{"ts": "2026-10-31T00:00:00Z", "tool": "search_products", "by": "host", "input": {}, "output_summary": "3 candidates", "ok": true}]'::jsonb where id = public.__t_run('a1');

select is((select household_id from public.shopping_run_items where id = '6a000000-0000-4000-8000-0000000000a1'), '0a000000-0000-4000-8000-00000000000a'::uuid, 'an item takes its household from its run, whatever the writer sent');

-- ---------------------------------------------------------------------------------------
-- RLS: household A versus household B
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.shopping_runs where household_id = '0a000000-0000-4000-8000-00000000000a'), 2, 'carol reads both of A''s runs');
select is((select count(*)::int from public.shopping_run_items where run_id = public.__t_run('a1')), 2, 'carol reads the items of A''s run');
select is((select jsonb_array_length(transcript) from public.shopping_runs where id = public.__t_run('a1')), 1, 'carol reads the transcript of A''s run');
select is((select count(*)::int from public.shopping_runs where id = public.__t_run('b1')), 0, 'carol reads none of B''s runs');
reset role;

set local request.jwt.claims = '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.shopping_runs where household_id = '0a000000-0000-4000-8000-00000000000a'), 0, 'bob reads none of A''s runs');
select is((select count(*)::int from public.shopping_run_items where household_id = '0a000000-0000-4000-8000-00000000000a'), 0, 'bob reads none of A''s run items');
select is((select count(*)::int from public.shopping_runs where id = public.__t_run('a1') and transcript is not null), 0, 'bob reads no transcript of A''s');
select is((select count(*)::int from public.shopping_runs where id = public.__t_run('b1')), 1, 'bob reads his own run');
select throws_ok($$ update public.shopping_runs set status = 'cancelled' where id = public.__t_run('a1') $$, '42501', null, 'bob cannot update A''s run');
select throws_ok($$ delete from public.shopping_run_items where run_id = public.__t_run('a1') $$, '42501', null, 'bob cannot delete A''s run items');
select throws_ok($$ select public.cancel_shopping_run(public.__t_run('a1')) $$, 'P0001', 'run_not_found', 'bob cannot cancel A''s run');
reset role;

set local request.jwt.claims = '{"sub": "d4444444-4444-4444-8444-444444444444", "role": "authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.shopping_runs where id in (public.__t_run('a1'), public.__t_run('b1'))), 0, 'dave, in no household, reads no runs');
select throws_ok($$ select public.enqueue_shopping_run('9a000000-0000-4000-8000-0000000000a2', '7a000000-0000-4000-8000-0000000000a1', 'manual', '{}') $$, 'P0001', 'list_not_found', 'dave cannot start a run');
reset role;

set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;
select throws_ok($$ update public.shopping_runs set status = 'cancelled' where id = public.__t_run('a1') $$, '42501', null, 'alice cannot write her own run directly');
select throws_ok($$ update public.shopping_run_items set qty = 9 where run_id = public.__t_run('a1') $$, '42501', null, 'alice cannot write her run''s items directly');
reset role;

set local request.jwt.claims = '{"role": "service_role"}';
set local role service_role;
select is((select count(*)::int from public.shopping_runs where id in (public.__t_run('a1'), public.__t_run('a2'), public.__t_run('b1'))), 3, 'the service role reads every household''s runs');
select is((select count(*)::int from public.shopping_run_items where run_id = public.__t_run('a1')), 2, 'the service role reads run items');
select throws_ok($$ create table public.__t_ddl (id int) $$, '42501', null, 'the service role cannot run DDL');
select ok(not has_schema_privilege('service_role', 'pgmq', 'USAGE'), 'the service role has no access to the pgmq schema');
select isnt(public.shopping_run_dispatch(public.__t_run('a1')), null, 'the service role dispatches a run through the definer function');
reset role;

select is((select count(*)::int from pgmq.q_shopping_run m where m.message ->> 'run_id' = public.__t_run('a1')::text), 2, 'dispatch sends a second message for the run');

-- ---------------------------------------------------------------------------------------
-- The status guard (state machine, packages/agent/src/state.ts)
-- ---------------------------------------------------------------------------------------

select throws_ok($$ update public.shopping_runs set status = 'cart_ready' where id = public.__t_run('a1') $$, 'P0001', 'invalid_transition: queued -> cart_ready', 'queued -> cart_ready is refused');
select lives_ok($$ update public.shopping_runs set status = 'running', heartbeat_at = now() where id = public.__t_run('a1') $$, 'queued -> running is allowed');
select isnt((select started_at from public.shopping_runs where id = public.__t_run('a1')), null, 'running stamps started_at');
select lives_ok($$ update public.shopping_runs set status = 'needs_review' where id = public.__t_run('a1') $$, 'running -> needs_review is allowed');
select is((select heartbeat_at from public.shopping_runs where id = public.__t_run('a1')), null, 'needs_review clears the heartbeat');
select lives_ok($$ update public.shopping_runs set status = 'running' where id = public.__t_run('a1') $$, 'needs_review -> running (the push phase) is allowed');
select lives_ok($$ update public.shopping_runs set status = 'cart_ready' where id = public.__t_run('a1') $$, 'running -> cart_ready is allowed');
select isnt((select finished_at from public.shopping_runs where id = public.__t_run('a1')), null, 'cart_ready stamps finished_at');
select lives_ok($$ update public.shopping_runs set status = 'checking_out' where id = public.__t_run('a1') $$, 'cart_ready -> checking_out is allowed');
select lives_ok($$ update public.shopping_runs set status = 'checked_out' where id = public.__t_run('a1') $$, 'checking_out -> checked_out is allowed');
select throws_ok($$ update public.shopping_runs set status = 'running' where id = public.__t_run('a1') $$, 'P0001', 'invalid_transition: checked_out -> running', 'checked_out -> running is refused');

-- ---------------------------------------------------------------------------------------
-- cancel_shopping_run
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}';
set local role authenticated;
select is(public.cancel_shopping_run(public.__t_run('a2'))::text, 'cancelled', 'carol cancels A''s queued run');
select throws_ok($$ select public.cancel_shopping_run(public.__t_run('a2')) $$, 'P0001', 'not_cancellable', 'a cancelled run cannot be cancelled again');
select throws_ok($$ select public.cancel_shopping_run(public.__t_run('a1')) $$, 'P0001', 'not_cancellable', 'a checked-out run cannot be cancelled');
reset role;

-- ---------------------------------------------------------------------------------------
-- push_tokens
-- ---------------------------------------------------------------------------------------

insert into public.push_tokens (user_id, token, platform) values
  ('b2222222-2222-4222-8222-222222222222', 'ExponentPushToken[ws09-bob]', 'ios');

set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;
select lives_ok($$ insert into public.push_tokens (token, platform) values ('ExponentPushToken[ws09-alice]', 'ios') $$, 'alice registers her device');
select throws_ok($$ insert into public.push_tokens (user_id, token, platform) values ('b2222222-2222-4222-8222-222222222222', 'ExponentPushToken[ws09-forged]', 'ios') $$, '42501', null, 'alice cannot register a token for bob');
select is((select count(*)::int from public.push_tokens where token like 'ExponentPushToken[ws09-%'), 1, 'alice reads only her own token');
select is(public.__t_affected($$ update public.push_tokens set platform = 'android' where token = 'ExponentPushToken[ws09-bob]' $$), 0::bigint, 'alice cannot change bob''s token');
select is(public.__t_affected($$ delete from public.push_tokens where token = 'ExponentPushToken[ws09-bob]' $$), 0::bigint, 'alice cannot delete bob''s token');
select is(public.__t_affected($$ delete from public.push_tokens where token = 'ExponentPushToken[ws09-alice]' $$), 1::bigint, 'alice removes her own token');
reset role;

-- ---------------------------------------------------------------------------------------
-- Retention: 24 hours after the run closes (docs/02 §Retention)
-- ---------------------------------------------------------------------------------------

update public.shopping_runs set cart_snapshot = '{"flags": []}' where id in (public.__t_run('a1'), public.__t_run('b1'));
update public.shopping_runs set status = 'running' where id = public.__t_run('b1');
update public.shopping_runs set status = 'cart_ready' where id = public.__t_run('b1');
update public.shopping_runs set finished_at = now() - interval '25 hours' where id = public.__t_run('a1');
update public.shopping_runs set finished_at = now() - interval '1 hour' where id = public.__t_run('b1');
insert into public.shopping_run_items (run_id, household_id, display_name, product_id, product_name, qty, status, alternatives) values
  (public.__t_run('b1'), '0b000000-0000-4000-8000-00000000000b', 'Bananas', '0099010000001', 'Harbor Fields Bananas', 1, 'matched', '[{"product_id": "0099010000003", "upc": null, "name": "Honeycrisp Apples", "size": "1 lb", "price": 2.99, "qty": 1}]');
-- A2 was cancelled before anyone approved it: its proposal is no purchase record.
update public.shopping_runs set finished_at = now() - interval '25 hours' where id = public.__t_run('a2');
insert into public.shopping_run_items (run_id, household_id, display_name, product_id, upc, product_name, size, qty, unit_price_usd, line_total_usd, status) values
  (public.__t_run('a2'), '0a000000-0000-4000-8000-00000000000a', 'Garlic', '0099010000006', '0099010000006', 'Garlic', '3 ct', 1, 1.99, 1.99, 'matched');

select ok(public.shopping_runs_clear_expired() >= 1, 'retention clears at least the expired fixture run');
select is((select coalesce(product_name, 'cleared') || '/' || coalesce(unit_price_usd::text, 'cleared') from public.shopping_run_items where run_id = public.__t_run('a2')), 'cleared/cleared', 'a proposal cancelled before approval loses its products and prices');
select is((select cart_snapshot from public.shopping_runs where id = public.__t_run('a1')), null, 'a run closed 25 hours ago loses its cart snapshot');
select is((select count(*)::int from public.shopping_run_items where run_id = public.__t_run('a1') and alternatives is not null), 0, 'and its items lose their alternatives');
select is((select product_name || ' x' || qty::text from public.shopping_run_items where id = '6a000000-0000-4000-8000-0000000000a1'), 'Harbor Fields Yellow Onions x1', 'the reviewed product and quantity stay as the purchase record');
select isnt((select cart_snapshot from public.shopping_runs where id = public.__t_run('b1')), null, 'a run closed an hour ago keeps its snapshot');
select is((select count(*)::int from public.shopping_run_items where run_id = public.__t_run('b1') and alternatives is not null), 1, 'and its alternatives');

select * from finish();
rollback;
