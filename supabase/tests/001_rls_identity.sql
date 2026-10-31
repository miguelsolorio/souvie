-- WS01: pgTAP tests for the identity tables, their RLS policies, and the identity RPCs.
-- Run with `supabase test db`. Everything happens inside one transaction that is rolled back.
--
-- Cast of characters (fixed ids, so the SQL below stays readable):
--   alice   owns household A          bob    owns household B
--   carol   joins A through an invite dave   starts with nothing, then creates a household
--   erin    owns L, frank and grace are members of L (leave_household tests)
--   heidi   owns D, a household that was closed (soft-deleted)

begin;

select plan(130);

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
  ('c3333333-3333-4333-8333-333333333333', 'carol@example.test', '{"full_name": "Carol Jones"}'),
  ('d4444444-4444-4444-8444-444444444444', 'dave@example.test', '{}'),
  ('e5555555-5555-4555-8555-555555555555', 'erin@example.test', '{}'),
  ('f6666666-6666-4666-8666-666666666666', 'frank@example.test', '{}'),
  ('96666666-7777-4777-8777-777777777777', 'grace@example.test', '{}'),
  ('77777777-8888-4888-8888-888888888888', 'heidi@example.test', '{}');

insert into public.households (id, name, created_by, deleted_at) values
  ('0a000000-0000-4000-8000-00000000000a', 'Alice House', 'a1111111-1111-4111-8111-111111111111', null),
  ('0b000000-0000-4000-8000-00000000000b', 'Bob House', 'b2222222-2222-4222-8222-222222222222', null),
  ('0c000000-0000-4000-8000-00000000000c', 'Erin House', 'e5555555-5555-4555-8555-555555555555', null),
  -- Heidi owns a household that has been closed. Her invite must still not work.
  ('0d000000-0000-4000-8000-00000000000d', 'Closed House', '77777777-8888-4888-8888-888888888888', now());

insert into public.household_members (household_id, user_id, role, created_at) values
  ('0d000000-0000-4000-8000-00000000000d', '77777777-8888-4888-8888-888888888888', 'owner', now() - interval '5 days'),
  ('0a000000-0000-4000-8000-00000000000a', 'a1111111-1111-4111-8111-111111111111', 'owner', now() - interval '5 days'),
  ('0b000000-0000-4000-8000-00000000000b', 'b2222222-2222-4222-8222-222222222222', 'owner', now() - interval '5 days'),
  ('0c000000-0000-4000-8000-00000000000c', 'e5555555-5555-4555-8555-555555555555', 'owner', now() - interval '5 days'),
  ('0c000000-0000-4000-8000-00000000000c', 'f6666666-6666-4666-8666-666666666666', 'member', now() - interval '3 days'),
  ('0c000000-0000-4000-8000-00000000000c', '96666666-7777-4777-8777-777777777777', 'member', now() - interval '1 day');

-- One invite for B, plus an expired and a used invite for A, two of erin's for L (one open, one
-- already used), and heidi's for the closed household.
insert into public.household_invites (household_id, token, created_by, expires_at, used_at, used_by) values
  ('0c000000-0000-4000-8000-00000000000c', 'erin-open-invite', 'e5555555-5555-4555-8555-555555555555', default, null, null),
  ('0c000000-0000-4000-8000-00000000000c', 'erin-used-invite', 'e5555555-5555-4555-8555-555555555555', default, now() - interval '2 days', '96666666-7777-4777-8777-777777777777'),
  ('0d000000-0000-4000-8000-00000000000d', 'closed-invite', '77777777-8888-4888-8888-888888888888', default, null, null),
  ('0b000000-0000-4000-8000-00000000000b', 'bob-invite', 'b2222222-2222-4222-8222-222222222222', default, null, null),
  ('0a000000-0000-4000-8000-00000000000a', 'expired-token', 'a1111111-1111-4111-8111-111111111111', now() - interval '1 day', null, null),
  ('0a000000-0000-4000-8000-00000000000a', 'used-token', 'a1111111-1111-4111-8111-111111111111', default, now() - interval '1 hour', 'b2222222-2222-4222-8222-222222222222');

