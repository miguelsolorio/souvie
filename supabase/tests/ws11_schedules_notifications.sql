-- WS11: pgTAP tests for scheduled runs and push notifications
-- (20261031170000_ws11_schedules_notifications.sql). Run with `supabase test db`. Everything
-- happens inside one transaction that is rolled back. Counts are scoped to the fixtures below:
-- `db reset` loads the ontology and the starter catalog, so nothing here counts a whole table.
--
-- Time is passed in, not read: enqueue_due_scheduled_runs, enqueue_weekly_nudges and
-- enqueue_pickup_reminders take `p_now`, so the Saturday cases use fixed instants. Inside one
-- transaction now() never moves.
--
-- What it proves:
--   * a member of household A reads none of household B's schedules; only owners write them; a
--     client cannot write next_run_at or last_enqueued_for; the connection must be the
--     household's own; a household has at most ten schedules; the policy is validated; changes
--     to the rules are logged
--   * households.quiet_hours and households.timezone are owner-editable and validated, and
--     nothing else on households became editable
--   * scheduled_run_next agrees with packages/core nextRunAt across the March and November
--     daylight saving changes
--   * enqueue_due_scheduled_runs (the cron job): one run and one queue message per due schedule
--     for the right household's list, next_run_at advanced, nothing on a second call, nothing when
--     the same next_run_at is replayed, and a skipped schedule says why through the outbox
--   * notification_preferences: a person reads and writes their own and nobody else's
--   * register_push_token moves a device to whoever signed in last; forget_push_token works with
--     no session
--   * the notification_outbox is closed to clients; the weekly nudge, the failed run and the
--     slow import write it once
--   * WS09 follow-up: a review that timed out 47 hours ago is kept, one from 49 hours ago is
--     cancelled (the lower bound of shopping_runs_clear_expired)
--
-- Cast (fixed ids, matching the other test files):
--   alice  owns household A       carol  is a plain member of A
--   bob    owns household B       dave   belongs to no household
--   erin   owns household C, which has a store but no plan and no list

begin;

select plan(219);

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
  ('d4444444-4444-4444-8444-444444444444', 'dave@example.test', '{}'),
  ('e5555555-5555-4555-8555-555555555555', 'erin@example.test', '{}');

insert into public.households (id, name, created_by) values
  ('0a000000-0000-4000-8000-00000000000a', 'Alice House', 'a1111111-1111-4111-8111-111111111111'),
  ('0b000000-0000-4000-8000-00000000000b', 'Bob House', 'b2222222-2222-4222-8222-222222222222'),
  ('0c000000-0000-4000-8000-00000000000c', 'Erin House', 'e5555555-5555-4555-8555-555555555555');

insert into public.household_members (household_id, user_id, role) values
  ('0a000000-0000-4000-8000-00000000000a', 'a1111111-1111-4111-8111-111111111111', 'owner'),
  ('0a000000-0000-4000-8000-00000000000a', 'c3333333-3333-4333-8333-333333333333', 'member'),
  ('0b000000-0000-4000-8000-00000000000b', 'b2222222-2222-4222-8222-222222222222', 'owner'),
  ('0c000000-0000-4000-8000-00000000000c', 'e5555555-5555-4555-8555-555555555555', 'owner');

-- Connections. A1 is alice's Kroger, A2 is carol's and needs a new sign-in, A3 is alice's Safeway
-- (a Tier 3 browser session with a Vault key), B1 is bob's, C1 is erin's.
insert into public.retailer_connections (
  id, household_id, user_id, retailer, auth_type, vault_secret_id, store_id, store_name, modality, status
) values
  ('7a000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', 'a1111111-1111-4111-8111-111111111111', 'kroger', 'none', null, 'MOCK0001', 'Mock QFC Duvall', 'pickup', 'active'),
  ('7a000000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-00000000000a', 'c3333333-3333-4333-8333-333333333333', 'kroger', 'none', null, 'MOCK0003', 'Mock QFC Redmond', 'pickup', 'needs_reauth'),
  ('7a000000-0000-4000-8000-0000000000a3', '0a000000-0000-4000-8000-00000000000a', 'a1111111-1111-4111-8111-111111111111', 'safeway', 'browser_session', vault.create_secret('ws11 test key'), 'SW0001', 'Safeway Duvall', 'pickup', 'active'),
  ('7b000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b', 'b2222222-2222-4222-8222-222222222222', 'kroger', 'none', null, 'MOCK0002', 'Mock Fred Meyer Monroe', 'pickup', 'active'),
  ('7c000000-0000-4000-8000-0000000000c1', '0c000000-0000-4000-8000-00000000000c', 'e5555555-5555-4555-8555-555555555555', 'kroger', 'none', null, 'MOCK0004', 'Mock QFC Kirkland', 'pickup', 'active');

-- Plans and lists. Saturday 2026-11-07 09:00 in Los Angeles shops for the week of Monday
-- 2026-11-09. A has the list for that week and the list of the week before (which a run on
-- the 7th must not pick) and one list that belongs to no plan; B has its list for the week; C has a
-- plan for the week whose list is still a draft (it goes active further down). A plan has at most
-- one live list.
insert into public.recipes (id, household_id, title, source_type) values
  ('aa000000-0000-4000-8000-000000000001', '0a000000-0000-4000-8000-00000000000a', 'A1 lemon chicken', 'manual'),
  ('bb000000-0000-4000-8000-000000000001', '0b000000-0000-4000-8000-00000000000b', 'B1 stew', 'manual');

insert into public.meal_plans (id, household_id, week_start) values
  ('ca000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '2026-11-02'),
  ('ca000000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-00000000000a', '2026-11-09'),
  ('cb000000-0000-4000-8000-0000000000b2', '0b000000-0000-4000-8000-00000000000b', '2026-11-09'),
  ('cc000000-0000-4000-8000-0000000000c2', '0c000000-0000-4000-8000-00000000000c', '2026-11-09');

-- A planned the week of 11-02 and nothing yet for 11-09. B planned 11-09. C planned nothing.
insert into public.meal_plan_entries (plan_id, household_id, date, slot, recipe_id, servings) values
  ('ca000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '2026-11-03', 'dinner', 'aa000000-0000-4000-8000-000000000001', 4),
  ('cb000000-0000-4000-8000-0000000000b2', '0b000000-0000-4000-8000-00000000000b', '2026-11-10', 'dinner', 'bb000000-0000-4000-8000-000000000001', 2);

insert into public.grocery_lists (id, household_id, plan_id, name, status, built_at) values
  ('9a000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', 'ca000000-0000-4000-8000-0000000000a1', 'A week of Nov 2', 'active', '2026-10-30 18:00+00'),
  ('9a000000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-00000000000a', 'ca000000-0000-4000-8000-0000000000a2', 'A week of Nov 9', 'active', '2026-11-06 18:00+00'),
  ('9a000000-0000-4000-8000-0000000000a4', '0a000000-0000-4000-8000-00000000000a', null, 'A ad hoc list', 'active', '2026-11-07 08:00+00'),
  ('9b000000-0000-4000-8000-0000000000b2', '0b000000-0000-4000-8000-00000000000b', 'cb000000-0000-4000-8000-0000000000b2', 'B week of Nov 9', 'active', '2026-11-06 18:00+00'),
  ('9c000000-0000-4000-8000-0000000000c2', '0c000000-0000-4000-8000-00000000000c', 'cc000000-0000-4000-8000-0000000000c2', 'C week of Nov 9', 'draft', '2026-11-06 18:00+00');

create temp table __t_ids (name text primary key, id uuid) on commit drop;
grant all on __t_ids to authenticated, service_role;
create function public.__t_id(p_name text) returns uuid
language sql stable as $$ select id from __t_ids where name = p_name $$;
grant execute on function public.__t_id(text) to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------

select ok((select relrowsecurity from pg_class where oid = 'public.scheduled_runs'::regclass), 'scheduled_runs has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.notification_preferences'::regclass), 'notification_preferences has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.notification_outbox'::regclass), 'notification_outbox has RLS enabled');

