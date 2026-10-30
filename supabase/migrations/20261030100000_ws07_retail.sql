-- WS07: retail. docs/02-data-model.md §Retail, migration order 9.
--
-- Tables: retailer_connections, product_matches, retailer_quota_usage. Also here: the foreign key
-- from households.default_connection_id (WS01 left it bare for this migration), the Vault-backed
-- functions the retailer-oauth Edge Function and the worker call, and the quota counter.
--
-- Sort order: after 20261030072000_ingredients.sql (product_matches.ingredient_id references
-- ingredients) and the identity migrations (households, helpers, audit_events).
--
-- Kroger's terms shape this file (docs/04-integrations.md §Kroger, docs/02 §Retention):
--   * No table receives search results or catalog data. product_matches holds only the choice a
--     person confirmed: ids, the name as displayed, and the size. What the store charges and
--     whether it has the item are fetched live every run and never stored.
--   * Refresh tokens live in Supabase Vault. retailer_connections.vault_secret_id points at the
--     secret and is never readable by the anon or authenticated roles.
--
-- Who writes what:
--   retailer_connections   the retailer-oauth Edge Function and the worker, through the security
--                          definer functions below (service role only). Members read their
--                          household's rows minus vault_secret_id. The connection's own user and
--                          household owners may change store_id, store_name, and modality.
--   product_matches        members, for choices they confirm (chosen_by = 'user'); the worker
--                          (service role) for agent choices.
--   retailer_quota_usage   the worker and Edge Functions only, through retailer_quota_consume.

create extension if not exists supabase_vault with schema vault;

-- ---------------------------------------------------------------------------------------
-- Enums. `retailer` is shared by several tables, so it keeps the bare name docs/02 gives it.
-- ---------------------------------------------------------------------------------------

create type public.retailer as enum ('kroger', 'instacart', 'safeway', 'costco');
create type public.retailer_connections_auth_type as enum ('oauth', 'browser_session', 'none');
create type public.retailer_connections_modality as enum ('pickup', 'delivery');
create type public.retailer_connections_status as enum ('active', 'needs_reauth', 'revoked');
create type public.product_matches_chosen_by as enum ('agent', 'user');

-- ---------------------------------------------------------------------------------------
-- retailer_connections
-- ---------------------------------------------------------------------------------------

create table public.retailer_connections (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  -- The member whose retailer account this is.
  user_id uuid not null references auth.users (id) on delete cascade,
  retailer public.retailer not null,
  auth_type public.retailer_connections_auth_type not null,
  -- vault.secrets.id: a refresh token (oauth) or session state (browser_session). Never a
  -- password. Null once revoked.
  vault_secret_id uuid,
  -- Kroger locationId, Instacart retailer_key, or a site-specific store id.
  store_id text,
  store_name text,
  modality public.retailer_connections_modality not null default 'pickup',
  status public.retailer_connections_status not null default 'active',
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One account per member per retailer in a household. Reconnecting reuses the row.
  constraint retailer_connections_member_retailer_key unique (household_id, user_id, retailer),
  constraint retailer_connections_store_id_format check (
    store_id is null or store_id ~ '^[A-Za-z0-9_-]{1,64}$'
  ),
  constraint retailer_connections_store_name_length check (
    store_name is null or char_length(store_name) <= 200
  ),
  -- A live OAuth or browser connection always has its secret; a revoked one never does.
  constraint retailer_connections_secret_matches_status check (
    (status = 'revoked' and vault_secret_id is null)
    or (status <> 'revoked' and (auth_type = 'none' or vault_secret_id is not null))
  )
);

comment on table public.retailer_connections is
  'A household member''s retailer account (WS07). Tokens are in Vault, never in this table.';
comment on column public.retailer_connections.vault_secret_id is
  'vault.secrets id. Readable by the service role only; anon and authenticated have no grant.';

