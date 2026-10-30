-- WS07: pgTAP tests for retailer_connections, product_matches, retailer_quota_usage, and the
-- Vault-backed connection functions. Run with `supabase test db`. Everything happens inside one
-- transaction that is rolled back.
--
-- What it proves:
--   * a member of household A reads nothing of household B in either household-scoped table
--   * vault_secret_id is never readable by anon or authenticated, and no client can reach Vault,
--     the connection functions, or the quota table
--   * product_matches has no column for what a product costs or whether it is in stock
--   * saving a connection stores the refresh token in Vault and nowhere else; rotating replaces
--     it in place; disconnecting deletes the secret and sets status = 'revoked'
--   * the quota counter stops at its ceiling
--
-- Cast (fixed ids, matching the other test files):
--   alice  owns household A       carol  is a plain member of A
--   bob    owns household B       dave   belongs to no household

begin;

select plan(104);

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

insert into public.ingredients (id, name, category, default_unit) values
  ('11111111-0000-4000-8000-000000000007', 'ws07 test chicken thigh', 'meat', 'lb');

-- Connections are created the only way they can be: through the service-role function.
do $$
begin
  perform public.retailer_save_oauth_connection(
    '0a000000-0000-4000-8000-00000000000a', 'a1111111-1111-4111-8111-111111111111', 'kroger',
    'alice-refresh-token-1', '70500999', 'QFC Fixture Ridge', 'pickup'
  );
  perform public.retailer_save_oauth_connection(
    '0a000000-0000-4000-8000-00000000000a', 'c3333333-3333-4333-8333-333333333333', 'kroger',
    'carol-refresh-token-1'
  );
  perform public.retailer_save_oauth_connection(
    '0b000000-0000-4000-8000-00000000000b', 'b2222222-2222-4222-8222-222222222222', 'kroger',
    'bob-refresh-token-1', '70100999', 'Fred Meyer Fixture Lake', 'delivery'
  );
end;
$$;

create temp table __t_conn on commit drop as
select c.user_id, c.id, c.vault_secret_id
from public.retailer_connections c;
grant select on __t_conn to authenticated, service_role;

create function public.__t_conn_id(p_user uuid) returns uuid
language sql stable as $$ select id from __t_conn where user_id = p_user $$;
grant execute on function public.__t_conn_id(uuid) to authenticated, anon, service_role;

insert into public.product_matches (
  id, household_id, retailer, store_id, ingredient_id, product_id, upc, product_name, size,
  confidence, chosen_by, pinned
) values
  ('e0000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', 'kroger',
   '70500999', '11111111-0000-4000-8000-000000000007', '0009990001001', '0009990001001',
   'Fixture Farms Boneless Skinless Chicken Thighs', 'per lb', 0.92, 'user', true),
  ('e0000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b', 'kroger',
   '70100999', '11111111-0000-4000-8000-000000000007', '0009990001002', '0009990001002',
   'Harborline Bone-In Chicken Thighs', '2.5 lb', 0.7, 'agent', false);

-- ---------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------

select ok(exists (select 1 from pg_extension where extname = 'supabase_vault'), 'the Vault extension is installed');
select ok((select relrowsecurity from pg_class where oid = 'public.retailer_connections'::regclass), 'retailer_connections has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.product_matches'::regclass), 'product_matches has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.retailer_quota_usage'::regclass), 'retailer_quota_usage has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.retailer_user_usage'::regclass), 'retailer_user_usage has RLS enabled');

select policies_are('public', 'retailer_connections', array['retailer_connections: members read', 'retailer_connections: holder or owner update'], 'retailer_connections has a read and an update policy, no client insert or delete');
select policies_are('public', 'product_matches', array['product_matches: members read', 'product_matches: members insert', 'product_matches: members update', 'product_matches: members delete'], 'product_matches has the household policies');
select policies_are('public', 'retailer_quota_usage', array[]::name[], 'retailer_quota_usage has no client policy at all');
select policies_are('public', 'retailer_user_usage', array[]::name[], 'retailer_user_usage has no client policy at all');