select policies_are('public', 'scheduled_runs', array['scheduled_runs: members read', 'scheduled_runs: owners insert', 'scheduled_runs: owners update', 'scheduled_runs: owners delete'], 'scheduled_runs: members read, owners write');
select policies_are('public', 'notification_preferences', array['notification_preferences: own read'], 'notification_preferences has one read policy and no client write policy');
select policies_are('public', 'notification_outbox', array[]::name[], 'notification_outbox has no policy at all');

select is((select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e where e.enumtypid = 'public.notification_type'::regtype), array['cart_ready', 'items_need_review', 'pickup_reminder', 'weekly_nudge', 'import_finished', 'run_failed', 'schedule_skipped'], 'notification_type holds docs/02''s five types and the two outbox-only ones');

select ok(not has_table_privilege('anon', 'public.scheduled_runs', 'SELECT'), 'anon cannot read schedules');
select ok(has_table_privilege('authenticated', 'public.scheduled_runs', 'SELECT'), 'authenticated reads schedules (RLS decides which)');
select ok(not has_table_privilege('authenticated', 'public.scheduled_runs', 'UPDATE'), 'there is no table-level UPDATE on schedules');
select ok(has_column_privilege('authenticated', 'public.scheduled_runs', 'cron', 'UPDATE'), 'cron is client-editable');
select ok(has_column_privilege('authenticated', 'public.scheduled_runs', 'policy', 'UPDATE'), 'policy is client-editable');
select ok(not has_column_privilege('authenticated', 'public.scheduled_runs', 'next_run_at', 'UPDATE'), 'next_run_at is not client-editable');
select ok(not has_column_privilege('authenticated', 'public.scheduled_runs', 'last_enqueued_for', 'UPDATE'), 'last_enqueued_for is not client-editable');
select ok(not has_column_privilege('authenticated', 'public.scheduled_runs', 'household_id', 'UPDATE'), 'a schedule cannot move to another household');
select ok(not has_column_privilege('authenticated', 'public.scheduled_runs', 'next_run_at', 'INSERT'), 'next_run_at is not client-writable on insert either');
select ok(not has_table_privilege('authenticated', 'public.notification_outbox', 'SELECT'), 'authenticated cannot read the outbox');
select ok(not has_table_privilege('authenticated', 'public.notification_outbox', 'INSERT'), 'authenticated cannot write the outbox');
select ok(not has_table_privilege('anon', 'public.notification_outbox', 'SELECT'), 'anon cannot read the outbox');
select ok(not has_table_privilege('authenticated', 'public.notification_preferences', 'INSERT'), 'preferences are written through set_notification_preference');
select ok(not has_table_privilege('authenticated', 'public.notification_preferences', 'UPDATE'), 'authenticated has no UPDATE on preferences');

select ok(not has_function_privilege('anon', 'public.enqueue_due_scheduled_runs(timestamptz)', 'EXECUTE'), 'anon cannot run the scheduler');
select ok(not has_function_privilege('authenticated', 'public.enqueue_due_scheduled_runs(timestamptz)', 'EXECUTE'), 'a signed-in client cannot run the scheduler');
select ok(has_function_privilege('service_role', 'public.enqueue_due_scheduled_runs(timestamptz)', 'EXECUTE'), 'the service role runs the scheduler');
select ok(not has_function_privilege('authenticated', 'public.notification_outbox_add(uuid, public.notification_type, jsonb, timestamptz, text)', 'EXECUTE'), 'a signed-in client cannot write the outbox through the helper');
select ok(not has_function_privilege('authenticated', 'public.enqueue_notification_generators()', 'EXECUTE'), 'a signed-in client cannot run the generators');
select ok(not has_function_privilege('anon', 'public.register_push_token(text, public.push_tokens_platform)', 'EXECUTE'), 'anon cannot register a device');
select ok(not has_function_privilege('anon', 'public.set_notification_preference(public.notification_type, boolean)', 'EXECUTE'), 'anon cannot set a preference');
select ok(has_function_privilege('anon', 'public.forget_push_token(text)', 'EXECUTE'), 'anon can forget a device by its token');

select ok((select count(*) = 1 from cron.job j where j.jobname = 'enqueue-due-scheduled-runs' and j.schedule = '*/5 * * * *' and j.command like '%enqueue_due_scheduled_runs%'), 'the scheduler runs every 5 minutes');
select ok((select count(*) = 1 from cron.job j where j.jobname = 'notification-generators' and j.command like '%enqueue_notification_generators%'), 'the generators are scheduled');
select ok((select count(*) = 1 from cron.job j where j.jobname = 'notification-outbox-prune' and j.command like '%notification_outbox_prune%'), 'the outbox is pruned daily');

-- ---------------------------------------------------------------------------------------
-- Validators and time math
-- ---------------------------------------------------------------------------------------

select ok(public.is_valid_time_zone('America/Los_Angeles'), 'America/Los_Angeles is a zone');
select ok(not public.is_valid_time_zone('America/Los_Angelez'), 'a typo is not a zone');
select ok(not public.is_valid_time_zone(null), 'null is not a zone');

select ok(public.quiet_hours_is_valid('{"start": "21:00", "end": "07:00"}'), 'quiet hours past midnight are valid');
select ok(public.quiet_hours_is_valid('{"start": "13:00", "end": "15:30"}'), 'quiet hours inside a day are valid');
select ok(not public.quiet_hours_is_valid('{"start": "21:00", "end": "21:00"}'), 'quiet hours that start and end together are refused');
select ok(not public.quiet_hours_is_valid('{"start": "9pm", "end": "07:00"}'), 'a time that is not HH:MM is refused');
select ok(not public.quiet_hours_is_valid('{"start": "24:00", "end": "07:00"}'), 'hour 24 is refused');
select ok(not public.quiet_hours_is_valid('{"start": "21:00", "end": "07:00", "tz": "UTC"}'), 'an extra key is refused');
select ok(not public.quiet_hours_is_valid('{"start": "21:00"}'), 'a missing key is refused');
select ok(not public.quiet_hours_is_valid('{"start": 21, "end": 7}'), 'numbers are refused');
select ok(not public.quiet_hours_is_valid('"21:00-07:00"'), 'a string is refused');

select ok(public.scheduled_run_cron_is_valid('0 9 * * 6'), 'a weekly cron is valid');
select ok(public.scheduled_run_cron_is_valid(' 30 18 * * 1-5 '), 'a weekday range is valid, spaces and all');
select ok(public.scheduled_run_cron_is_valid('0 7 * * 0,6'), 'a weekday list with Sunday as 0 is valid');
select ok(public.scheduled_run_cron_is_valid('15 6 * * *'), 'every day is valid');
select ok(not public.scheduled_run_cron_is_valid('*/5 * * * *'), 'steps are refused');
select ok(not public.scheduled_run_cron_is_valid('0 9 1 * 6'), 'a day of month is refused');
select ok(not public.scheduled_run_cron_is_valid('60 9 * * 6'), 'minute 60 is refused');
select ok(not public.scheduled_run_cron_is_valid('0 24 * * 6'), 'hour 24 is refused');
select ok(not public.scheduled_run_cron_is_valid('0 9 * * 6-5'), 'a downward weekday range is refused');
select ok(not public.scheduled_run_cron_is_valid('0 9 * * SAT'), 'weekday names are refused');
select ok(not public.scheduled_run_cron_is_valid('0 9,10 * * 6'), 'two hours are refused');
select ok(not public.scheduled_run_cron_is_valid(null), 'null is refused');