-- ---------------------------------------------------------------------------------------
-- Shape: RLS on, the reviewed policy set, profiles and bucket
-- ---------------------------------------------------------------------------------------

select ok((select relrowsecurity from pg_class where oid = 'public.households'::regclass), 'households has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.household_members'::regclass), 'household_members has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.household_invites'::regclass), 'household_invites has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.profiles'::regclass), 'profiles has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.audit_events'::regclass), 'audit_events has RLS enabled');

select policies_are('public', 'households', array['households: members read', 'households: owners update'], 'households has exactly the reviewed policies');
select policies_are('public', 'household_members', array['household_members: members read', 'household_members: owners remove members'], 'household_members has exactly the reviewed policies');
select policies_are('public', 'household_invites', array['household_invites: owners read', 'household_invites: owners revoke'], 'household_invites has exactly the reviewed policies');
select policies_are('public', 'profiles', array['profiles: own read', 'profiles: own insert', 'profiles: own update'], 'profiles has exactly the reviewed policies');
select policies_are('public', 'audit_events', array['audit_events: members read'], 'audit_events has exactly one policy and no write policy');

select is((select count(*)::int from public.profiles where user_id in ('a1111111-1111-4111-8111-111111111111', 'b2222222-2222-4222-8222-222222222222', 'c3333333-3333-4333-8333-333333333333', 'd4444444-4444-4444-8444-444444444444')), 4, 'a profile row is created for each new user');
select is((select display_name from public.profiles where user_id = 'c3333333-3333-4333-8333-333333333333'), 'Carol Jones', 'the profile takes its display name from sign-in metadata');
select is((select public from storage.buckets where id = 'avatars'), false, 'the avatars bucket is private');
select is((select count(*)::int from public.audit_events where household_id = '0a000000-0000-4000-8000-00000000000a' and kind = 'member_added'), 1, 'adding a member writes a member_added audit event');

-- ---------------------------------------------------------------------------------------
-- Signed out (anon) gets nothing
-- ---------------------------------------------------------------------------------------

set local role anon;

select throws_ok($$select count(*) from public.households$$, '42501', 'permission denied for table households', 'anon cannot read households');
select throws_ok($$select count(*) from public.household_members$$, '42501', 'permission denied for table household_members', 'anon cannot read household_members');
select throws_ok($$select count(*) from public.profiles$$, '42501', 'permission denied for table profiles', 'anon cannot read profiles');
select throws_ok($$select public.redeem_invite('bob-invite')$$, '42501', 'permission denied for function redeem_invite', 'anon cannot call redeem_invite');
select throws_ok($$select public.create_household('Nope')$$, '42501', 'permission denied for function create_household', 'anon cannot call create_household');

reset role;

-- ---------------------------------------------------------------------------------------
-- Alice, owner of A: isolation from B, direct writes denied, owner powers
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;

select is((select count(*)::int from public.households), 1, 'alice sees exactly one household');
select is((select name from public.households), 'Alice House', 'alice sees her own household');
select is_empty($$select 1 from public.households where id = '0b000000-0000-4000-8000-00000000000b'$$, 'alice cannot select bob''s household row');
select is((select count(*)::int from public.household_members), 1, 'alice sees only her own household roster');
select is_empty($$select 1 from public.household_members where household_id = '0b000000-0000-4000-8000-00000000000b'$$, 'alice cannot select bob''s household_members rows');
select is_empty($$select 1 from public.household_invites where household_id = '0b000000-0000-4000-8000-00000000000b'$$, 'alice cannot select bob''s invites');
select is_empty($$select 1 from public.audit_events where household_id = '0b000000-0000-4000-8000-00000000000b'$$, 'alice cannot select bob''s audit events');
select is_empty($$select 1 from public.profiles where user_id = 'b2222222-2222-4222-8222-222222222222'$$, 'alice cannot select bob''s profile');