select is(
  (select count(*)::int from information_schema.columns
   where table_schema = 'public' and table_name = 'product_matches'
     and (column_name ilike '%price%' or column_name ilike '%stock%' or column_name ilike '%inventory%')),
  0,
  'product_matches has no price, stock, or inventory column'
);
select columns_are('public', 'product_matches', array[
  'id', 'household_id', 'retailer', 'store_id', 'ingredient_id', 'product_id', 'upc', 'product_name',
  'size', 'confidence', 'chosen_by', 'pinned', 'last_chosen_at', 'created_at', 'updated_at'
], 'product_matches holds ids, name, size, and bookkeeping only');
select fk_ok('public', 'households', 'default_connection_id', 'public', 'retailer_connections', 'id', 'households.default_connection_id references retailer_connections');

select ok(not has_column_privilege('authenticated', 'public.retailer_connections', 'vault_secret_id', 'SELECT'), 'authenticated has no SELECT on vault_secret_id');
select ok(not has_column_privilege('anon', 'public.retailer_connections', 'vault_secret_id', 'SELECT'), 'anon has no SELECT on vault_secret_id');
select ok(not has_column_privilege('authenticated', 'public.retailer_connections', 'vault_secret_id', 'UPDATE'), 'authenticated cannot write vault_secret_id');
select ok(not has_table_privilege('authenticated', 'public.retailer_quota_usage', 'SELECT'), 'authenticated cannot read the quota table');
select ok(not has_table_privilege('authenticated', 'public.retailer_user_usage', 'SELECT'), 'authenticated cannot read the per-member counts');

-- ---------------------------------------------------------------------------------------
-- Saving a connection (service-role function, run here as postgres)
-- ---------------------------------------------------------------------------------------

select is(
  (select auth_type::text || '/' || status::text from public.retailer_connections where id = public.__t_conn_id('a1111111-1111-4111-8111-111111111111')),
  'oauth/active',
  'a saved connection is oauth and active'
);
select isnt((select vault_secret_id from __t_conn where user_id = 'a1111111-1111-4111-8111-111111111111'), null, 'a saved connection has a Vault secret');
select is(
  (select decrypted_secret from vault.decrypted_secrets where id = (select vault_secret_id from __t_conn where user_id = 'a1111111-1111-4111-8111-111111111111')),
  'alice-refresh-token-1',
  'the refresh token is in Vault'
);
select is(
  (select count(*)::int from public.retailer_connections c where row_to_json(c)::text like '%refresh-token%'),
  0,
  'no token text appears in any retailer_connections row'
);
select is(
  (select store_id || ' ' || modality::text from public.retailer_connections where id = public.__t_conn_id('b2222222-2222-4222-8222-222222222222')),
  '70100999 delivery',
  'store and modality are saved with the connection'
);
select is(
  (select default_connection_id from public.households where id = '0a000000-0000-4000-8000-00000000000a'),
  public.__t_conn_id('a1111111-1111-4111-8111-111111111111'),
  'the first connection becomes the household default'
);
select is(
  (select count(*)::int from public.audit_events where kind = 'connection_added' and household_id = '0a000000-0000-4000-8000-00000000000a'),
  2,
  'each connection is audited'
);
select is(public.retailer_read_refresh_token(public.__t_conn_id('a1111111-1111-4111-8111-111111111111')), 'alice-refresh-token-1', 'the worker reads the refresh token back');

select lives_ok($$select public.retailer_rotate_refresh_token(public.__t_conn_id('a1111111-1111-4111-8111-111111111111'), 'alice-refresh-token-2')$$, 'rotating the refresh token works');
select is(public.retailer_read_refresh_token(public.__t_conn_id('a1111111-1111-4111-8111-111111111111')), 'alice-refresh-token-2', 'rotation replaces the token');
select is(
  (select vault_secret_id from public.retailer_connections where id = public.__t_conn_id('a1111111-1111-4111-8111-111111111111')),
  (select vault_secret_id from __t_conn where user_id = 'a1111111-1111-4111-8111-111111111111'),
  'rotation keeps the same secret, so the old value is gone'
);
select is(
  (select count(*)::int from vault.secrets where name = 'retailer_connection:' || public.__t_conn_id('a1111111-1111-4111-8111-111111111111')::text),
  1,
  'one Vault secret per connection'
);