-- The same cases as packages/core/src/schedule.test.ts, in UTC text.
select is((public.scheduled_run_next('0 9 * * 6', 'America/Los_Angeles', '2026-10-28 12:00+00') at time zone 'UTC')::text, '2026-10-31 16:00:00', 'Saturday 9:00 PDT is 16:00 UTC');
select is((public.scheduled_run_next('0 9 * * 6', 'America/Los_Angeles', '2026-10-31 16:00+00') at time zone 'UTC')::text, '2026-11-07 17:00:00', 'a `from` exactly on the time gets the next week, now in PST (November)');
select is((public.scheduled_run_next('0 9 * * 6', 'America/Los_Angeles', '2026-10-31 15:59:59.999+00') at time zone 'UTC')::text, '2026-10-31 16:00:00', 'a millisecond before it stays on it');
select is((public.scheduled_run_next('0 9 * * 6', 'America/Los_Angeles', '2026-03-07 17:00+00') at time zone 'UTC')::text, '2026-03-14 16:00:00', 'across the March change forward 9:00 is 16:00 UTC');
select is((public.scheduled_run_next('0 9 * * 6', 'America/Los_Angeles', '2026-02-28 20:00+00') at time zone 'UTC')::text, '2026-03-07 17:00:00', 'and 17:00 UTC before it');
select is((public.scheduled_run_next('30 2 * * *', 'America/Los_Angeles', '2026-03-07 12:00+00') at time zone 'UTC')::text, '2026-03-08 10:30:00', 'a time in the skipped hour runs once, an hour later on the clock');
select is((public.scheduled_run_next('30 1 * * *', 'America/Los_Angeles', '2026-10-31 09:00+00') at time zone 'UTC')::text, '2026-11-01 09:30:00', 'a time in the repeated hour runs once, at the later one');
select is((public.scheduled_run_next('0 9 * * 6', 'Asia/Kolkata', '2026-10-28 00:00+00') at time zone 'UTC')::text, '2026-10-31 03:30:00', 'a zone with a half hour offset');
select is((public.scheduled_run_next('0 18 * * 1-5', 'America/Los_Angeles', '2026-10-31 01:00+00') at time zone 'UTC')::text, '2026-11-03 02:00:00', 'a weekday range skips the weekend');
select is((public.scheduled_run_next('0 9 * * 6', 'America/Los_Angeles', '2026-11-01 03:00+00') at time zone 'UTC')::text, '2026-11-07 17:00:00', 'a `from` is read on the schedule''s wall clock, not UTC''s');
select throws_ok($$ select public.scheduled_run_next('nope', 'UTC', now()) $$, 'P0001', 'invalid_cron', 'a bad cron raises invalid_cron');
select throws_ok($$ select public.scheduled_run_next('0 9 * * 6', 'Mars/Olympus', now()) $$, 'P0001', 'invalid_time_zone', 'a bad zone raises invalid_time_zone');

select is(public.scheduled_run_target_week('2026-10-31 16:00+00', 'America/Los_Angeles')::text, '2026-11-02', 'a Saturday run shops for the Monday after');
select is(public.scheduled_run_target_week('2026-11-01 20:00+00', 'America/Los_Angeles')::text, '2026-11-02', 'a Sunday run shops for the next day''s Monday');
select is(public.scheduled_run_target_week('2026-11-02 17:00+00', 'America/Los_Angeles')::text, '2026-11-02', 'a Monday run shops for that Monday');
select is(public.scheduled_run_target_week('2026-11-03 18:00+00', 'America/Los_Angeles')::text, '2026-11-09', 'a Tuesday run shops for the Monday a week later');
select is(public.scheduled_run_target_week('2026-11-03 03:00+00', 'America/Los_Angeles')::text, '2026-11-02', 'the day is read in the schedule''s zone (Monday evening in Los Angeles)');
select is(public.scheduled_run_target_week('2026-11-03 03:00+00', 'UTC')::text, '2026-11-09', 'and in UTC it is already Tuesday');

-- ---------------------------------------------------------------------------------------
-- households.timezone and households.quiet_hours
-- ---------------------------------------------------------------------------------------

select ok(has_column_privilege('authenticated', 'public.households', 'quiet_hours', 'UPDATE'), 'quiet_hours is granted for UPDATE (owners only, through the existing policy)');
select ok(has_column_privilege('authenticated', 'public.households', 'timezone', 'UPDATE'), 'timezone is granted for UPDATE');
select ok(not has_column_privilege('authenticated', 'public.households', 'deleted_at', 'UPDATE'), 'nothing else on households became editable (deleted_at)');
select ok(not has_column_privilege('authenticated', 'public.households', 'default_connection_id', 'UPDATE'), 'nothing else on households became editable (default_connection_id)');

set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;
select is(public.__t_affected($$ update public.households set quiet_hours = '{"start": "21:00", "end": "07:00"}', timezone = 'America/Los_Angeles' where id = '0a000000-0000-4000-8000-00000000000a' $$), 1::bigint, 'alice, the owner, sets her household''s quiet hours and zone');
select throws_ok($$ update public.households set quiet_hours = '{"start": "21:00", "end": "21:00"}' where id = '0a000000-0000-4000-8000-00000000000a' $$, '23514', null, 'quiet hours of zero length are refused');
select throws_ok($$ update public.households set timezone = 'Nowhere/Land' where id = '0a000000-0000-4000-8000-00000000000a' $$, '23514', null, 'a zone that does not exist is refused');
select is(public.__t_affected($$ update public.households set quiet_hours = null where id = '0a000000-0000-4000-8000-00000000000a' $$), 1::bigint, 'she can clear quiet hours');
select is(public.__t_affected($$ update public.households set quiet_hours = '{"start": "21:00", "end": "07:00"}' where id = '0a000000-0000-4000-8000-00000000000a' $$), 1::bigint, 'and set them again');
select is(public.__t_affected($$ update public.households set quiet_hours = '{"start": "01:00", "end": "02:00"}' where id = '0b000000-0000-4000-8000-00000000000b' $$), 0::bigint, 'alice cannot set household B''s quiet hours');
reset role;

set local request.jwt.claims = '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}';
set local role authenticated;
select is(public.__t_affected($$ update public.households set quiet_hours = null where id = '0a000000-0000-4000-8000-00000000000a' $$), 0::bigint, 'carol, a member, cannot change the household''s quiet hours');
select is((select quiet_hours ->> 'start' from public.households where id = '0a000000-0000-4000-8000-00000000000a'), '21:00', 'but she reads them');
select is((select count(*)::int from public.households where id = '0b000000-0000-4000-8000-00000000000b'), 0, 'and reads nothing of household B');
reset role;

-- ---------------------------------------------------------------------------------------
-- scheduled_runs: who may read and write
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;

