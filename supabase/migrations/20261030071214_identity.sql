-- WS01: identity. docs/02-data-model.md §Identity, migration order 2.
--
-- Tables: households, household_members, household_invites, profiles, audit_events.
-- Also here: the two RLS helpers every later policy uses, the policies for these tables,
-- the profile and audit triggers, and the private `avatars` Storage bucket.
-- The RPCs (create_household, create_invite, redeem_invite, ...) are in the next migration.
--
-- Deviation from the docs' file split: current_household_ids() lives here, not in
-- identity_functions, because CREATE POLICY needs the function to exist already.
-- Conventions for later migrations: supabase/README.md.

-- ---------------------------------------------------------------------------------------
-- Enums and shared trigger function
-- ---------------------------------------------------------------------------------------

create type public.household_members_role as enum ('owner', 'member');

-- Keeps updated_at current. Reuse it on any table that has the column:
--   create trigger <table>_set_updated_at before update on public.<table>
--     for each row execute function public.set_updated_at();
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------

-- One per group of people who eat together.
create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  zip text,
  -- References retailer_connections(id). The foreign key is added by WS07, which owns that table.
  default_connection_id uuid,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.household_members (
  household_id uuid not null references public.households (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.household_members_role not null default 'member',
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

-- current_household_ids() looks members up by user.
create index household_members_user_id_idx on public.household_members (user_id);

-- Short-lived, single-use invite links. Created by create_invite(), consumed by redeem_invite().
create table public.household_invites (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  token text not null unique,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_at timestamptz,
  used_by uuid references auth.users (id) on delete set null
);

create index household_invites_household_id_idx on public.household_invites (household_id);

-- Per user, not per household. preferences is validated by core.ProfilePreferences (WS06 fills it).
-- WS06 adds onboarding_step, taste_embedding, and costco_member in its own migration.
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) <= 80),
  -- Object path inside the `avatars` bucket: <user_id>/<file>. Never an external URL.
  avatar_url text,
  preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Who changed what. Written by triggers and security-definer functions, never by clients.
-- WS01 writes member_added, member_removed, and owner_transferred. WS07, WS09, and WS10 write
-- connection_*, policy_changed, and consent_given.
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  actor_user_id uuid references auth.users (id) on delete set null,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_events_household_created_idx on public.audit_events (household_id, created_at desc);

create trigger households_set_updated_at
  before update on public.households
  for each row execute function public.set_updated_at();

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------
-- RLS helpers
-- ---------------------------------------------------------------------------------------
-- Security definer so the lookup bypasses RLS on household_members. Without that, a policy on
-- household_members that reads household_members recurses forever.

create or replace function public.current_household_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select hm.household_id
  from public.household_members hm
  where hm.user_id = (select auth.uid())
$$;

create or replace function public.owned_household_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select hm.household_id
  from public.household_members hm
  where hm.user_id = (select auth.uid())
    and hm.role = 'owner'
$$;

-- True when the caller and the named user (a uuid as text) share at least one household.
-- Takes text so the Storage policy can pass a path segment without casting it.
create or replace function public.is_household_peer(other_user text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.household_members mine
    join public.household_members theirs on theirs.household_id = mine.household_id
    where mine.user_id = (select auth.uid())
      and theirs.user_id::text = other_user
  )
$$;