select is(
  public.retailer_save_oauth_connection('0a000000-0000-4000-8000-00000000000a', 'a1111111-1111-4111-8111-111111111111', 'kroger', 'alice-refresh-token-3'),
  public.__t_conn_id('a1111111-1111-4111-8111-111111111111'),
  'reconnecting reuses the connection row'
);
select is(
  (select store_id from public.retailer_connections where id = public.__t_conn_id('a1111111-1111-4111-8111-111111111111')),
  '70500999',
  'reconnecting without a store keeps the chosen store'
);
select is(public.retailer_read_refresh_token(public.__t_conn_id('a1111111-1111-4111-8111-111111111111')), 'alice-refresh-token-3', 'reconnecting stores the new token');

select throws_ok(
  $$select public.retailer_save_oauth_connection('0a000000-0000-4000-8000-00000000000a', 'd4444444-4444-4444-8444-444444444444', 'kroger', 'dave-refresh-token')$$,
  'P0001', 'not_a_member', 'a connection cannot be saved for someone outside the household'
);
select throws_ok(
  $$select public.retailer_save_oauth_connection('0a000000-0000-4000-8000-00000000000a', 'a1111111-1111-4111-8111-111111111111', 'kroger', '')$$,
  'P0001', 'invalid_token', 'an empty token is refused'
);

select lives_ok($$select public.retailer_mark_needs_reauth(public.__t_conn_id('b2222222-2222-4222-8222-222222222222'))$$, 'a connection can be flagged for reauth');
select is((select status::text from public.retailer_connections where id = public.__t_conn_id('b2222222-2222-4222-8222-222222222222')), 'needs_reauth', 'the flag shows in status');

-- ---------------------------------------------------------------------------------------
-- Signed out (anon) gets nothing
-- ---------------------------------------------------------------------------------------

set local role anon;

select throws_ok($$select count(*) from public.retailer_connections$$, '42501', null, 'anon cannot read retailer_connections');
select throws_ok($$select count(*) from public.product_matches$$, '42501', null, 'anon cannot read product_matches');
select throws_ok($$select count(*) from public.retailer_quota_usage$$, '42501', null, 'anon cannot read retailer_quota_usage');
select throws_ok($$select public.retailer_read_refresh_token('00000000-0000-4000-8000-000000000000')$$, '42501', 'permission denied for function retailer_read_refresh_token', 'anon cannot read tokens');

reset role;

-- ---------------------------------------------------------------------------------------
-- Alice (owner of A)
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;

select is((select count(*)::int from public.retailer_connections), 2, 'alice sees the two connections of household A');
select is_empty($$select id from public.retailer_connections where household_id = '0b000000-0000-4000-8000-00000000000b'$$, 'alice reads no connection of household B');
select lives_ok($$select id, store_id, store_name, modality, status, last_verified_at from public.retailer_connections$$, 'alice can read the connection columns the app needs');
select throws_ok($$select vault_secret_id from public.retailer_connections$$, '42501', null, 'alice cannot read vault_secret_id');
select throws_ok($$select * from public.retailer_connections$$, '42501', null, 'select * fails, because vault_secret_id is not granted');

select is(public.__t_affected($$update public.retailer_connections set store_id = '70500111', store_name = 'QFC Other' where user_id = 'c3333333-3333-4333-8333-333333333333'$$), 1::bigint, 'an owner can change the store on a member''s connection');
select is(public.__t_affected($$update public.retailer_connections set store_id = '70500111' where household_id = '0b000000-0000-4000-8000-00000000000b'$$), 0::bigint, 'alice cannot change household B''s connection');
select throws_ok($$update public.retailer_connections set status = 'active'$$, '42501', null, 'alice cannot set status');
select throws_ok($$update public.retailer_connections set vault_secret_id = null$$, '42501', null, 'alice cannot touch vault_secret_id');
select throws_ok($$update public.retailer_connections set household_id = '0b000000-0000-4000-8000-00000000000b'$$, '42501', null, 'alice cannot move a connection to another household');
select throws_ok(
  $$insert into public.retailer_connections (household_id, user_id, retailer, auth_type) values ('0a000000-0000-4000-8000-00000000000a', 'a1111111-1111-4111-8111-111111111111', 'instacart', 'none')$$,
  '42501', null, 'alice cannot insert a connection directly'
);
select throws_ok($$delete from public.retailer_connections$$, '42501', null, 'alice cannot delete a connection directly');