insert into __t_ids (name, id) values ('s1', gen_random_uuid());
select lives_ok($$ insert into public.scheduled_runs (id, household_id, cron, tz, connection_id, policy) values (public.__t_id('s1'), '0a000000-0000-4000-8000-00000000000a', '0 9 * * 6', 'America/Los_Angeles', '7a000000-0000-4000-8000-0000000000a1', '{"budget_cap_usd": 150, "substitution": "none", "auto_checkout": true, "auto_checkout_cap_usd": 100}') $$, 'alice, the owner, creates a Saturday 9:00 schedule');
select throws_ok($$ insert into public.scheduled_runs (household_id, cron, tz, connection_id, next_run_at) values ('0a000000-0000-4000-8000-00000000000a', '0 9 * * 6', 'America/Los_Angeles', '7a000000-0000-4000-8000-0000000000a1', now()) $$, '42501', null, 'she cannot set next_run_at herself');
select throws_ok($$ insert into public.scheduled_runs (household_id, cron, tz, connection_id) values ('0b000000-0000-4000-8000-00000000000b', '0 9 * * 6', 'America/Los_Angeles', '7b000000-0000-4000-8000-0000000000b1') $$, '42501', null, 'she cannot create a schedule in household B');
select throws_ok($$ insert into public.scheduled_runs (household_id, cron, tz, connection_id) values ('0a000000-0000-4000-8000-00000000000a', '0 9 * * 6', 'America/Los_Angeles', '7b000000-0000-4000-8000-0000000000b1') $$, 'P0001', 'connection_not_found', 'and cannot schedule a run at B''s store connection');
select throws_ok($$ insert into public.scheduled_runs (household_id, cron, tz, connection_id) values ('0a000000-0000-4000-8000-00000000000a', 'every saturday', 'America/Los_Angeles', '7a000000-0000-4000-8000-0000000000a1') $$, 'P0001', 'invalid_cron', 'a cron outside the supported subset is refused');
select throws_ok($$ insert into public.scheduled_runs (household_id, cron, tz, connection_id) values ('0a000000-0000-4000-8000-00000000000a', '0 9 * * 6', 'Nowhere/Land', '7a000000-0000-4000-8000-0000000000a1') $$, 'P0001', 'invalid_time_zone', 'a zone that does not exist is refused');
select throws_ok($$ insert into public.scheduled_runs (household_id, cron, tz, connection_id, policy) values ('0a000000-0000-4000-8000-00000000000a', '0 9 * * 6', 'America/Los_Angeles', '7a000000-0000-4000-8000-0000000000a1', '{"budgetCapUsd": 100}') $$, '23514', null, 'a policy with an unknown key is refused');
select throws_ok($$ insert into public.scheduled_runs (household_id, cron, tz, connection_id, policy) values ('0a000000-0000-4000-8000-00000000000a', '0 9 * * 6', 'America/Los_Angeles', '7a000000-0000-4000-8000-0000000000a1', '{"auto_checkout": true}') $$, '23514', null, 'auto_checkout without a cap is refused, as on a run');
select throws_ok($$ insert into public.scheduled_runs (household_id, cron, tz, connection_id, policy) values ('0a000000-0000-4000-8000-00000000000a', '0 9 * * 6', 'America/Los_Angeles', '7a000000-0000-4000-8000-0000000000a1', '{"budget_cap_usd": 0}') $$, '23514', null, 'a budget cap of zero is refused');
reset role;

select is((select created_by from public.scheduled_runs where id = public.__t_id('s1')), 'a1111111-1111-4111-8111-111111111111'::uuid, 'the schedule records who made it');
select ok((select next_run_at > now() from public.scheduled_runs where id = public.__t_id('s1')), 'the server set next_run_at, in the future');
select is((select next_run_at from public.scheduled_runs where id = public.__t_id('s1')), public.scheduled_run_next('0 9 * * 6', 'America/Los_Angeles', now()), 'to the next firing of the cron');
select is((select last_enqueued_for from public.scheduled_runs where id = public.__t_id('s1')), null, 'and nothing has been handled yet');
select is((select count(*)::int from public.audit_events where household_id = '0a000000-0000-4000-8000-00000000000a' and kind = 'policy_changed' and payload ->> 'scheduled_run_id' = public.__t_id('s1')::text and payload ->> 'change' = 'insert'), 1, 'creating the schedule is logged as a policy change (docs/05 §Money)');

set local request.jwt.claims = '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.scheduled_runs where household_id = '0a000000-0000-4000-8000-00000000000a'), 1, 'carol, a member, reads A''s schedules');
select throws_ok($$ insert into public.scheduled_runs (household_id, cron, tz, connection_id) values ('0a000000-0000-4000-8000-00000000000a', '0 9 * * 6', 'America/Los_Angeles', '7a000000-0000-4000-8000-0000000000a2') $$, '42501', null, 'but a member cannot create one (the spending rules are the owner''s)');
select is(public.__t_affected($$ update public.scheduled_runs set enabled = false where id = public.__t_id('s1') $$), 0::bigint, 'nor change one');
select is(public.__t_affected($$ delete from public.scheduled_runs where id = public.__t_id('s1') $$), 0::bigint, 'nor delete one');
reset role;

set local request.jwt.claims = '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.scheduled_runs where household_id = '0a000000-0000-4000-8000-00000000000a'), 0, 'bob reads none of A''s schedules');
select is(public.__t_affected($$ update public.scheduled_runs set enabled = false where id = public.__t_id('s1') $$), 0::bigint, 'bob cannot change A''s schedule');
select is(public.__t_affected($$ delete from public.scheduled_runs where id = public.__t_id('s1') $$), 0::bigint, 'bob cannot delete A''s schedule');
reset role;

set local request.jwt.claims = '{"sub": "d4444444-4444-4444-8444-444444444444", "role": "authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.scheduled_runs), 0, 'dave, in no household, reads no schedules');
reset role;

-- Edits by the owner.
set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;
select throws_ok($$ update public.scheduled_runs set next_run_at = now() where id = public.__t_id('s1') $$, '42501', null, 'alice cannot move next_run_at');
select throws_ok($$ update public.scheduled_runs set household_id = '0b000000-0000-4000-8000-00000000000b' where id = public.__t_id('s1') $$, '42501', null, 'or move the schedule to another household');
select is(public.__t_affected($$ update public.scheduled_runs set policy = '{"budget_cap_usd": 175}' where id = public.__t_id('s1') $$), 1::bigint, 'she can edit the policy');
reset role;
select is((select next_run_at from public.scheduled_runs where id = public.__t_id('s1')), public.scheduled_run_next('0 9 * * 6', 'America/Los_Angeles', now()), 'which leaves next_run_at where it was');
select is((select count(*)::int from public.audit_events where household_id = '0a000000-0000-4000-8000-00000000000a' and kind = 'policy_changed' and payload ->> 'scheduled_run_id' = public.__t_id('s1')::text and payload ->> 'change' = 'update'), 1, 'and logs the edit');

set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;
select is(public.__t_affected($$ update public.scheduled_runs set cron = '30 18 * * 5' where id = public.__t_id('s1') $$), 1::bigint, 'she moves the schedule to Friday 18:30');
reset role;
select is((select next_run_at from public.scheduled_runs where id = public.__t_id('s1')), public.scheduled_run_next('30 18 * * 5', 'America/Los_Angeles', now()), 'the server recomputes next_run_at from the new cron');

set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;
select is(public.__t_affected($$ update public.scheduled_runs set cron = '0 9 * * 6', tz = 'Asia/Kolkata' where id = public.__t_id('s1') $$), 1::bigint, 'and when she changes the zone');
reset role;
select is((select next_run_at from public.scheduled_runs where id = public.__t_id('s1')), public.scheduled_run_next('0 9 * * 6', 'Asia/Kolkata', now()), 'next_run_at follows the zone');