select throws_ok($$insert into public.household_members (household_id, user_id, role) values ('0b000000-0000-4000-8000-00000000000b', 'a1111111-1111-4111-8111-111111111111', 'owner')$$, '42501', 'permission denied for table household_members', 'alice cannot insert herself into bob''s household');
select throws_ok($$insert into public.household_members (household_id, user_id, role) values ('0a000000-0000-4000-8000-00000000000a', 'd4444444-4444-4444-8444-444444444444', 'member')$$, '42501', 'permission denied for table household_members', 'even an owner cannot insert a member directly; invites are the only way in');
select throws_ok($$insert into public.households (name) values ('Sneaky')$$, '42501', 'permission denied for table households', 'clients cannot insert households directly');
select throws_ok($$insert into public.household_invites (household_id, token) values ('0a000000-0000-4000-8000-00000000000a', 'forged')$$, '42501', 'permission denied for table household_invites', 'clients cannot forge invites');
select throws_ok($$insert into public.audit_events (household_id, kind) values ('0a000000-0000-4000-8000-00000000000a', 'member_added')$$, '42501', 'permission denied for table audit_events', 'clients cannot write audit events');

select is(public.__t_affected($$update public.households set name = 'Alice Home' where id = '0a000000-0000-4000-8000-00000000000a'$$), 1::bigint, 'an owner can rename her household');
select is((select name from public.households where id = '0a000000-0000-4000-8000-00000000000a'), 'Alice Home', 'the rename took effect');
select is(public.__t_affected($$update public.households set zip = '98019' where id = '0a000000-0000-4000-8000-00000000000a'$$), 1::bigint, 'an owner can set the zip');

-- Update is granted on name and zip only. These are denied by privilege, so they raise instead of
-- quietly touching zero rows.
select throws_ok($$update public.households set default_connection_id = gen_random_uuid() where id = '0a000000-0000-4000-8000-00000000000a'$$, '42501', 'permission denied for table households', 'an owner cannot change default_connection_id');
select throws_ok($$update public.households set created_by = 'b2222222-2222-4222-8222-222222222222' where id = '0a000000-0000-4000-8000-00000000000a'$$, '42501', 'permission denied for table households', 'an owner cannot change created_by');
select throws_ok($$update public.households set deleted_at = now() where id = '0a000000-0000-4000-8000-00000000000a'$$, '42501', 'permission denied for table households', 'an owner cannot close the household by setting deleted_at');
select throws_ok($$update public.households set id = gen_random_uuid() where id = '0a000000-0000-4000-8000-00000000000a'$$, '42501', 'permission denied for table households', 'an owner cannot change the household id');
select is(public.__t_affected($$update public.households set name = 'Hacked' where id = '0b000000-0000-4000-8000-00000000000b'$$), 0::bigint, 'alice cannot rename bob''s household');
select is(public.__t_affected($$delete from public.household_members where household_id = '0b000000-0000-4000-8000-00000000000b'$$), 0::bigint, 'alice cannot remove bob''s members');
select is(public.__t_affected($$delete from public.household_members where household_id = '0a000000-0000-4000-8000-00000000000a' and user_id = 'a1111111-1111-4111-8111-111111111111'$$), 0::bigint, 'an owner cannot delete her own membership directly; she uses leave_household');
select throws_ok($$select public.create_invite('0b000000-0000-4000-8000-00000000000b')$$, 'P0001', 'not_owner', 'alice cannot create an invite for bob''s household');

select is(length(set_config('t.invite', public.create_invite('0a000000-0000-4000-8000-00000000000a'), true)), 64, 'an owner gets a 64 character invite token');
select is((select count(*)::int from public.household_invites where household_id = '0a000000-0000-4000-8000-00000000000a' and token = current_setting('t.invite')), 1, 'the owner can read the invite she created');
select is(length(set_config('t.invite2', public.create_invite('0a000000-0000-4000-8000-00000000000a'), true)), 64, 'an owner can create a second invite');

