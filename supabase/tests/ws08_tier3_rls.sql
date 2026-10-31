-- WS08: pgTAP tests for the Tier 3 migration (20261031110000_ws08_tier3.sql). Run with
-- `supabase test db`. Everything happens inside one transaction that is rolled back. Counts are
-- scoped to these fixtures: `db reset` also seeds the catalog and the ontology.
--
-- What it proves:
--   * households.tier3_consent is readable by members and writable by nobody on the client;
--     record_tier3_consent checks membership and merges retailers as a union
--   * a browser_session connection is created only after consent, and its session key comes back
--     the same on every call for the connection's own member and for nobody else; authenticated
--     cannot read Vault at all
--   * revoke_browser_connection deletes the key and marks the row revoked
--   * run-screenshots is private: a member of household A cannot list or read household B's run
--     prefix, clients cannot write, the service role can; objects expire after 30 days
--   * household_ai_spend_since (llm-proxy's daily cap) sums one household's spend
--
-- Cast (fixed ids, matching the other test files):
--   alice  owns household A       carol  is a plain member of A
--   bob    owns household B       dave   belongs to no household

begin;

select plan(68);

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

-- Runs for the screenshot prefixes. WS09's shopping_runs when it has landed (a run needs a list),
-- otherwise a stand-in with the two columns the policy reads.
do $$
begin
  if to_regclass('public.shopping_runs') is null then
    create table public.shopping_runs (
      id uuid primary key,
      household_id uuid not null references public.households (id)
    );
    insert into public.shopping_runs (id, household_id) values
      ('5a000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a'),
      ('5b000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b');
  else
    insert into public.grocery_lists (id, household_id, name) values
      ('6a000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', 'ws08 list A'),
      ('6b000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b', 'ws08 list B');
    insert into public.shopping_runs (id, household_id, list_id, retailer) values
      ('5a000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a',
       '6a000000-0000-4000-8000-0000000000a1', 'safeway'),
      ('5b000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b',
       '6b000000-0000-4000-8000-0000000000b1', 'safeway');
  end if;
end;
$$;

-- 001 of run A is past the 30-day lifecycle, 002 is not.
insert into storage.objects (bucket_id, name, created_at) values
  ('run-screenshots', '5a000000-0000-4000-8000-0000000000a1/001.jpg', now() - interval '31 days'),
  ('run-screenshots', '5a000000-0000-4000-8000-0000000000a1/002.jpg', now() - interval '29 days'),
  ('run-screenshots', '5b000000-0000-4000-8000-0000000000b1/001.jpg', now()),
  ('run-screenshots', '5c000000-0000-4000-8000-0000000000c1/001.jpg', now()),
  ('run-screenshots', 'loose.jpg', now());

-- Ids the functions create, shared between steps that run as different roles.
create temp table __t_ws08 (k text primary key, v text) on commit drop;
grant select, insert, update on __t_ws08 to authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------

select ok(exists (
  select 1 from information_schema.columns
  where table_schema = 'public' and table_name = 'households' and column_name = 'tier3_consent'
    and data_type = 'jsonb'
), 'households.tier3_consent is a jsonb column');
select column_privs_are('public', 'households', 'tier3_consent', 'authenticated', array['SELECT'], 'authenticated may read tier3_consent and nothing else');
select column_privs_are('public', 'households', 'tier3_consent', 'anon', array[]::text[], 'anon has no privilege on tier3_consent');
select throws_ok($$update public.households set tier3_consent = '{"retailers": ["safeway"]}' where id = '0a000000-0000-4000-8000-00000000000a'$$, '23514', null::text, 'the shape check refuses a consent without accepted_at, by_user_id and copy_version');
select throws_ok($$update public.households set tier3_consent = jsonb_build_object('accepted_at', '2026-10-31T00:00:00Z', 'by_user_id', 'a1111111-1111-4111-8111-111111111111', 'retailers', jsonb_build_array('instacart'), 'copy_version', '2026-10-31') where id = '0a000000-0000-4000-8000-00000000000a'$$, '23514', null::text, 'the shape check refuses a retailer that is not Tier 3');
select ok((select bool_and(p.prosecdef) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('record_tier3_consent', 'connect_browser_session', 'connection_session_key', 'revoke_browser_connection')), 'the four client functions are security definer');
select ok(has_function_privilege('authenticated', 'public.record_tier3_consent(uuid, text[], text)', 'EXECUTE'), 'authenticated may call record_tier3_consent');
select ok(not has_function_privilege('anon', 'public.connection_session_key(uuid)', 'EXECUTE'), 'anon may not call connection_session_key');
select ok(not has_function_privilege('authenticated', 'public.household_ai_spend_since(uuid, timestamptz)', 'EXECUTE'), 'household_ai_spend_since is service role only');
select ok(not has_function_privilege('authenticated', 'public.expire_run_screenshots()', 'EXECUTE'), 'expire_run_screenshots is service role only');

select is(public.tier3_consent_version(), '2026-10-31', 'the current consent copy version is consent.ts''s CONSENT_VERSION');
select is((select public from storage.buckets where id = 'run-screenshots'), false, 'the run-screenshots bucket is private');
select is((select allowed_mime_types from storage.buckets where id = 'run-screenshots'), array['image/jpeg']::text[], 'run-screenshots takes JPEG only');
select is((select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'run-screenshots:%'), 3, 'run-screenshots has a member read policy and service role write and delete policies');
select is((select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'run-screenshots:%' and roles @> array['authenticated']::name[] and cmd <> 'SELECT'), 0, 'no client may write or delete screenshots');

-- ---------------------------------------------------------------------------------------
-- record_tier3_consent
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}';
set local role authenticated;