update public.scheduled_runs set tz = 'America/Los_Angeles', next_run_at = '2026-01-01 00:00+00' where id = public.__t_id('s1');
set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;
select is(public.__t_affected($$ update public.scheduled_runs set enabled = false where id = public.__t_id('s1') $$), 1::bigint, 'she switches the schedule off');
select is(public.__t_affected($$ update public.scheduled_runs set enabled = true where id = public.__t_id('s1') $$), 1::bigint, 'and on again');
reset role;
select ok((select next_run_at > now() from public.scheduled_runs where id = public.__t_id('s1')), 'switching it on skips the occasions missed while it was off');

-- At most ten schedules per household.
insert into public.scheduled_runs (household_id, cron, tz, connection_id)
select '0a000000-0000-4000-8000-00000000000a', '0 9 * * 6', 'America/Los_Angeles', '7a000000-0000-4000-8000-0000000000a1'
from generate_series(1, 9);
select throws_ok($$ insert into public.scheduled_runs (household_id, cron, tz, connection_id) values ('0a000000-0000-4000-8000-00000000000a', '0 9 * * 6', 'America/Los_Angeles', '7a000000-0000-4000-8000-0000000000a1') $$, 'P0001', 'too_many_schedules', 'a household has at most ten schedules');
delete from public.scheduled_runs where household_id = '0a000000-0000-4000-8000-00000000000a' and id <> public.__t_id('s1');

-- ---------------------------------------------------------------------------------------
-- enqueue_due_scheduled_runs, Saturday 2026-11-07 09:02 in Los Angeles (17:02 UTC)
-- ---------------------------------------------------------------------------------------

insert into __t_ids (name, id) values ('sB', gen_random_uuid()), ('sC', gen_random_uuid());
insert into public.scheduled_runs (id, household_id, cron, tz, connection_id, policy) values
  (public.__t_id('sB'), '0b000000-0000-4000-8000-00000000000b', '0 9 * * 6', 'America/Los_Angeles', '7b000000-0000-4000-8000-0000000000b1', '{"substitution": "any"}'),
  (public.__t_id('sC'), '0c000000-0000-4000-8000-00000000000c', '0 9 * * 6', 'America/Los_Angeles', '7c000000-0000-4000-8000-0000000000c1', '{}');
update public.scheduled_runs set cron = '0 9 * * 6', next_run_at = '2026-11-07 17:00+00', last_enqueued_for = null where id in (public.__t_id('s1'), public.__t_id('sB'), public.__t_id('sC'));

-- A schedule due later than now is left alone, and so is a disabled one.
insert into __t_ids (name, id) values ('sLater', gen_random_uuid()), ('sOff', gen_random_uuid());
insert into public.scheduled_runs (id, household_id, cron, tz, connection_id, enabled) values
  (public.__t_id('sLater'), '0c000000-0000-4000-8000-00000000000c', '0 9 * * 6', 'America/Los_Angeles', '7c000000-0000-4000-8000-0000000000c1', true),
  (public.__t_id('sOff'), '0c000000-0000-4000-8000-00000000000c', '0 9 * * 6', 'America/Los_Angeles', '7c000000-0000-4000-8000-0000000000c1', false);
update public.scheduled_runs set next_run_at = '2026-11-07 17:30+00' where id = public.__t_id('sLater');
update public.scheduled_runs set next_run_at = '2026-11-07 17:00+00' where id = public.__t_id('sOff');

set local request.jwt.claims = '{"role": "service_role"}';
set local role service_role;
insert into __t_ids (name, id) values ('first_call', gen_random_uuid());
create temp table __t_counts (name text primary key, n integer) on commit drop;
grant all on __t_counts to service_role;
insert into __t_counts (name, n) values ('first', public.enqueue_due_scheduled_runs('2026-11-07 17:02+00'));
reset role;

select is((select n from __t_counts where name = 'first'), 2, 'the scheduler enqueues one run for each of the two due schedules that have a list');
select is((select count(*)::int from public.shopping_runs where household_id = '0a000000-0000-4000-8000-00000000000a' and trigger = 'scheduled'), 1, 'household A got exactly one scheduled run');
select is((select count(*)::int from public.shopping_runs where household_id = '0b000000-0000-4000-8000-00000000000b' and trigger = 'scheduled'), 1, 'and household B one');
select is((select count(*)::int from public.shopping_runs where household_id = '0c000000-0000-4000-8000-00000000000c'), 0, 'household C, with no list, got none');
select is((select r.list_id from public.shopping_runs r where r.household_id = '0a000000-0000-4000-8000-00000000000a' and r.trigger = 'scheduled'), '9a000000-0000-4000-8000-0000000000a2'::uuid, 'A''s run shops its active list for the week of Monday 2026-11-09, not the week before''s or the ad hoc one');
select is((select r.list_id from public.shopping_runs r where r.household_id = '0b000000-0000-4000-8000-00000000000b' and r.trigger = 'scheduled'), '9b000000-0000-4000-8000-0000000000b2'::uuid, 'B''s run shops B''s own list');
select is((select r.status::text || '/' || r.retailer::text || '/' || coalesce(r.store_name, '') || '/' || coalesce(r.created_by::text, 'nobody') from public.shopping_runs r where r.household_id = '0a000000-0000-4000-8000-00000000000a' and r.trigger = 'scheduled'), 'queued/kroger/Mock QFC Duvall/nobody', 'the run is queued, at the schedule''s store, started by no person');
select is((select r.policy ->> 'budget_cap_usd' from public.shopping_runs r where r.household_id = '0a000000-0000-4000-8000-00000000000a' and r.trigger = 'scheduled'), '175', 'the run carries the schedule''s budget cap');
select is((select r.policy ->> 'substitution' from public.shopping_runs r where r.household_id = '0a000000-0000-4000-8000-00000000000a' and r.trigger = 'scheduled'), 'same_brand', 'and every key it did not set takes the default (editing the policy replaced the old one)');
select is((select r.policy ->> 'substitution' from public.shopping_runs r where r.household_id = '0b000000-0000-4000-8000-00000000000b' and r.trigger = 'scheduled'), 'any', 'B''s run carries B''s substitution level');
select is((select r.policy ->> 'auto_checkout' from public.shopping_runs r where r.household_id = '0a000000-0000-4000-8000-00000000000a' and r.trigger = 'scheduled'), 'false', 'a scheduled run never checks out by itself, whatever the schedule says');
select is((select r.policy ->> 'auto_checkout_cap_usd' from public.shopping_runs r where r.household_id = '0a000000-0000-4000-8000-00000000000a' and r.trigger = 'scheduled'), null, 'and has no auto-checkout cap');
select is((select count(*)::int from pgmq.q_shopping_run m where m.message ->> 'run_id' in (select r.id::text from public.shopping_runs r where r.household_id = '0a000000-0000-4000-8000-00000000000a' and r.trigger = 'scheduled')), 1, 'exactly one message is on the shopping_run queue for it');
select is((select m.message - 'run_id' from pgmq.q_shopping_run m where m.message ->> 'run_id' in (select r.id::text from public.shopping_runs r where r.household_id = '0a000000-0000-4000-8000-00000000000a' and r.trigger = 'scheduled')), '{}'::jsonb, 'the message is {"run_id"} and nothing else');
select is((select next_run_at from public.scheduled_runs where id = public.__t_id('s1')), '2026-11-14 17:00+00'::timestamptz, 'next_run_at moved to next Saturday, 9:00 in PST (17:00 UTC)');
select is((select last_enqueued_for from public.scheduled_runs where id = public.__t_id('s1')), '2026-11-07 17:00+00'::timestamptz, 'last_enqueued_for records the handled time');
select is((select next_run_at from public.scheduled_runs where id = public.__t_id('sLater')), '2026-11-07 17:30+00'::timestamptz, 'a schedule not yet due is untouched');
select is((select next_run_at from public.scheduled_runs where id = public.__t_id('sOff')), '2026-11-07 17:00+00'::timestamptz, 'and so is a disabled one');