select throws_ok($$select public.retailer_save_oauth_connection('0a000000-0000-4000-8000-00000000000a', 'a1111111-1111-4111-8111-111111111111', 'kroger', 'forged-refresh-token')$$, '42501', 'permission denied for function retailer_save_oauth_connection', 'alice cannot call the save function');
select throws_ok($$select public.retailer_read_refresh_token(public.__t_conn_id('a1111111-1111-4111-8111-111111111111'))$$, '42501', 'permission denied for function retailer_read_refresh_token', 'alice cannot read her own token');
select throws_ok($$select public.retailer_disconnect(public.__t_conn_id('a1111111-1111-4111-8111-111111111111'), 'a1111111-1111-4111-8111-111111111111')$$, '42501', 'permission denied for function retailer_disconnect', 'alice cannot call disconnect directly; the Edge Function does');
select throws_ok($$select * from public.retailer_quota_consume('kroger', 'products', current_date, 9500)$$, '42501', 'permission denied for function retailer_quota_consume', 'alice cannot spend quota');
select throws_ok($$select * from public.retailer_user_consume('a1111111-1111-4111-8111-111111111111', 'products', 1000)$$, '42501', 'permission denied for function retailer_user_consume', 'alice cannot touch her own hourly count');
select throws_ok($$select count(*) from public.retailer_quota_usage$$, '42501', null, 'alice cannot read the quota table');
select throws_ok($$select decrypted_secret from vault.decrypted_secrets$$, '42501', null, 'alice cannot read Vault');

-- product_matches
select is((select count(*)::int from public.product_matches), 1, 'alice sees household A''s one match');
select is_empty($$select id from public.product_matches where household_id = '0b000000-0000-4000-8000-00000000000b'$$, 'alice reads no match of household B');
select lives_ok(
  $$insert into public.product_matches (household_id, retailer, store_id, ingredient_id, product_id, upc, product_name, size, chosen_by, pinned) values ('0a000000-0000-4000-8000-00000000000a', 'kroger', '70500999', '11111111-0000-4000-8000-000000000007', '0009990001003', '0009990001003', 'Fixture Farms Breaded Chicken Thigh Bites', '24 oz', 'user', false)$$,
  'alice can record a choice she confirmed'
);
select throws_ok(
  $$insert into public.product_matches (household_id, retailer, store_id, ingredient_id, product_id, product_name, chosen_by) values ('0a000000-0000-4000-8000-00000000000a', 'kroger', '70500999', '11111111-0000-4000-8000-000000000007', '0009990001004', 'Agent pick', 'agent')$$,
  '42501', 'new row violates row-level security policy for table "product_matches"', 'a client cannot record an agent choice'
);
select throws_ok(
  $$insert into public.product_matches (household_id, retailer, store_id, ingredient_id, product_id, product_name, chosen_by) values ('0b000000-0000-4000-8000-00000000000b', 'kroger', '70100999', '11111111-0000-4000-8000-000000000007', '0009990001004', 'Planted', 'user')$$,
  '42501', 'new row violates row-level security policy for table "product_matches"', 'alice cannot add a match to household B'
);
select is(public.__t_affected($$update public.product_matches set pinned = true where household_id = '0b000000-0000-4000-8000-00000000000b'$$), 0::bigint, 'alice cannot update household B''s matches');
select is(public.__t_affected($$delete from public.product_matches where household_id = '0b000000-0000-4000-8000-00000000000b'$$), 0::bigint, 'alice cannot delete household B''s matches');
select throws_ok($$update public.product_matches set product_id = '0009990009999'$$, '42501', null, 'a choice cannot be repointed at another product');
select is(public.__t_affected($$delete from public.product_matches where id = 'e0000000-0000-4000-8000-0000000000a1'$$), 1::bigint, 'alice can forget a match in her household');