select lives_ok($$select public.record_tier3_consent('0a000000-0000-4000-8000-00000000000a', array['safeway'], '2026-10-31')$$, 'a plain member records consent for safeway');
select is((select tier3_consent -> 'retailers' from public.households where id = '0a000000-0000-4000-8000-00000000000a'), '["safeway"]'::jsonb, 'members read the stored consent');
select is((select tier3_consent ->> 'by_user_id' from public.households where id = '0a000000-0000-4000-8000-00000000000a'), 'c3333333-3333-4333-8333-333333333333', 'by_user_id is the member who accepted');
select throws_ok($$update public.households set tier3_consent = null where id = '0a000000-0000-4000-8000-00000000000a'$$, '42501', null::text, 'a member cannot write tier3_consent directly');

reset role;
set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;

select throws_ok($$update public.households set tier3_consent = null where id = '0a000000-0000-4000-8000-00000000000a'$$, '42501', null::text, 'not even an owner can write tier3_consent directly');
select is(
  public.record_tier3_consent('0a000000-0000-4000-8000-00000000000a', array['costco'], '2026-10-31') -> 'retailers',
  '["costco", "safeway"]'::jsonb,
  'a second retailer is merged in: the stored list is the union'
);
select is((select tier3_consent ->> 'copy_version' from public.households where id = '0a000000-0000-4000-8000-00000000000a'), '2026-10-31', 'copy_version is the version accepted');
select is(
  public.record_tier3_consent('0a000000-0000-4000-8000-00000000000a', array['safeway', 'safeway'], '2026-11-15') -> 'retailers',
  '["safeway"]'::jsonb,
  'another copy version replaces the list with only the retailers just accepted, without duplicates'
);
select is((select tier3_consent ->> 'copy_version' from public.households where id = '0a000000-0000-4000-8000-00000000000a'), '2026-11-15', 'the newer copy version is stored');
select throws_ok($$select public.connect_browser_session('0a000000-0000-4000-8000-00000000000a', 'safeway')$$, '42501', 'stale_consent', 'no browser connection while the consent is at another copy version than the current one');
select is(
  public.record_tier3_consent('0a000000-0000-4000-8000-00000000000a', array['safeway'], '2026-10-31') -> 'retailers',
  '["safeway"]'::jsonb,
  'consent at the current version again replaces the list again, for the steps below'
);
select throws_ok($$select public.record_tier3_consent('0a000000-0000-4000-8000-00000000000a', array['kroger'], '2026-10-31')$$, '22023', 'invalid_retailers', 'kroger is not a Tier 3 retailer');
select throws_ok($$select public.record_tier3_consent('0a000000-0000-4000-8000-00000000000a', array[]::text[], '2026-10-31')$$, '22023', 'invalid_retailers', 'an empty retailer list is refused');
select throws_ok($$select public.record_tier3_consent('0a000000-0000-4000-8000-00000000000a', array['safeway'], 'v 1; drop')$$, '22023', 'invalid_copy_version', 'a malformed copy version is refused');
select is((select count(*)::int from public.audit_events where household_id = '0a000000-0000-4000-8000-00000000000a' and kind = 'consent_given'), 4, 'every acceptance is audited');

reset role;
set local request.jwt.claims = '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}';
set local role authenticated;

select throws_ok($$select public.record_tier3_consent('0a000000-0000-4000-8000-00000000000a', array['safeway'], '2026-10-31')$$, '42501', 'not_a_member', 'a member of another household cannot record consent for A');
select is((select count(*)::int from public.households where id = '0a000000-0000-4000-8000-00000000000a'), 0, 'bob cannot read household A at all');