-- Household C has no list for the week: a skipped schedule, not a failed run, and a notification.
select is((select count(*)::int from public.notification_outbox where household_id = '0c000000-0000-4000-8000-00000000000c' and type = 'schedule_skipped'), 1, 'household C is told its schedule was skipped');
select is((select payload ->> 'reason' from public.notification_outbox where household_id = '0c000000-0000-4000-8000-00000000000c' and type = 'schedule_skipped'), 'no_active_list', 'because it has no active list');
select is((select payload ->> 'weekStart' from public.notification_outbox where household_id = '0c000000-0000-4000-8000-00000000000c' and type = 'schedule_skipped'), '2026-11-09', 'for the week of 2026-11-09');
select is((select payload ->> 'scheduleId' from public.notification_outbox where household_id = '0c000000-0000-4000-8000-00000000000c' and type = 'schedule_skipped'), public.__t_id('sC')::text, 'and names the schedule, by id');
select is((select next_run_at from public.scheduled_runs where id = public.__t_id('sC')), '2026-11-14 17:00+00'::timestamptz, 'the skipped schedule still moves on to next week');
select is((select count(*)::int from public.notification_outbox where household_id in ('0a000000-0000-4000-8000-00000000000a', '0b000000-0000-4000-8000-00000000000b')), 0, 'households whose runs started get no skip notice');

-- The second call for the same due time does nothing.
set local request.jwt.claims = '{"role": "service_role"}';
set local role service_role;
insert into __t_counts (name, n) values ('second', public.enqueue_due_scheduled_runs('2026-11-07 17:02+00'));
reset role;
select is((select n from __t_counts where name = 'second'), 0, 'a second call inserts no run');
select is((select count(*)::int from public.shopping_runs where trigger = 'scheduled' and household_id in ('0a000000-0000-4000-8000-00000000000a', '0b000000-0000-4000-8000-00000000000b')), 2, 'the run count is unchanged');
select is((select count(*)::int from pgmq.q_shopping_run m where m.message ->> 'run_id' in (select r.id::text from public.shopping_runs r where r.trigger = 'scheduled' and r.household_id in ('0a000000-0000-4000-8000-00000000000a', '0b000000-0000-4000-8000-00000000000b'))), 2, 'and so is the queue');
select is((select count(*)::int from public.notification_outbox where type = 'schedule_skipped'), 1, 'and so is the outbox');

-- A replay of a handled value: next_run_at put back to last_enqueued_for.
update public.scheduled_runs set next_run_at = last_enqueued_for where id = public.__t_id('s1');
set local request.jwt.claims = '{"role": "service_role"}';
set local role service_role;
insert into __t_counts (name, n) values ('replay', public.enqueue_due_scheduled_runs('2026-11-07 17:03+00'));
reset role;
select is((select n from __t_counts where name = 'replay'), 0, 'a schedule whose next_run_at was already handled is refused (the idempotency guard)');
select is((select count(*)::int from public.shopping_runs where trigger = 'scheduled' and household_id = '0a000000-0000-4000-8000-00000000000a'), 1, 'so there is still one run');
update public.scheduled_runs set next_run_at = '2026-11-14 17:00+00' where id = public.__t_id('s1');

-- Each reason a schedule is skipped. One schedule per case, all of household A, run one at a time.
insert into __t_ids (name, id) values ('sTier3', gen_random_uuid()), ('sReauth', gen_random_uuid()), ('sBusy', gen_random_uuid()), ('sMissed', gen_random_uuid()), ('sShopped', gen_random_uuid());
insert into public.scheduled_runs (id, household_id, cron, tz, connection_id, enabled) values
  (public.__t_id('sTier3'), '0a000000-0000-4000-8000-00000000000a', '0 9 * * 6', 'America/Los_Angeles', '7a000000-0000-4000-8000-0000000000a3', true),
  (public.__t_id('sReauth'), '0a000000-0000-4000-8000-00000000000a', '0 9 * * 6', 'America/Los_Angeles', '7a000000-0000-4000-8000-0000000000a2', true),
  (public.__t_id('sBusy'), '0a000000-0000-4000-8000-00000000000a', '0 9 * * 6', 'America/Los_Angeles', '7a000000-0000-4000-8000-0000000000a1', true),
  (public.__t_id('sMissed'), '0a000000-0000-4000-8000-00000000000a', '0 9 * * 6', 'America/Los_Angeles', '7a000000-0000-4000-8000-0000000000a1', true),
  (public.__t_id('sShopped'), '0a000000-0000-4000-8000-00000000000a', '0 9 * * 6', 'America/Los_Angeles', '7a000000-0000-4000-8000-0000000000a1', true);
-- Parked far in the future until their turn: a schedule that is switched on or edited gets a new
-- next_run_at from the server, so the due times below are set in statements of their own.
update public.scheduled_runs set next_run_at = '2027-01-01 00:00+00' where id in (public.__t_id('sTier3'), public.__t_id('sReauth'), public.__t_id('sBusy'), public.__t_id('sMissed'), public.__t_id('sShopped'));
update public.scheduled_runs set next_run_at = '2026-11-07 17:00+00' where id = public.__t_id('sTier3');

set local request.jwt.claims = '{"role": "service_role"}';
set local role service_role;
insert into __t_counts (name, n) values ('tier3', public.enqueue_due_scheduled_runs('2026-11-07 17:02+00'));
reset role;
select is((select n from __t_counts where name = 'tier3'), 0, 'a Tier 3 store is not run unattended');
select is((select payload ->> 'reason' from public.notification_outbox where payload ->> 'scheduleId' = public.__t_id('sTier3')::text), 'tier3_unattended', 'and the household is told why');
select is((select count(*)::int from public.shopping_runs where connection_id = '7a000000-0000-4000-8000-0000000000a3'), 0, 'no run was made at the Tier 3 connection');

update public.scheduled_runs set next_run_at = '2026-11-07 17:00+00' where id = public.__t_id('sReauth');
set local request.jwt.claims = '{"role": "service_role"}';
set local role service_role;
insert into __t_counts (name, n) values ('reauth', public.enqueue_due_scheduled_runs('2026-11-07 17:02+00'));
reset role;
select is((select n from __t_counts where name = 'reauth'), 0, 'a connection that needs a new sign-in starts nothing');
select is((select payload ->> 'reason' from public.notification_outbox where payload ->> 'scheduleId' = public.__t_id('sReauth')::text), 'connection_inactive', 'and the household is told the connection is inactive');

update public.scheduled_runs set next_run_at = '2026-11-07 17:00+00' where id = public.__t_id('sBusy');
set local request.jwt.claims = '{"role": "service_role"}';
set local role service_role;
insert into __t_counts (name, n) values ('busy', public.enqueue_due_scheduled_runs('2026-11-07 17:02+00'));
reset role;
select is((select n from __t_counts where name = 'busy'), 0, 'a list that already has a run going is not started twice');
select is((select payload ->> 'reason' from public.notification_outbox where payload ->> 'scheduleId' = public.__t_id('sBusy')::text), 'run_in_progress', 'and the household is told a run is in progress');