create index retailer_connections_household_idx on public.retailer_connections (household_id);
create index retailer_connections_user_idx on public.retailer_connections (user_id);

create trigger retailer_connections_set_updated_at
  before update on public.retailer_connections
  for each row execute function public.set_updated_at();

-- WS01 left households.default_connection_id without a foreign key for this migration.
alter table public.households
  add constraint households_default_connection_id_fkey
  foreign key (default_connection_id) references public.retailer_connections (id)
  on delete set null;

create index households_default_connection_id_idx on public.households (default_connection_id);

-- A connection row that goes away (its member's account deleted, its household deleted) takes
-- its Vault secret with it, so no token outlives the row that points at it.
create or replace function public.retailer_connections_delete_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.vault_secret_id is not null then
    delete from vault.secrets where id = old.vault_secret_id;
  end if;
  return old;
end;
$$;

revoke all on function public.retailer_connections_delete_secret() from public, anon, authenticated;

create trigger retailer_connections_delete_secret
  after delete on public.retailer_connections
  for each row execute function public.retailer_connections_delete_secret();

-- ---------------------------------------------------------------------------------------
-- product_matches: learned "always buy X". The confirmed choice only.
-- ---------------------------------------------------------------------------------------

create table public.product_matches (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  retailer public.retailer not null,
  store_id text not null,
  ingredient_id uuid not null references public.ingredients (id) on delete cascade,
  -- Retailer product id, from the API at the moment the choice was made (R13).
  product_id text not null,
  upc text,
  -- The name as displayed when chosen.
  product_name text not null,
  size text,
  confidence numeric,
  chosen_by public.product_matches_chosen_by not null,
  -- The person said "always this".
  pinned boolean not null default false,
  last_chosen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint product_matches_choice_key
    unique (household_id, retailer, store_id, ingredient_id, product_id),
  constraint product_matches_store_id_format check (store_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  constraint product_matches_product_id_format check (product_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  constraint product_matches_upc_format check (upc is null or upc ~ '^[0-9]{8,14}$'),
  constraint product_matches_product_name_length check (
    char_length(product_name) between 1 and 500
  ),
  constraint product_matches_size_length check (size is null or char_length(size) <= 100),
  constraint product_matches_confidence_range check (
    confidence is null or confidence between 0 and 1
  )
);

comment on table public.product_matches is
  'A household''s confirmed product for an ingredient at a store (WS07). Ids, name, size only: '
  'Kroger forbids storing search-derived data, so nothing else about the product is kept here.';

create index product_matches_household_idx on public.product_matches (household_id);
create index product_matches_lookup_idx
  on public.product_matches (household_id, retailer, store_id, ingredient_id);
create index product_matches_ingredient_idx on public.product_matches (ingredient_id);

create trigger product_matches_set_updated_at
  before update on public.product_matches
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------
-- retailer_quota_usage: daily call counts per retailer endpoint (R15). Global, not per household:
-- the quota belongs to our client id.
-- ---------------------------------------------------------------------------------------

create table public.retailer_quota_usage (
  retailer public.retailer not null,
  endpoint text not null,
  -- The retailer's day. Kroger resets at 00:00 UTC.
  day date not null,
  count integer not null default 0,
  updated_at timestamptz not null default now(),

  primary key (retailer, endpoint, day),
  constraint retailer_quota_usage_endpoint_format check (endpoint ~ '^[a-z_]{1,40}$'),
  constraint retailer_quota_usage_count_range check (count >= 0)
);

comment on table public.retailer_quota_usage is
  'Daily API call counts per retailer endpoint (WS07). Service role only.';

-- ---------------------------------------------------------------------------------------
-- Table privileges and RLS (supabase/README.md §RLS conventions)
-- ---------------------------------------------------------------------------------------

revoke all on public.retailer_connections, public.product_matches, public.retailer_quota_usage
  from anon, authenticated;

-- Every column except vault_secret_id. `select *` fails for clients on purpose.
grant select (
  id, household_id, user_id, retailer, auth_type, store_id, store_name, modality, status,
  last_verified_at, created_at, updated_at
) on public.retailer_connections to authenticated;
-- Picking a store and a modality is a client action. Everything else goes through the
-- functions below, so a client can neither forge a connection nor point one at a secret.
grant update (store_id, store_name, modality) on public.retailer_connections to authenticated;

grant select, delete on public.product_matches to authenticated;
grant insert (
  household_id, retailer, store_id, ingredient_id, product_id, upc, product_name, size,
  confidence, chosen_by, pinned, last_chosen_at
) on public.product_matches to authenticated;
-- A choice never moves to another household, store, ingredient, or product: confirm a new row.
grant update (product_name, size, confidence, chosen_by, pinned, last_chosen_at)
  on public.product_matches to authenticated;

alter table public.retailer_connections enable row level security;
alter table public.product_matches enable row level security;
alter table public.retailer_quota_usage enable row level security;

create policy "retailer_connections: members read" on public.retailer_connections
  for select to authenticated
  using (household_id in (select public.current_household_ids()));

-- The connection's own member, or an owner of the household (docs/02 §RLS pattern: changing
-- retailer connections is an owner action; the account holder may manage their own).
create policy "retailer_connections: holder or owner update" on public.retailer_connections
  for update to authenticated
  using (
    household_id in (select public.current_household_ids())
    and (user_id = auth.uid() or household_id in (select public.owned_household_ids()))
  )
  with check (
    household_id in (select public.current_household_ids())
    and (user_id = auth.uid() or household_id in (select public.owned_household_ids()))
  );

create policy "product_matches: members read" on public.product_matches
  for select to authenticated
  using (household_id in (select public.current_household_ids()));

-- Rows a client writes are choices a person made.
create policy "product_matches: members insert" on public.product_matches
  for insert to authenticated
  with check (
    household_id in (select public.current_household_ids())
    and chosen_by = 'user'
  );

create policy "product_matches: members update" on public.product_matches
  for update to authenticated
  using (household_id in (select public.current_household_ids()))
  with check (
    household_id in (select public.current_household_ids())
    and chosen_by = 'user'
  );

create policy "product_matches: members delete" on public.product_matches
  for delete to authenticated
  using (household_id in (select public.current_household_ids()));

-- retailer_quota_usage: RLS on, no policies. Only the service role (which bypasses RLS) and the
-- functions below touch it.

-- ---------------------------------------------------------------------------------------
-- Connection functions (service role only). The retailer-oauth Edge Function and the worker
-- call these through supabase-js rpc. Each checks membership itself: the service role bypasses
-- RLS, so nothing else would.
-- ---------------------------------------------------------------------------------------

-- Creates or re-activates the member's OAuth connection and stores the refresh token in Vault.
-- Reconnecting replaces the secret in place. Sets the household default when it has none.
create or replace function public.retailer_save_oauth_connection(
  p_household_id uuid,
  p_user_id uuid,
  p_retailer public.retailer,
  p_refresh_token text,
  p_store_id text default null,
  p_store_name text default null,
  p_modality public.retailer_connections_modality default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_secret uuid;
  v_reconnect boolean := false;
begin
  if p_refresh_token is null or char_length(p_refresh_token) < 8 then
    raise exception 'invalid_token';
  end if;
  if not exists (
    select 1 from public.household_members m
    where m.household_id = p_household_id and m.user_id = p_user_id
  ) then
    raise exception 'not_a_member';
  end if;

  select c.id, c.vault_secret_id into v_id, v_secret
  from public.retailer_connections c
  where c.household_id = p_household_id and c.user_id = p_user_id and c.retailer = p_retailer
  for update;

  if v_id is null then
    v_id := gen_random_uuid();
  else
    v_reconnect := true;
  end if;

  if v_secret is null then
    v_secret := vault.create_secret(
      p_refresh_token,
      'retailer_connection:' || v_id::text,
      'OAuth refresh token for retailer_connections ' || v_id::text || ' (WS07)'
    );
  else
    perform vault.update_secret(v_secret, p_refresh_token);
  end if;

  if v_reconnect then
    update public.retailer_connections c
    set auth_type = 'oauth',
        vault_secret_id = v_secret,
        status = 'active',
        last_verified_at = now(),
        store_id = coalesce(p_store_id, c.store_id),
        store_name = coalesce(p_store_name, c.store_name),
        modality = coalesce(p_modality, c.modality)
    where c.id = v_id;
  else
    insert into public.retailer_connections (
      id, household_id, user_id, retailer, auth_type, vault_secret_id, store_id, store_name,
      modality, status, last_verified_at
    ) values (
      v_id, p_household_id, p_user_id, p_retailer, 'oauth', v_secret, p_store_id, p_store_name,
      coalesce(p_modality, 'pickup'), 'active', now()
    );
  end if;

  update public.households h
  set default_connection_id = v_id
  where h.id = p_household_id and h.default_connection_id is null;

  insert into public.audit_events (household_id, actor_user_id, kind, payload)
  values (
    p_household_id, p_user_id, 'connection_added',
    jsonb_build_object('connection_id', v_id, 'retailer', p_retailer, 'reconnect', v_reconnect)
  );

  return v_id;
end;
$$;

-- The current refresh token, for a connection that is not revoked and whose member still
-- belongs to the household. Null otherwise: a member who left takes their account with them.
create or replace function public.retailer_read_refresh_token(p_connection_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  select s.decrypted_secret into v_token
  from public.retailer_connections c
  join public.household_members m
    on m.household_id = c.household_id and m.user_id = c.user_id
  join vault.decrypted_secrets s on s.id = c.vault_secret_id
  where c.id = p_connection_id and c.status <> 'revoked';
  return v_token;
end;
$$;

-- Kroger reissues the refresh token on every refresh. Replace the secret in place, so the old
-- value is gone, and record that the connection worked.
create or replace function public.retailer_rotate_refresh_token(
  p_connection_id uuid,
  p_refresh_token text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid;
begin
  if p_refresh_token is null or char_length(p_refresh_token) < 8 then
    raise exception 'invalid_token';
  end if;
  select c.vault_secret_id into v_secret
  from public.retailer_connections c
  where c.id = p_connection_id and c.status <> 'revoked'
  for update;
  if v_secret is null then
    raise exception 'connection_not_found';
  end if;
  perform vault.update_secret(v_secret, p_refresh_token);
  update public.retailer_connections c
  set last_verified_at = now(), status = 'active'
  where c.id = p_connection_id;
end;
$$;

-- A 401 the adapter could not recover from. The app prompts the connection's member.
create or replace function public.retailer_mark_needs_reauth(p_connection_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.retailer_connections c
  set status = 'needs_reauth'
  where c.id = p_connection_id and c.status = 'active';
$$;

-- Disconnect: deletes the Vault secret, marks the row revoked, clears the household default if
-- it pointed here, and audits it. Allowed for the connection's member and household owners.
-- Kroger's public tier has no revocation endpoint; deleting our only copy of the token is the
-- revocation.
create or replace function public.retailer_disconnect(p_connection_id uuid, p_actor_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  v_user uuid;
  v_secret uuid;
  v_retailer public.retailer;
begin
  select c.household_id, c.user_id, c.vault_secret_id, c.retailer
    into v_household, v_user, v_secret, v_retailer
  from public.retailer_connections c
  where c.id = p_connection_id
  for update;
  if v_household is null then
    raise exception 'connection_not_found';
  end if;
  if p_actor_user_id is distinct from v_user and not exists (
    select 1 from public.household_members m
    where m.household_id = v_household and m.user_id = p_actor_user_id and m.role = 'owner'
  ) then
    raise exception 'not_allowed';
  end if;

  update public.retailer_connections c
  set status = 'revoked', vault_secret_id = null
  where c.id = p_connection_id;
  if v_secret is not null then
    delete from vault.secrets where id = v_secret;
  end if;

  update public.households h
  set default_connection_id = null
  where h.id = v_household and h.default_connection_id = p_connection_id;

  insert into public.audit_events (household_id, actor_user_id, kind, payload)
  values (
    v_household, p_actor_user_id, 'connection_revoked',
    jsonb_build_object('connection_id', p_connection_id, 'retailer', v_retailer)
  );
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Quota counter (service role only). Atomic across processes: the row lock serializes
-- concurrent callers, and the ceiling is re-checked under the lock.
-- ---------------------------------------------------------------------------------------

create or replace function public.retailer_quota_consume(
  p_retailer public.retailer,
  p_endpoint text,
  p_day date,
  p_ceiling integer,
  p_amount integer default 1
)
returns table (allowed boolean, used integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_amount is null or p_amount < 1 then
    raise exception 'invalid_amount';
  end if;
  insert into public.retailer_quota_usage (retailer, endpoint, day, count)
  values (p_retailer, p_endpoint, p_day, 0)
  on conflict on constraint retailer_quota_usage_pkey do nothing;

  update public.retailer_quota_usage q
  set count = q.count + p_amount, updated_at = now()
  where q.retailer = p_retailer and q.endpoint = p_endpoint and q.day = p_day
    and q.count + p_amount <= p_ceiling
  returning q.count into v_count;

  if v_count is not null then
    return query select true, v_count;
    return;
  end if;
  select q.count into v_count
  from public.retailer_quota_usage q
  where q.retailer = p_retailer and q.endpoint = p_endpoint and q.day = p_day;
  return query select false, coalesce(v_count, 0);
end;
$$;

-- Raises the day's count to at least p_count, from the retailer's own rate-limit headers.
create or replace function public.retailer_quota_raise(
  p_retailer public.retailer,
  p_endpoint text,
  p_day date,
  p_count integer
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.retailer_quota_usage as q (retailer, endpoint, day, count)
  values (p_retailer, p_endpoint, p_day, greatest(p_count, 0))
  on conflict on constraint retailer_quota_usage_pkey
  do update set count = greatest(q.count, excluded.count), updated_at = now();
$$;

revoke all on function public.retailer_save_oauth_connection(
  uuid, uuid, public.retailer, text, text, text, public.retailer_connections_modality
) from public, anon, authenticated;
revoke all on function public.retailer_read_refresh_token(uuid) from public, anon, authenticated;
revoke all on function public.retailer_rotate_refresh_token(uuid, text)
  from public, anon, authenticated;
revoke all on function public.retailer_mark_needs_reauth(uuid) from public, anon, authenticated;
revoke all on function public.retailer_disconnect(uuid, uuid) from public, anon, authenticated;
revoke all on function public.retailer_quota_consume(public.retailer, text, date, integer, integer)
  from public, anon, authenticated;
revoke all on function public.retailer_quota_raise(public.retailer, text, date, integer)
  from public, anon, authenticated;

grant execute on function public.retailer_save_oauth_connection(
  uuid, uuid, public.retailer, text, text, text, public.retailer_connections_modality
) to service_role;
grant execute on function public.retailer_read_refresh_token(uuid) to service_role;
grant execute on function public.retailer_rotate_refresh_token(uuid, text) to service_role;
grant execute on function public.retailer_mark_needs_reauth(uuid) to service_role;
grant execute on function public.retailer_disconnect(uuid, uuid) to service_role;
grant execute on function public.retailer_quota_consume(public.retailer, text, date, integer, integer)
  to service_role;
grant execute on function public.retailer_quota_raise(public.retailer, text, date, integer)
  to service_role;