reset role;
set local request.jwt.claims = '{"sub": "d4444444-4444-4444-8444-444444444444", "role": "authenticated"}';
set local role authenticated;

select throws_ok($$select public.record_tier3_consent('0a000000-0000-4000-8000-00000000000a', array['safeway'], '2026-10-31')$$, '42501', 'not_a_member', 'a user with no household cannot record consent');

-- ---------------------------------------------------------------------------------------
-- connect_browser_session and connection_session_key
-- ---------------------------------------------------------------------------------------

reset role;
set local request.jwt.claims = '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}';
set local role authenticated;

select throws_ok($$select public.connect_browser_session('0b000000-0000-4000-8000-00000000000b', 'costco')$$, '42501', 'consent_required', 'no browser connection before the household consents');
select throws_ok($$select public.connect_browser_session('0a000000-0000-4000-8000-00000000000a', 'safeway')$$, '42501', 'not_a_member', 'no browser connection in another household');

reset role;
set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;

select throws_ok($$select public.connect_browser_session('0a000000-0000-4000-8000-00000000000a', 'kroger')$$, '22023', 'not_a_tier3_retailer', 'kroger is never a browser session');
insert into __t_ws08 values ('alice_conn', public.connect_browser_session('0a000000-0000-4000-8000-00000000000a', 'safeway')::text);
select is((select auth_type::text || '/' || status::text from public.retailer_connections where id = (select v from __t_ws08 where k = 'alice_conn')::uuid), 'browser_session/active', 'the connection is a browser session and active');
insert into __t_ws08 values ('key1', public.connection_session_key((select v from __t_ws08 where k = 'alice_conn')::uuid));
select is(char_length((select v from __t_ws08 where k = 'key1')), 44, 'the session key is 32 random bytes in base64');
select is(public.connection_session_key((select v from __t_ws08 where k = 'alice_conn')::uuid), (select v from __t_ws08 where k = 'key1'), 'the owning user gets the same key on a second call');
select is(public.connect_browser_session('0a000000-0000-4000-8000-00000000000a', 'safeway')::text, (select v from __t_ws08 where k = 'alice_conn'), 'connecting again reuses the row');
select is(public.connection_session_key((select v from __t_ws08 where k = 'alice_conn')::uuid), (select v from __t_ws08 where k = 'key1'), 'and keeps the key, so the session on the phone stays readable');
select throws_ok($$select 1 from vault.decrypted_secrets$$, '42501', null::text, 'authenticated cannot select from vault.decrypted_secrets');
select throws_ok($$select 1 from vault.secrets$$, '42501', null::text, 'authenticated cannot select from vault.secrets');

reset role;
set local request.jwt.claims = '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}';
set local role authenticated;

select throws_ok($$select public.connection_session_key((select v from __t_ws08 where k = 'alice_conn')::uuid)$$, '42501', 'not_allowed', 'another member of the same household cannot fetch the key');
select throws_ok($$select public.revoke_browser_connection((select v from __t_ws08 where k = 'alice_conn')::uuid)$$, '42501', 'not_allowed', 'another member of the same household cannot revoke it');

reset role;
set local request.jwt.claims = '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}';
set local role authenticated;

select throws_ok($$select public.connection_session_key((select v from __t_ws08 where k = 'alice_conn')::uuid)$$, '42501', 'not_allowed', 'a member of another household cannot fetch the key');

-- ---------------------------------------------------------------------------------------
-- revoke_browser_connection
-- ---------------------------------------------------------------------------------------

reset role;
insert into __t_ws08 values ('alice_secret', (select vault_secret_id::text from public.retailer_connections where id = (select v from __t_ws08 where k = 'alice_conn')::uuid));
select is((select decrypted_secret from vault.decrypted_secrets where id = (select v from __t_ws08 where k = 'alice_secret')::uuid), (select v from __t_ws08 where k = 'key1'), 'the key is in Vault and nowhere else');

set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;

select lives_ok($$select public.revoke_browser_connection((select v from __t_ws08 where k = 'alice_conn')::uuid)$$, 'the owning user disconnects');
select is((select status::text from public.retailer_connections where id = (select v from __t_ws08 where k = 'alice_conn')::uuid), 'revoked', 'the connection is revoked');
select throws_ok($$select public.connection_session_key((select v from __t_ws08 where k = 'alice_conn')::uuid)$$, '42501', 'connection_revoked', 'a revoked connection hands out no key');
select lives_ok($$select public.revoke_browser_connection((select v from __t_ws08 where k = 'alice_conn')::uuid)$$, 'revoking twice is a no-op');