-- Profiles: own row only.
select is((select count(*)::int from public.profiles), 1, 'alice sees only her own profile');
select is(public.__t_affected($$update public.profiles set display_name = 'Alice A.' where user_id = 'a1111111-1111-4111-8111-111111111111'$$), 1::bigint, 'alice can edit her own profile');
select is(public.__t_affected($$update public.profiles set display_name = 'Pwned' where user_id = 'b2222222-2222-4222-8222-222222222222'$$), 0::bigint, 'alice cannot edit bob''s profile');
select throws_ok($$insert into public.profiles (user_id) values ('b2222222-2222-4222-8222-222222222222')$$, '42501', 'new row violates row-level security policy for table "profiles"', 'alice cannot create a profile for someone else');
select throws_ok($$update public.profiles set user_id = 'b2222222-2222-4222-8222-222222222222' where user_id = 'a1111111-1111-4111-8111-111111111111'$$, '42501', 'permission denied for table profiles', 'alice cannot hand her profile to someone else');

-- Avatars: write only inside <user_id>/.
select lives_ok($$insert into storage.objects (bucket_id, name) values ('avatars', 'a1111111-1111-4111-8111-111111111111/me.png')$$, 'alice can write inside her own avatars folder');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('avatars', 'b2222222-2222-4222-8222-222222222222/me.png')$$, '42501', 'new row violates row-level security policy for table "objects"', 'alice cannot write inside bob''s avatars folder');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('avatars', 'loose.png')$$, '42501', 'new row violates row-level security policy for table "objects"', 'alice cannot write outside any user folder');

reset role;

-- ---------------------------------------------------------------------------------------
-- Bob, owner of B, mirrors the checks from the other side
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}';
set local role authenticated;

select is((select count(*)::int from public.households), 1, 'bob sees exactly one household');
select is_empty($$select 1 from public.households where id = '0a000000-0000-4000-8000-00000000000a'$$, 'bob cannot select alice''s household row');
select is_empty($$select 1 from public.household_invites where household_id = '0a000000-0000-4000-8000-00000000000a'$$, 'bob cannot read alice''s invites');
select is((select count(*)::int from public.household_invites), 1, 'bob sees only his own invite');
select throws_ok($$select public.create_invite('0a000000-0000-4000-8000-00000000000a')$$, 'P0001', 'not_owner', 'bob cannot create an invite for alice''s household');
select throws_ok($$select * from public.list_household_members('0a000000-0000-4000-8000-00000000000a')$$, 'P0001', 'not_a_member', 'bob cannot list alice''s roster');
select is(public.__t_affected($$delete from public.household_invites where household_id = '0a000000-0000-4000-8000-00000000000a'$$), 0::bigint, 'bob cannot revoke alice''s invites');
select is_empty($$select 1 from storage.objects where bucket_id = 'avatars'$$, 'bob cannot see alice''s avatar');

reset role;

-- ---------------------------------------------------------------------------------------
-- redeem_invite
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}';
set local role authenticated;

select throws_ok($$select public.redeem_invite('no-such-token')$$, 'P0001', 'invite_not_found', 'redeem_invite rejects an unknown token');
select throws_ok($$select public.redeem_invite('expired-token')$$, 'P0001', 'invite_expired', 'redeem_invite raises for an expired token');
select throws_ok($$select public.redeem_invite('used-token')$$, 'P0001', 'invite_used', 'redeem_invite raises for a token that was already used');
select is_empty($$select 1 from public.household_members where user_id = 'c3333333-3333-4333-8333-333333333333'$$, 'the failed attempts did not add carol anywhere');

select is(public.redeem_invite(current_setting('t.invite')), '0a000000-0000-4000-8000-00000000000a'::uuid, 'redeem_invite with a valid token returns the household id');
select is((select role::text from public.household_members where household_id = '0a000000-0000-4000-8000-00000000000a' and user_id = 'c3333333-3333-4333-8333-333333333333'), 'member', 'the invitee joins as a member');
select is((select name from public.households where id = '0a000000-0000-4000-8000-00000000000a'), 'Alice Home', 'carol now sees the household name');
select is(public.redeem_invite(current_setting('t.invite2')), '0a000000-0000-4000-8000-00000000000a'::uuid, 'an existing member redeeming another invite just gets the household id back');