update public.scheduled_runs set next_run_at = '2026-11-07 09:00+00' where id = public.__t_id('sMissed');
set local request.jwt.claims = '{"role": "service_role"}';
set local role service_role;
insert into __t_counts (name, n) values ('missed', public.enqueue_due_scheduled_runs('2026-11-07 17:02+00'));
reset role;
select is((select n from __t_counts where name = 'missed'), 0, 'a schedule found eight hours late is not run');
select is((select payload ->> 'reason' from public.notification_outbox where payload ->> 'scheduleId' = public.__t_id('sMissed')::text), 'missed', 'it is reported as missed');
select is((select next_run_at from public.scheduled_runs where id = public.__t_id('sMissed')), '2026-11-14 17:00+00'::timestamptz, 'and moves on to the next Saturday');

-- A list that already has a cart is not shopped again (the store cart is add-only): skipped quietly.
update public.shopping_runs set status = 'running' where household_id = '0a000000-0000-4000-8000-00000000000a' and trigger = 'scheduled';
update public.shopping_runs set status = 'cart_ready' where household_id = '0a000000-0000-4000-8000-00000000000a' and trigger = 'scheduled';
update public.scheduled_runs set next_run_at = '2026-11-07 17:00+00' where id = public.__t_id('sShopped');
set local request.jwt.claims = '{"role": "service_role"}';
set local role service_role;
insert into __t_counts (name, n) values ('shopped', public.enqueue_due_scheduled_runs('2026-11-07 17:02+00'));
reset role;
select is((select n from __t_counts where name = 'shopped'), 0, 'a list whose cart is already filled starts no second run');
select is((select count(*)::int from public.notification_outbox where payload ->> 'scheduleId' = public.__t_id('sShopped')::text), 0, 'and says nothing: there is nothing for the household to do');
select is((select next_run_at from public.scheduled_runs where id = public.__t_id('sShopped')), '2026-11-14 17:00+00'::timestamptz, 'but it still moves on');

-- The skip notice is written once per handled time, even if the outbox is asked twice.
select is(public.notification_outbox_add('0c000000-0000-4000-8000-00000000000c', 'schedule_skipped', '{}', now(), 'schedule_skipped:' || public.__t_id('sC') || ':' || extract(epoch from '2026-11-07 17:00+00'::timestamptz)::bigint), null, 'the outbox refuses a second row with the same dedupe key');

-- One schedule failing does not stop the others. B has hit the daily limit (20 runs in a day, here
-- cancelled ones) and is skipped; C now has a list for the week and gets its run in the same call.
update public.shopping_runs set status = 'cancelled' where household_id = '0b000000-0000-4000-8000-00000000000b' and status = 'queued';
insert into public.shopping_runs (household_id, list_id, connection_id, retailer, status)
select '0b000000-0000-4000-8000-00000000000b', '9b000000-0000-4000-8000-0000000000b2', '7b000000-0000-4000-8000-0000000000b1', 'kroger', 'cancelled'
from generate_series(1, 20);
update public.grocery_lists set status = 'active' where id = '9c000000-0000-4000-8000-0000000000c2';
update public.scheduled_runs set next_run_at = '2026-11-07 17:00+00', last_enqueued_for = null where id in (public.__t_id('sB'), public.__t_id('sC'));
set local request.jwt.claims = '{"role": "service_role"}';
set local role service_role;
insert into __t_counts (name, n) values ('limit', public.enqueue_due_scheduled_runs('2026-11-07 17:02+00'));
reset role;
select is((select n from __t_counts where name = 'limit'), 1, 'the call counts the one run it enqueued');
select is((select count(*)::int from public.notification_outbox where payload ->> 'scheduleId' = public.__t_id('sB')::text and payload ->> 'reason' = 'daily_run_limit'), 1, 'B is told it hit the daily run limit');
select is((select count(*)::int from public.shopping_runs where household_id = '0c000000-0000-4000-8000-00000000000c' and trigger = 'scheduled'), 1, 'and C''s schedule ran in the same call');

-- ---------------------------------------------------------------------------------------
-- notification_preferences
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;
select lives_ok($$ select public.set_notification_preference('items_need_review', false) $$, 'alice turns off "items need review"');
select throws_ok($$ insert into public.notification_preferences (user_id, type, enabled) values ('a1111111-1111-4111-8111-111111111111', 'cart_ready', false) $$, '42501', null, 'she cannot write the table directly');
select is((select count(*)::int from public.notification_preferences), 1, 'she reads her own preference');
select lives_ok($$ select public.set_notification_preference('items_need_review', true) $$, 'she turns it back on');
select is((select enabled from public.notification_preferences where type = 'items_need_review'), true, 'the same row is updated');
select lives_ok($$ select public.set_notification_preference('items_need_review', false) $$, 'and off again');
reset role;

set local request.jwt.claims = '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.notification_preferences), 0, 'carol, in the same household, does not read alice''s preferences');
select lives_ok($$ select public.set_notification_preference('weekly_nudge', false) $$, 'carol sets her own');
reset role;
select is((select count(*)::int from public.notification_preferences where user_id = 'a1111111-1111-4111-8111-111111111111' and type = 'items_need_review' and enabled = false), 1, 'alice''s stays off for alice only');
select is((select count(*)::int from public.notification_preferences where user_id = 'c3333333-3333-4333-8333-333333333333' and type = 'items_need_review'), 0, 'and carol has no row for it, which means on');

set local role anon;
select throws_ok($$ select public.set_notification_preference('cart_ready', false) $$, '42501', null, 'anon cannot set a preference');
reset role;
set local request.jwt.claims = '{"role": "service_role"}';
select throws_ok($$ select public.set_notification_preference('cart_ready', false) $$, 'P0001', 'not_authenticated', 'with no person behind the call it is refused');

-- ---------------------------------------------------------------------------------------
-- Device tokens
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;
select lives_ok($$ select public.register_push_token('ExponentPushToken[ws11-phone]', 'ios') $$, 'alice registers her phone');
select throws_ok($$ select public.register_push_token('not-a-token', 'ios') $$, 'P0001', 'invalid_token', 'a string that is not an Expo token is refused');
reset role;
update public.push_tokens set updated_at = now() - interval '2 days' where token = 'ExponentPushToken[ws11-phone]';
set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;
select lives_ok($$ select public.register_push_token('ExponentPushToken[ws11-phone]', 'android') $$, 'the next launch registers it again');
select is((select count(*)::int from public.push_tokens where token = 'ExponentPushToken[ws11-phone]'), 1, 'without a second row');
select ok((select updated_at > now() - interval '1 minute' from public.push_tokens where token = 'ExponentPushToken[ws11-phone]'), 'but with a fresh updated_at');
select is((select platform::text from public.push_tokens where token = 'ExponentPushToken[ws11-phone]'), 'android', 'and the platform it reports now');
reset role;

-- The phone changes hands: carol signs in on it, and it stops belonging to alice.
set local request.jwt.claims = '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}';
set local role authenticated;
select lives_ok($$ select public.register_push_token('ExponentPushToken[ws11-phone]', 'ios') $$, 'carol signs in on the same phone');
reset role;
select is((select array_agg(user_id::text) from public.push_tokens where token = 'ExponentPushToken[ws11-phone]'), array['c3333333-3333-4333-8333-333333333333'], 'the phone is carol''s now; alice''s row is gone');

-- A person keeps 20 devices at most; the oldest go.
insert into public.push_tokens (user_id, token, platform, updated_at)
select 'a1111111-1111-4111-8111-111111111111', 'ExponentPushToken[ws11-old-' || i || ']', 'ios', now() - make_interval(mins => i)
from generate_series(1, 20) as i;
set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;
select lives_ok($$ select public.register_push_token('ExponentPushToken[ws11-newest]', 'ios') $$, 'alice registers a 21st device');
select is((select count(*)::int from public.push_tokens), 20, 'she still has 20');
select is((select count(*)::int from public.push_tokens where token = 'ExponentPushToken[ws11-old-20]'), 0, 'the oldest one is the one that went');
reset role;

