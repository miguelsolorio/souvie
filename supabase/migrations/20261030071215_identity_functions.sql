-- WS01: identity functions. docs/02-data-model.md §Identity, migration order 3.
--
-- The client-callable RPCs for households and invites. All are security definer with an empty
-- search_path, so every name below is schema-qualified. They derive the caller from auth.uid()
-- and never trust a user id passed in.
--
-- Parameter names are part of the API: supabase-js calls rpc('create_invite', { household_id }),
-- rpc('redeem_invite', { token }), and so on. Inside each body, parameters are written as
-- <function>.<param> and columns carry a table alias, so a parameter never shadows a column.
--
-- Errors are raised as plain codes in the message (P0001): not_authenticated, invalid_name,
-- not_owner, not_a_member, invite_not_found, invite_used, invite_expired.
-- current_household_ids() and the other RLS helpers are in the identity migration.

-- Creates a household and makes the caller its owner, in one transaction.
create or replace function public.create_household(name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  clean_name text := btrim(create_household.name);
  new_id uuid;
begin
  if uid is null then
    raise exception 'not_authenticated';
  end if;
  if clean_name is null or char_length(clean_name) not between 1 and 80 then
    raise exception 'invalid_name';
  end if;

  insert into public.households (name, created_by)
  values (clean_name, uid)
  returning id into new_id;

  insert into public.household_members (household_id, user_id, role)
  values (new_id, uid, 'owner');

  return new_id;
end;
$$;

-- Owner only. Returns a fresh token (32 random bytes, hex) valid for 7 days, single use.
create or replace function public.create_invite(household_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  new_token text;
begin
  if uid is null then
    raise exception 'not_authenticated';
  end if;
  if not exists (
    select 1
    from public.household_members hm
    join public.households h on h.id = hm.household_id
    where hm.household_id = create_invite.household_id
      and hm.user_id = uid
      and hm.role = 'owner'
      and h.deleted_at is null
  ) then
    raise exception 'not_owner';
  end if;

  new_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.household_invites (household_id, token, created_by)
  values (create_invite.household_id, new_token, uid);

  return new_token;
end;
$$;

-- Adds the caller to the invite's household as a member and marks the invite used.
-- Returns the household id. A caller who is already a member gets the id back and the invite
-- stays valid for whoever it was meant for. An invite whose creator is no longer an owner of
-- the household is void (invite_not_found).
create or replace function public.redeem_invite(token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  inv public.household_invites%rowtype;
begin
  if uid is null then
    raise exception 'not_authenticated';
  end if;

  -- Lock the row so two people cannot redeem one token at the same moment.
  select hi.* into inv
  from public.household_invites hi
  where hi.token = redeem_invite.token
  for update;

  if not found then
    raise exception 'invite_not_found';
  end if;
  if exists (
    select 1 from public.households h where h.id = inv.household_id and h.deleted_at is not null
  ) then
    raise exception 'invite_not_found';
  end if;

  if exists (
    select 1 from public.household_members hm
    where hm.household_id = inv.household_id and hm.user_id = uid
  ) then
    return inv.household_id;
  end if;

  -- An invite speaks for the owner who made it. Once that person has left, or their account is
  -- gone (created_by is null), the invite is void.
  if inv.created_by is null or not exists (
    select 1 from public.household_members hm
    where hm.household_id = inv.household_id
      and hm.user_id = inv.created_by
      and hm.role = 'owner'
  ) then
    raise exception 'invite_not_found';
  end if;

  if inv.used_at is not null then
    raise exception 'invite_used';
  end if;
  if inv.expires_at <= now() then
    raise exception 'invite_expired';
  end if;

  insert into public.household_members (household_id, user_id, role, invited_by)
  values (inv.household_id, uid, 'member', inv.created_by);

  update public.household_invites hi
  set used_at = now(), used_by = uid
  where hi.id = inv.id;

  return inv.household_id;
end;
$$;

-- Removes the caller from a household. The last owner cannot strand the others: the member who
-- joined first becomes owner. If nobody else is left, the household is soft-deleted. The
-- caller's unused invites are deleted, since an invite only speaks for a current owner.
create or replace function public.leave_household(household_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  my_role public.household_members_role;
  successor uuid;
begin
  if uid is null then
    raise exception 'not_authenticated';
  end if;

  -- Serialize concurrent leaves of one household, so two owners leaving together cannot each
  -- see the other as the owner who stays and strand the members. NO KEY UPDATE blocks another
  -- leave but not the key-share lock redeem_invite takes through its foreign key, so the two
  -- cannot deadlock. Statements after this one see what the other leave committed.
  perform 1
  from public.households h
  where h.id = leave_household.household_id
  for no key update;

  select hm.role into my_role
  from public.household_members hm
  where hm.household_id = leave_household.household_id
    and hm.user_id = uid
  for update;

  if not found then
    raise exception 'not_a_member';
  end if;

  delete from public.household_invites hi
  where hi.household_id = leave_household.household_id
    and hi.created_by = uid
    and hi.used_at is null;

  if my_role = 'owner' and not exists (
    select 1 from public.household_members hm
    where hm.household_id = leave_household.household_id
      and hm.user_id <> uid
      and hm.role = 'owner'
  ) then
    select hm.user_id into successor
    from public.household_members hm
    where hm.household_id = leave_household.household_id
      and hm.user_id <> uid
    order by hm.created_at, hm.user_id
    limit 1;

    if successor is not null then
      update public.household_members hm
      set role = 'owner'
      where hm.household_id = leave_household.household_id
        and hm.user_id = successor;

      insert into public.audit_events (household_id, actor_user_id, kind, payload)
      values (
        leave_household.household_id,
        uid,
        'owner_transferred',
        jsonb_build_object('from', uid, 'to', successor)
      );
    else
      update public.households h
      set deleted_at = now()
      where h.id = leave_household.household_id;
    end if;
  end if;

  delete from public.household_members hm
  where hm.household_id = leave_household.household_id
    and hm.user_id = uid;
end;
$$;

-- The roster with names and avatars. profiles is private to each user, so members read each
-- other's display_name and avatar_url only through this function. Owners first.
create or replace function public.list_household_members(household_id uuid)
returns table (
  user_id uuid,
  role public.household_members_role,
  display_name text,
  avatar_url text,
  joined_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.household_members me
    where me.household_id = list_household_members.household_id
      and me.user_id = (select auth.uid())
  ) then
    raise exception 'not_a_member';
  end if;

  return query
  select hm.user_id, hm.role, p.display_name, p.avatar_url, hm.created_at
  from public.household_members hm
  left join public.profiles p on p.user_id = hm.user_id
  where hm.household_id = list_household_members.household_id
  order by (hm.role = 'owner') desc, hm.created_at, hm.user_id;
end;
$$;

-- Signed-in users only. Supabase grants new functions to anon by default; take that back.
revoke all on function public.create_household(text) from public, anon;
revoke all on function public.create_invite(uuid) from public, anon;
revoke all on function public.redeem_invite(text) from public, anon;
revoke all on function public.leave_household(uuid) from public, anon;
revoke all on function public.list_household_members(uuid) from public, anon;

grant execute on function public.create_household(text) to authenticated;
grant execute on function public.create_invite(uuid) to authenticated;
grant execute on function public.redeem_invite(text) to authenticated;
grant execute on function public.leave_household(uuid) to authenticated;
grant execute on function public.list_household_members(uuid) to authenticated;