reset role;
select is((select vault_secret_id from public.retailer_connections where id = (select v from __t_ws08 where k = 'alice_conn')::uuid), null, 'vault_secret_id is cleared');
select is((select count(*)::int from vault.secrets where id = (select v from __t_ws08 where k = 'alice_secret')::uuid), 0, 'the Vault secret is deleted');
select is((select count(*)::int from public.audit_events where household_id = '0a000000-0000-4000-8000-00000000000a' and kind = 'connection_revoked' and payload ->> 'connection_id' = (select v from __t_ws08 where k = 'alice_conn')), 1, 'the disconnect is audited once');

set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;

select is(public.connect_browser_session('0a000000-0000-4000-8000-00000000000a', 'safeway')::text, (select v from __t_ws08 where k = 'alice_conn'), 'connecting after a disconnect re-activates the same row');
select isnt(public.connection_session_key((select v from __t_ws08 where k = 'alice_conn')::uuid), (select v from __t_ws08 where k = 'key1'), 'with a new key: the old phone blob stays unreadable');

-- ---------------------------------------------------------------------------------------
-- run-screenshots
-- ---------------------------------------------------------------------------------------

select is((select count(*)::int from storage.objects where bucket_id = 'run-screenshots'), 2, 'alice sees the two screenshots of her household''s run');
select is_empty($$select 1 from storage.objects where bucket_id = 'run-screenshots' and name like '5b000000-0000-4000-8000-0000000000b1/%'$$, 'alice cannot list household B''s run prefix');
select is_empty($$select 1 from storage.objects where bucket_id = 'run-screenshots' and name = '5b000000-0000-4000-8000-0000000000b1/001.jpg'$$, 'alice cannot read household B''s screenshot');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('run-screenshots', '5a000000-0000-4000-8000-0000000000a1/003.jpg')$$, '42501', null::text, 'a member cannot upload a screenshot, even under their own run');

reset role;
set local request.jwt.claims = '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}';
set local role authenticated;

select is((select array_agg(name order by name) from storage.objects where bucket_id = 'run-screenshots'), array['5b000000-0000-4000-8000-0000000000b1/001.jpg']::text[], 'bob sees only his household''s run');

reset role;
set local request.jwt.claims = '{"sub": "d4444444-4444-4444-8444-444444444444", "role": "authenticated"}';
set local role authenticated;

select is_empty($$select 1 from storage.objects where bucket_id = 'run-screenshots'$$, 'a user with no household sees no screenshots');

reset role;
set local request.jwt.claims = '{"role": "service_role"}';
set local role service_role;

select lives_ok($$insert into storage.objects (bucket_id, name) values ('run-screenshots', '5a000000-0000-4000-8000-0000000000a1/003.jpg')$$, 'the service role can insert a screenshot');

reset role;

-- The lifecycle rule: 30 days, run daily, and it removes only what is older.
select is(public.run_screenshots_max_age(), interval '30 days', 'the bucket''s lifecycle rule is 30 days');
select is((select schedule || ' ' || command from cron.job where jobname = 'run-screenshots-lifecycle'), '17 4 * * * select public.expire_run_screenshots()', 'the lifecycle job runs daily');
select is(public.expire_run_screenshots(), 1, 'one screenshot is past 30 days');
select is((select array_agg(name order by name) from storage.objects where bucket_id = 'run-screenshots' and name like '5a000000-%'), array['5a000000-0000-4000-8000-0000000000a1/002.jpg', '5a000000-0000-4000-8000-0000000000a1/003.jpg']::text[], 'newer screenshots stay');

-- ---------------------------------------------------------------------------------------
-- household_ai_spend_since (llm-proxy's daily cap)
-- ---------------------------------------------------------------------------------------

insert into public.ai_runs (household_id, kind, model, cost_usd, ok, created_at) values
  ('0a000000-0000-4000-8000-00000000000a', 'agent_step', 'claude-sonnet-5-5', 0.25, true, now()),
  ('0a000000-0000-4000-8000-00000000000a', 'agent_step', 'claude-sonnet-5-5', 0.5, true, now()),
  ('0a000000-0000-4000-8000-00000000000a', 'agent_step', 'claude-sonnet-5-5', 9, true, now() - interval '2 days'),
  ('0b000000-0000-4000-8000-00000000000b', 'agent_step', 'claude-sonnet-5-5', 7, true, now());
select is(public.household_ai_spend_since('0a000000-0000-4000-8000-00000000000a', now() - interval '1 hour'), 0.75::numeric, 'today''s spend sums one household''s rows only');

select * from finish();

rollback;