-- Member limits.
select is(public.__t_affected($$update public.households set name = 'Carol Was Here' where id = '0a000000-0000-4000-8000-00000000000a'$$), 0::bigint, 'a member cannot rename the household');
select is((select name from public.households where id = '0a000000-0000-4000-8000-00000000000a'), 'Alice Home', 'the household name is unchanged');
select throws_ok($$select public.create_invite('0a000000-0000-4000-8000-00000000000a')$$, 'P0001', 'not_owner', 'a member cannot create invites');
select is_empty($$select 1 from public.household_invites$$, 'a member cannot read invites');
select is(public.__t_affected($$delete from public.household_members where household_id = '0a000000-0000-4000-8000-00000000000a' and user_id = 'a1111111-1111-4111-8111-111111111111'$$), 0::bigint, 'a member cannot remove the owner');
select is(public.__t_affected($$delete from public.household_invites where household_id = '0a000000-0000-4000-8000-00000000000a'$$), 0::bigint, 'a member cannot revoke invites');
select is((select count(*)::int from public.household_members), 2, 'a member sees the whole roster of her own household');
select is_empty($$select 1 from public.profiles where user_id = 'a1111111-1111-4111-8111-111111111111'$$, 'a member cannot read a housemate''s profile row (preferences stay private)');
select ok((select count(*) from public.audit_events where household_id = '0a000000-0000-4000-8000-00000000000a') >= 2, 'a member can read the household audit trail');

-- list_household_members is how names and avatars reach housemates.
select is((select count(*)::int from public.list_household_members('0a000000-0000-4000-8000-00000000000a')), 2, 'list_household_members returns both members');
select is((select user_id from public.list_household_members('0a000000-0000-4000-8000-00000000000a') limit 1), 'a1111111-1111-4111-8111-111111111111'::uuid, 'the owner is listed first');
select is((select display_name from public.list_household_members('0a000000-0000-4000-8000-00000000000a') where user_id = 'c3333333-3333-4333-8333-333333333333'), 'Carol Jones', 'list_household_members carries display names');
select throws_ok($$select * from public.list_household_members('0b000000-0000-4000-8000-00000000000b')$$, 'P0001', 'not_a_member', 'list_household_members refuses other households');

-- Avatars between housemates.
select is((select count(*)::int from storage.objects where bucket_id = 'avatars'), 1, 'carol can read the avatar of a housemate');
-- Storage refuses direct DELETEs (storage.protect_delete) unless the Storage API's own switch is on.
-- Turn it on for the one statement, so the test exercises our policy and not the guard.
set local storage.allow_delete_query = 'true';
select is(public.__t_affected($$delete from storage.objects where bucket_id = 'avatars' and name like 'a1111111%'$$), 0::bigint, 'carol cannot delete a housemate''s avatar');
set local storage.allow_delete_query = 'false';
select is(public.__t_affected($$update storage.objects set name = 'c3333333-3333-4333-8333-333333333333/stolen.png' where name like 'a1111111%'$$), 0::bigint, 'carol cannot move a housemate''s avatar');

-- Audit events cannot be changed from the client.
select throws_ok($$update public.audit_events set kind = 'x'$$, '42501', 'permission denied for table audit_events', 'clients cannot edit audit events');
select throws_ok($$delete from public.audit_events$$, '42501', 'permission denied for table audit_events', 'clients cannot delete audit events');

reset role;

-- Server-side view of what redeeming did.
select is((select used_by from public.household_invites where token = current_setting('t.invite')), 'c3333333-3333-4333-8333-333333333333'::uuid, 'redeeming records who used the invite');
select ok((select used_at is not null from public.household_invites where token = current_setting('t.invite')), 'redeeming sets used_at');
select ok((select used_at is null from public.household_invites where token = current_setting('t.invite2')), 'an already-member redeem leaves the second invite unused');
select is((select expires_at - created_at from public.household_invites where token = current_setting('t.invite')), interval '7 days', 'invites expire after 7 days');
select is((select invited_by from public.household_members where household_id = '0a000000-0000-4000-8000-00000000000a' and user_id = 'c3333333-3333-4333-8333-333333333333'), 'a1111111-1111-4111-8111-111111111111'::uuid, 'the membership records who invited carol');
select is((select count(*)::int from public.audit_events where household_id = '0a000000-0000-4000-8000-00000000000a' and kind = 'member_added' and payload ->> 'user_id' = 'c3333333-3333-4333-8333-333333333333' and actor_user_id = 'c3333333-3333-4333-8333-333333333333'), 1, 'redeeming writes a member_added audit event naming the new member');