reset role;

-- ---------------------------------------------------------------------------------------
-- Carol (member of A, not an owner)
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}';
set local role authenticated;

select is((select count(*)::int from public.retailer_connections), 2, 'carol sees household A''s connections');
select is(public.__t_affected($$update public.retailer_connections set modality = 'delivery' where user_id = 'c3333333-3333-4333-8333-333333333333'$$), 1::bigint, 'carol can change her own connection');
select is(public.__t_affected($$update public.retailer_connections set store_id = '70500222' where user_id = 'a1111111-1111-4111-8111-111111111111'$$), 0::bigint, 'carol cannot change the owner''s connection');

reset role;

-- ---------------------------------------------------------------------------------------
-- Bob (owner of B) and Dave (no household)
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.retailer_connections), 1, 'bob sees only household B''s connection');
select is((select count(*)::int from public.product_matches), 1, 'bob sees only household B''s match');
reset role;

set local request.jwt.claims = '{"sub": "d4444444-4444-4444-8444-444444444444", "role": "authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.retailer_connections), 0, 'a user with no household sees no connections');
select is((select count(*)::int from public.product_matches), 0, 'a user with no household sees no matches');
reset role;

-- ---------------------------------------------------------------------------------------
-- Disconnect (service role)
-- ---------------------------------------------------------------------------------------

set local role service_role;

select throws_ok(
  $$select public.retailer_disconnect(public.__t_conn_id('a1111111-1111-4111-8111-111111111111'), 'c3333333-3333-4333-8333-333333333333')$$,
  'P0001', 'not_allowed', 'a plain member cannot disconnect someone else''s account'
);
select lives_ok(
  $$select public.retailer_disconnect(public.__t_conn_id('c3333333-3333-4333-8333-333333333333'), 'c3333333-3333-4333-8333-333333333333')$$,
  'a member can disconnect her own account'
);
reset role;

select is(
  (select status::text || ' ' || coalesce(vault_secret_id::text, 'no-secret') from public.retailer_connections where id = public.__t_conn_id('c3333333-3333-4333-8333-333333333333')),
  'revoked no-secret',
  'disconnect sets status revoked and drops the secret id'
);
select is(
  (select count(*)::int from vault.secrets where id = (select vault_secret_id from __t_conn where user_id = 'c3333333-3333-4333-8333-333333333333')),
  0,
  'disconnect deletes the Vault secret'
);
select is(public.retailer_read_refresh_token(public.__t_conn_id('c3333333-3333-4333-8333-333333333333')), null, 'a revoked connection has no token');

set local role service_role;
select lives_ok(
  $$select public.retailer_disconnect(public.__t_conn_id('a1111111-1111-4111-8111-111111111111'), 'a1111111-1111-4111-8111-111111111111')$$,
  'the owner can disconnect her own account'
);
reset role;
select is((select default_connection_id from public.households where id = '0a000000-0000-4000-8000-00000000000a'), null, 'disconnecting the default clears the household default');
select is(
  (select count(*)::int from public.audit_events where kind = 'connection_revoked' and household_id = '0a000000-0000-4000-8000-00000000000a'),
  2,
  'each disconnect is audited'
);

-- Reconnecting after a disconnect starts a fresh secret on the same row.
select is(
  public.retailer_save_oauth_connection('0a000000-0000-4000-8000-00000000000a', 'c3333333-3333-4333-8333-333333333333', 'kroger', 'carol-refresh-token-2'),
  public.__t_conn_id('c3333333-3333-4333-8333-333333333333'),
  'reconnecting after a disconnect reuses the row'
);
select is(
  (select status::text from public.retailer_connections where id = public.__t_conn_id('c3333333-3333-4333-8333-333333333333')),
  'active',
  'the reconnected account is active again'
);