revoke all on function public.current_household_ids() from public, anon;
revoke all on function public.owned_household_ids() from public, anon;
revoke all on function public.is_household_peer(text) from public, anon;
grant execute on function public.current_household_ids() to authenticated, service_role;
grant execute on function public.owned_household_ids() to authenticated, service_role;
grant execute on function public.is_household_peer(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- Table privileges and RLS
-- ---------------------------------------------------------------------------------------
-- Supabase grants every role all privileges on new tables in `public`. Narrow that to what the
-- client may do, then let policies decide which rows. Anonymous users get nothing here.
-- Writes that the client may not do directly go through the security-definer functions.

revoke all on public.households, public.household_members, public.household_invites,
  public.profiles, public.audit_events from anon, authenticated;

grant select, update on public.households to authenticated;
grant select, delete on public.household_members to authenticated;
grant select, delete on public.household_invites to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select on public.audit_events to authenticated;

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.household_invites enable row level security;
alter table public.profiles enable row level security;
alter table public.audit_events enable row level security;

-- households: members read; owners rename. Creation is create_household() only.
create policy "households: members read" on public.households
  for select to authenticated
  using (id in (select public.current_household_ids()));

create policy "households: owners update" on public.households
  for update to authenticated
  using (id in (select public.owned_household_ids()))
  with check (id in (select public.owned_household_ids()));

-- household_members: members read the roster; owners remove other members.
-- Joining is redeem_invite() or create_household(); leaving is leave_household().
create policy "household_members: members read" on public.household_members
  for select to authenticated
  using (household_id in (select public.current_household_ids()));

create policy "household_members: owners remove members" on public.household_members
  for delete to authenticated
  using (
    role = 'member'
    and user_id <> (select auth.uid())
    and household_id in (select public.owned_household_ids())
  );

-- household_invites: only owners see or revoke invites. Tokens are bearer secrets.
create policy "household_invites: owners read" on public.household_invites
  for select to authenticated
  using (household_id in (select public.owned_household_ids()));

create policy "household_invites: owners revoke" on public.household_invites
  for delete to authenticated
  using (used_at is null and household_id in (select public.owned_household_ids()));

-- profiles: a user sees and edits only their own row. preferences are personal (docs/05
-- §Privacy). Members see each other's name and avatar through list_household_members().
create policy "profiles: own read" on public.profiles
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "profiles: own insert" on public.profiles
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "profiles: own update" on public.profiles
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- audit_events: members read their household's trail. No client write policy exists.
create policy "audit_events: members read" on public.audit_events
  for select to authenticated
  using (household_id in (select public.current_household_ids()));

-- ---------------------------------------------------------------------------------------
-- Profiles for new users
-- ---------------------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (
    new.id,
    left(nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', '')), ''), 80)
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Users that signed up before this migration (the hosted project may have test users).
insert into public.profiles (user_id)
select u.id from auth.users u
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------------------
-- Audit trail for membership changes
-- ---------------------------------------------------------------------------------------

-- Two functions, one per event, so each only touches the row (NEW or OLD) that exists.
create or replace function public.audit_member_added()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_events (household_id, actor_user_id, kind, payload)
  values (
    new.household_id,
    (select auth.uid()),
    'member_added',
    jsonb_build_object('user_id', new.user_id, 'role', new.role, 'invited_by', new.invited_by)
  );
  return new;
end;
$$;

create or replace function public.audit_member_removed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A household delete cascades to its members. The household row is already gone by then, and
  -- so is the audit trail, so there is nothing to record.
  if exists (select 1 from public.households h where h.id = old.household_id) then
    insert into public.audit_events (household_id, actor_user_id, kind, payload)
    values (
      old.household_id,
      (select auth.uid()),
      'member_removed',
      jsonb_build_object(
        'user_id', old.user_id,
        'role', old.role,
        'self', coalesce(old.user_id = (select auth.uid()), false)
      )
    );
  end if;
  return old;
end;
$$;

revoke all on function public.audit_member_added() from public, anon, authenticated;
revoke all on function public.audit_member_removed() from public, anon, authenticated;

create trigger household_members_audit_insert
  after insert on public.household_members
  for each row execute function public.audit_member_added();

create trigger household_members_audit_delete
  after delete on public.household_members
  for each row execute function public.audit_member_removed();

-- ---------------------------------------------------------------------------------------
-- Storage: avatars
-- ---------------------------------------------------------------------------------------
-- Private bucket. Objects live at <user_id>/<file>. A user writes only inside their own folder;
-- they read their own and those of people who share a household. The app uses signed URLs.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "avatars: write own folder" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "avatars: update own folder" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "avatars: delete own folder" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "avatars: read own and household" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'avatars'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or public.is_household_peer((storage.foldername(name))[1])
    )
  );