-- A used token cannot be replayed by someone else.
set local request.jwt.claims = '{"sub": "d4444444-4444-4444-8444-444444444444", "role": "authenticated"}';
set local role authenticated;

select throws_ok($$select public.redeem_invite(current_setting('t.invite'))$$, 'P0001', 'invite_used', 'a redeemed token cannot be replayed');
select is_empty($$select 1 from public.households$$, 'dave still sees no households');
select is_empty($$select 1 from storage.objects where bucket_id = 'avatars'$$, 'a stranger cannot read anyone''s avatar');
select throws_ok($$select public.leave_household('0a000000-0000-4000-8000-00000000000a')$$, 'P0001', 'not_a_member', 'leave_household refuses a non-member');

-- create_household
select throws_ok($$select public.create_household('   ')$$, 'P0001', 'invalid_name', 'create_household rejects a blank name');
select throws_ok($$select public.create_household(repeat('x', 81))$$, 'P0001', 'invalid_name', 'create_household rejects a name over 80 characters');
select ok(set_config('t.house', public.create_household('  Dave Den  ')::text, true) is not null, 'dave creates a household');
select is((select name from public.households where id = current_setting('t.house')::uuid), 'Dave Den', 'create_household trims the name');
select is((select role::text from public.household_members where household_id = current_setting('t.house')::uuid and user_id = 'd4444444-4444-4444-8444-444444444444'), 'owner', 'the creator is the owner');
select is((select created_by from public.households where id = current_setting('t.house')::uuid), 'd4444444-4444-4444-8444-444444444444'::uuid, 'the household records its creator');

reset role;

-- A signed-in session with no user cannot use the RPCs either.
set local request.jwt.claims = '{"role": "authenticated"}';
set local role authenticated;
select throws_ok($$select public.create_household('Ghost')$$, 'P0001', 'not_authenticated', 'create_household needs a user id in the token');
select throws_ok($$select public.redeem_invite('bob-invite')$$, 'P0001', 'not_authenticated', 'redeem_invite needs a user id in the token');
reset role;

-- ---------------------------------------------------------------------------------------
-- Owner removes a member; owner and member leave
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;

select is(public.__t_affected($$delete from public.household_members where household_id = '0a000000-0000-4000-8000-00000000000a' and user_id = 'c3333333-3333-4333-8333-333333333333'$$), 1::bigint, 'an owner can remove a member');
select is((select count(*)::int from public.household_members), 1, 'the roster is back to one');
select is(public.__t_affected($$delete from public.household_invites where household_id = '0a000000-0000-4000-8000-00000000000a' and used_at is null$$), 2::bigint, 'an owner can revoke unused invites');
select is((select count(*)::int from storage.objects where bucket_id = 'avatars'), 1, 'alice still sees her own avatar');
set local storage.allow_delete_query = 'true';
select is(public.__t_affected($$delete from storage.objects where bucket_id = 'avatars' and name like 'a1111111%'$$), 1::bigint, 'alice can delete her own avatar');
set local storage.allow_delete_query = 'false';

reset role;

select is((select count(*)::int from public.audit_events where household_id = '0a000000-0000-4000-8000-00000000000a' and kind = 'member_removed' and payload ->> 'user_id' = 'c3333333-3333-4333-8333-333333333333' and payload ->> 'self' = 'false'), 1, 'removing a member writes a member_removed audit event');

-- An invite speaks for the owner who made it. One made by someone who is no longer an owner
-- (carol was just removed), and one whose creator's account is gone, are void.
insert into public.household_invites (household_id, token, created_by) values
  ('0a000000-0000-4000-8000-00000000000a', 'left-creator-invite', 'c3333333-3333-4333-8333-333333333333'),
  ('0a000000-0000-4000-8000-00000000000a', 'orphaned-invite', null);