-- A member who leaves takes their account with them: the worker can no longer read the token.
delete from public.household_members
where household_id = '0a000000-0000-4000-8000-00000000000a' and user_id = 'c3333333-3333-4333-8333-333333333333';
select is(public.retailer_read_refresh_token(public.__t_conn_id('c3333333-3333-4333-8333-333333333333')), null, 'no token is handed out for a member who left the household');

-- ---------------------------------------------------------------------------------------
-- Quota counter (service role)
-- ---------------------------------------------------------------------------------------

set local role service_role;
select is((select allowed::text || ' ' || used from public.retailer_quota_consume('kroger', 'products', '2026-10-30', 2)), 'true 1', 'the first call is allowed');
select is((select allowed::text || ' ' || used from public.retailer_quota_consume('kroger', 'products', '2026-10-30', 2)), 'true 2', 'the call that reaches the ceiling is allowed');
select is((select allowed::text || ' ' || used from public.retailer_quota_consume('kroger', 'products', '2026-10-30', 2)), 'false 2', 'the call past the ceiling is refused and not counted');
select is((select allowed::text || ' ' || used from public.retailer_quota_consume('kroger', 'products', '2026-10-31', 2)), 'true 1', 'a new day starts a new count');
select is((select allowed::text || ' ' || used from public.retailer_quota_consume('kroger', 'cart', '2026-10-30', 2)), 'true 1', 'each endpoint has its own count');
select lives_ok($$select public.retailer_quota_raise('kroger', 'locations', '2026-10-30', 1500)$$, 'the count can be raised from response headers');
select lives_ok($$select public.retailer_quota_raise('kroger', 'locations', '2026-10-30', 10)$$, 'raising to a lower number is a no-op');
select is((select count from public.retailer_quota_usage where retailer = 'kroger' and endpoint = 'locations' and day = '2026-10-30'), 1500, 'the count only ever goes up');

-- Per-member hourly limits for the retailer-oauth function.
select is((select allowed::text || ' ' || used from public.retailer_user_consume('a1111111-1111-4111-8111-111111111111', 'products', 2)), 'true 1', 'a member''s first call this hour is allowed');
select is((select allowed::text || ' ' || used from public.retailer_user_consume('a1111111-1111-4111-8111-111111111111', 'products', 2)), 'true 2', 'the call that reaches the hourly limit is allowed');
select is((select allowed::text || ' ' || used from public.retailer_user_consume('a1111111-1111-4111-8111-111111111111', 'products', 2)), 'false 2', 'the call past the hourly limit is refused and not counted');
select is((select allowed::text || ' ' || used from public.retailer_user_consume('b2222222-2222-4222-8222-222222222222', 'products', 2)), 'true 1', 'another member has their own count');
select is((select resets_at from public.retailer_user_consume('b2222222-2222-4222-8222-222222222222', 'stores', 2)), date_trunc('hour', now()) + interval '1 hour', 'the count resets at the next hour');
reset role;

insert into public.retailer_user_usage (user_id, action, window_start, count)
values ('d4444444-4444-4444-8444-444444444444', 'stores', date_trunc('hour', now()) - interval '2 days', 5);
set local role service_role;
select lives_ok($$select * from public.retailer_user_consume('d4444444-4444-4444-8444-444444444444', 'stores', 20)$$, 'a member''s first call of the hour works');
reset role;
select is((select count(*)::int from public.retailer_user_usage where user_id = 'd4444444-4444-4444-8444-444444444444'), 1, 'and prunes their rows older than a day');

-- ---------------------------------------------------------------------------------------
-- Cascades: deleting a household removes its connection and the Vault secret
-- ---------------------------------------------------------------------------------------

select lives_ok($$delete from public.households where id = '0b000000-0000-4000-8000-00000000000b'$$, 'deleting a household with a connection cascades cleanly');
select is((select count(*)::int from public.retailer_connections where household_id = '0b000000-0000-4000-8000-00000000000b'), 0, 'its connections go with it');
select is(
  (select count(*)::int from vault.secrets where id = (select vault_secret_id from __t_conn where user_id = 'b2222222-2222-4222-8222-222222222222')),
  0,
  'and so does its Vault secret'
);

select * from finish();

rollback;