-- No session at all: the app forgets its token by value.
set local request.jwt.claims = '{"role": "anon"}';
set local role anon;
select lives_ok($$ select public.forget_push_token('ExponentPushToken[ws11-phone]') $$, 'with no session the app can still forget a device by its token');
select lives_ok($$ select public.forget_push_token('ExponentPushToken[nobody-has-this]') $$, 'forgetting a token that is not there is not an error');
select throws_ok($$ select 1 from public.push_tokens $$, '42501', null, 'anon cannot read the table');
reset role;
select is((select count(*)::int from public.push_tokens where token = 'ExponentPushToken[ws11-phone]'), 0, 'and the phone''s row is gone');
select is((select count(*)::int from public.push_tokens where token like 'ExponentPushToken[ws11-%'), 20, 'while every other token stays');

-- ---------------------------------------------------------------------------------------
-- The outbox: weekly nudge, failed run, slow import, pickup reminder
-- ---------------------------------------------------------------------------------------

-- Thursday 2026-11-05: A planned the week of 11-02, nothing yet for 11-09. B planned 11-09. C never
-- planned the weeks before. 16:30 in Los Angeles is before the nudge time; 17:30 is after it.
set local request.jwt.claims = '{"role": "service_role"}';
set local role service_role;
insert into __t_counts (name, n) values ('nudge_early', public.enqueue_weekly_nudges(4, '17:00', '2026-11-06 00:30+00'));
insert into __t_counts (name, n) values ('nudge_late', public.enqueue_weekly_nudges(4, '17:00', '2026-11-06 01:30+00'));
insert into __t_counts (name, n) values ('nudge_again', public.enqueue_weekly_nudges(4, '17:00', '2026-11-06 20:00+00'));
select is((select count(*)::int from public.notification_outbox where type = 'weekly_nudge'), 1, 'the service role reads the outbox');
reset role;
select is((select n from __t_counts where name = 'nudge_early'), 0, 'no nudge before Thursday 17:00 in the household''s zone');
select is((select n from __t_counts where name = 'nudge_late'), 1, 'one nudge after it');
select is((select count(*)::int from public.notification_outbox where type = 'weekly_nudge' and household_id = '0a000000-0000-4000-8000-00000000000a'), 1, 'for household A, which plans but has nothing for next week');
select is((select payload ->> 'weekStart' from public.notification_outbox where type = 'weekly_nudge' and household_id = '0a000000-0000-4000-8000-00000000000a'), '2026-11-09', 'naming next week');
select is((select count(*)::int from public.notification_outbox where type = 'weekly_nudge' and household_id <> '0a000000-0000-4000-8000-00000000000a'), 0, 'not for B, which planned next week, nor for C, which never planned');
select is((select n from __t_counts where name = 'nudge_again'), 0, 'and once per week: a later run the same week adds none');

-- A failed run is written once; a cancelled one is not.
update public.shopping_runs set status = 'failed', error = 'connection_failed' where household_id = '0c000000-0000-4000-8000-00000000000c' and trigger = 'scheduled';
select is((select count(*)::int from public.notification_outbox where type = 'run_failed' and household_id = '0c000000-0000-4000-8000-00000000000c'), 1, 'a run that fails writes a run_failed notice');
select is((select payload ->> 'scheduled' from public.notification_outbox where type = 'run_failed' and household_id = '0c000000-0000-4000-8000-00000000000c'), 'true', 'saying it was a scheduled run');
select is((select payload ?& array['type', 'runId', 'scheduled'] and not (payload ? 'error') from public.notification_outbox where type = 'run_failed' and household_id = '0c000000-0000-4000-8000-00000000000c'), true, 'and carrying ids only, never the error text');
select is((select count(*)::int from public.notification_outbox where type = 'run_failed' and household_id = '0b000000-0000-4000-8000-00000000000b'), 0, 'B''s cancelled runs write none');

-- A slow import writes one notice; a quick one writes none.
insert into __t_ids (name, id) values ('slowImport', gen_random_uuid()), ('quickImport', gen_random_uuid());
insert into public.import_jobs (id, household_id, kind, status, created_at) values
  (public.__t_id('slowImport'), '0a000000-0000-4000-8000-00000000000a', 'photo', 'running', now() - interval '2 minutes'),
  (public.__t_id('quickImport'), '0a000000-0000-4000-8000-00000000000a', 'url', 'running', now() - interval '3 seconds');
update public.import_jobs set status = 'done', finished_at = now() where id in (public.__t_id('slowImport'), public.__t_id('quickImport'));
select is((select count(*)::int from public.notification_outbox where type = 'import_finished'), 1, 'an import that took two minutes writes a notice');
select is((select payload ->> 'importJobId' from public.notification_outbox where type = 'import_finished'), public.__t_id('slowImport')::text, 'for that job and no other');

-- Pickup reminders read WS12's orders table, which may not exist here yet. Either way it runs.
set local request.jwt.claims = '{"role": "service_role"}';
set local role service_role;
select lives_ok($$ select public.enqueue_pickup_reminders() $$, 'the pickup reminder generator runs, with or without an orders table');
select lives_ok($$ select public.enqueue_notification_generators() $$, 'and so do both generators together');
reset role;
select is(public.notification_outbox_prune(interval '14 days'), 0, 'nothing in the outbox is old enough to prune');
update public.notification_outbox set sent_at = now() - interval '15 days' where type = 'run_failed';
select is(public.notification_outbox_prune(interval '14 days'), 1, 'a row sent over 14 days ago is pruned');

-- ---------------------------------------------------------------------------------------
-- WS09 follow-up: the lower bound of the review timeout. A review left 47 hours is kept; one left
-- 49 hours is cancelled. now() does not move inside this test, so each age is set explicitly.
-- ---------------------------------------------------------------------------------------

insert into __t_ids (name, id) values ('review47', gen_random_uuid()), ('review49', gen_random_uuid());
insert into public.shopping_runs (id, household_id, list_id, connection_id, retailer, status) values
  (public.__t_id('review47'), '0a000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-0000000000a1', '7a000000-0000-4000-8000-0000000000a1', 'kroger', 'needs_review'),
  (public.__t_id('review49'), '0a000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-0000000000a4', '7a000000-0000-4000-8000-0000000000a1', 'kroger', 'needs_review');
update public.shopping_runs set status_changed_at = now() - interval '47 hours' where id = public.__t_id('review47');
update public.shopping_runs set status_changed_at = now() - interval '49 hours' where id = public.__t_id('review49');
select lives_ok($$ select public.shopping_runs_clear_expired() $$, 'retention runs with its default 48 hour review timeout');
select is((select status::text from public.shopping_runs where id = public.__t_id('review47')), 'needs_review', 'a review idle for 47 hours is kept');
select is((select status::text || '/' || coalesce(error, '') from public.shopping_runs where id = public.__t_id('review49')), 'cancelled/review timed out', 'a review idle for 49 hours is cancelled');
select lives_ok($$ select public.shopping_runs_clear_expired(interval '24 hours', interval '46 hours') $$, 'with a 46 hour timeout');
select is((select status::text from public.shopping_runs where id = public.__t_id('review47')), 'cancelled', 'the 47 hour review is cancelled too, so the bound is the argument, not now()');

select * from finish();
rollback;