set local request.jwt.claims = '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}';
set local role authenticated;
select throws_ok($$select public.redeem_invite('left-creator-invite')$$, 'P0001', 'invite_not_found', 'an invite made by someone who is no longer an owner cannot be redeemed');
select throws_ok($$select public.redeem_invite('orphaned-invite')$$, 'P0001', 'invite_not_found', 'an invite whose creator no longer exists cannot be redeemed');
reset role;

select is((select count(*)::int from public.household_members where household_id = '0a000000-0000-4000-8000-00000000000a' and user_id = 'b2222222-2222-4222-8222-222222222222'), 0, 'the void invites did not add bob');

-- grace, a plain member of L, leaves.
set local request.jwt.claims = '{"sub": "96666666-7777-4777-8777-777777777777", "role": "authenticated"}';
set local role authenticated;
select lives_ok($$select public.leave_household('0c000000-0000-4000-8000-00000000000c')$$, 'a member can leave');
select is_empty($$select 1 from public.households$$, 'after leaving, grace no longer sees the household');
reset role;

select is((select count(*)::int from public.audit_events where household_id = '0c000000-0000-4000-8000-00000000000c' and kind = 'member_removed' and payload ->> 'self' = 'true'), 1, 'leaving writes a member_removed audit event marked self');

-- erin, the only owner of L, leaves. frank joined first, so he becomes owner.
set local request.jwt.claims = '{"sub": "e5555555-5555-4555-8555-555555555555", "role": "authenticated"}';
set local role authenticated;
select lives_ok($$select public.leave_household('0c000000-0000-4000-8000-00000000000c')$$, 'the only owner can leave');
reset role;

select is((select role::text from public.household_members where household_id = '0c000000-0000-4000-8000-00000000000c' and user_id = 'f6666666-6666-4666-8666-666666666666'), 'owner', 'ownership passes to the longest-standing member');
select is((select count(*)::int from public.audit_events where household_id = '0c000000-0000-4000-8000-00000000000c' and kind = 'owner_transferred'), 1, 'the handover is audited');
select is((select count(*)::int from public.household_members where household_id = '0c000000-0000-4000-8000-00000000000c' and user_id = 'e5555555-5555-4555-8555-555555555555'), 0, 'erin is no longer a member');
select is((select count(*)::int from public.household_invites where household_id = '0c000000-0000-4000-8000-00000000000c' and created_by = 'e5555555-5555-4555-8555-555555555555' and used_at is null), 0, 'leaving deletes the leaver''s unused invites');
select is((select count(*)::int from public.household_invites where token = 'erin-used-invite'), 1, 'an invite that was already used stays as history');

-- frank, now the only member, leaves. Nobody is left, so the household is soft-deleted.
set local request.jwt.claims = '{"sub": "f6666666-6666-4666-8666-666666666666", "role": "authenticated"}';
set local role authenticated;
select lives_ok($$select public.leave_household('0c000000-0000-4000-8000-00000000000c')$$, 'the last member can leave');
reset role;

select ok((select deleted_at is not null from public.households where id = '0c000000-0000-4000-8000-00000000000c'), 'an emptied household is soft-deleted');
select is((select count(*)::int from public.household_members where household_id = '0c000000-0000-4000-8000-00000000000c'), 0, 'no members remain');

-- A soft-deleted household cannot take new members, even through an invite its current owner made.
set local request.jwt.claims = '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}';
set local role authenticated;
select throws_ok($$select public.redeem_invite('closed-invite')$$, 'P0001', 'invite_not_found', 'an invite to a deleted household cannot be redeemed');
reset role;

-- ---------------------------------------------------------------------------------------
-- Deleting a household removes its invites and audit trail without tripping the audit trigger
-- ---------------------------------------------------------------------------------------

select lives_ok($$delete from public.households where id = '0b000000-0000-4000-8000-00000000000b'$$, 'deleting a household cascades cleanly');
select is((select count(*)::int from public.audit_events where household_id = '0b000000-0000-4000-8000-00000000000b'), 0, 'its audit events go with it');

select * from finish();

rollback;
