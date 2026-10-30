-- WS07 CCR2 (orchestrator): leaving or being removed from a household revokes that member's
-- retailer connections in it. Run with `supabase test db`. One transaction, rolled back.
--
-- Cast (fixed ids, matching the other test files):
--   alice owns household A, carol is a plain member of A, bob owns household B.

begin;

select plan(8);

insert into auth.users (id, email, raw_user_meta_data) values
  ('a1111111-1111-4111-8111-111111111111', 'alice@example.test', '{}'),
  ('b2222222-2222-4222-8222-222222222222', 'bob@example.test', '{}'),
  ('c3333333-3333-4333-8333-333333333333', 'carol@example.test', '{}');

insert into public.households (id, name, created_by) values
  ('0a000000-0000-4000-8000-00000000000a', 'Alice House', 'a1111111-1111-4111-8111-111111111111'),
  ('0b000000-0000-4000-8000-00000000000b', 'Bob House', 'b2222222-2222-4222-8222-222222222222');

insert into public.household_members (household_id, user_id, role) values
  ('0a000000-0000-4000-8000-00000000000a', 'a1111111-1111-4111-8111-111111111111', 'owner'),
  ('0a000000-0000-4000-8000-00000000000a', 'c3333333-3333-4333-8333-333333333333', 'member'),
  ('0b000000-0000-4000-8000-00000000000b', 'b2222222-2222-4222-8222-222222222222', 'owner');

create temp table __ids (who text primary key, connection_id uuid, secret_id uuid);

do $$
declare v_id uuid;
begin
  v_id := public.retailer_save_oauth_connection(
    '0a000000-0000-4000-8000-00000000000a', 'a1111111-1111-4111-8111-111111111111', 'kroger',
    'alice-refresh-token-1', '70500999', 'QFC Fixture Ridge', 'pickup');
  insert into __ids select 'alice', v_id, c.vault_secret_id from public.retailer_connections c where c.id = v_id;
  v_id := public.retailer_save_oauth_connection(
    '0a000000-0000-4000-8000-00000000000a', 'c3333333-3333-4333-8333-333333333333', 'kroger',
    'carol-refresh-token-1');
  insert into __ids select 'carol', v_id, c.vault_secret_id from public.retailer_connections c where c.id = v_id;
  v_id := public.retailer_save_oauth_connection(
    '0b000000-0000-4000-8000-00000000000b', 'b2222222-2222-4222-8222-222222222222', 'kroger',
    'bob-refresh-token-1', '70100999', 'Fred Meyer Fixture Lake', 'delivery');
  insert into __ids select 'bob', v_id, c.vault_secret_id from public.retailer_connections c where c.id = v_id;
end;
$$;

select is(
  (select count(*)::int from vault.secrets s where s.id in (select secret_id from __ids)), 3,
  'three secrets exist before anyone leaves');

-- Carol leaves household A (any path that deletes the membership row fires the trigger).
delete from public.household_members
where household_id = '0a000000-0000-4000-8000-00000000000a'
  and user_id = 'c3333333-3333-4333-8333-333333333333';

select is(
  (select c.status::text from public.retailer_connections c where c.id = (select connection_id from __ids where who = 'carol')),
  'revoked', 'carol''s connection in A is revoked when she leaves');
select is(
  (select c.vault_secret_id from public.retailer_connections c where c.id = (select connection_id from __ids where who = 'carol')),
  null, 'carol''s connection no longer points at a secret');
select is_empty(
  $$select 1 from vault.secrets s where s.id = (select secret_id from __ids where who = 'carol')$$,
  'carol''s Vault secret is deleted');
select is(
  (select c.status::text from public.retailer_connections c where c.id = (select connection_id from __ids where who = 'alice')),
  'active', 'alice''s connection in A is untouched');
select is(
  (select count(*)::int from public.audit_events e
   where e.household_id = '0a000000-0000-4000-8000-00000000000a'
     and e.kind = 'connection_revoked'
     and e.payload->>'reason' = 'member_removed'
     and (e.payload->>'connection_id')::uuid = (select connection_id from __ids where who = 'carol')),
  1, 'one audit event records the revocation with reason member_removed');

-- Deleting a whole household cascades through its members without tripping the trigger's audit insert.
select lives_ok(
  $$delete from public.households where id = '0b000000-0000-4000-8000-00000000000b'$$,
  'deleting a household with a connected member succeeds');
select is_empty(
  $$select 1 from vault.secrets s where s.id = (select secret_id from __ids where who = 'bob')$$,
  'bob''s Vault secret is deleted with his household');

select * from finish();
rollback;
