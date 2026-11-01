-- WS08: Tier 3 assisted checkout host. docs/02-data-model.md §Identity (households.tier3_consent),
-- docs/04-integrations.md §Tier 3, docs/05-security-privacy.md §Retailer credentials and sessions.
--
-- What is here:
--   households.tier3_consent        {accepted_at, by_user_id, retailers[], copy_version}. Written
--                                   only by record_tier3_consent; no client UPDATE grant.
--   record_tier3_consent            a member accepts the consent copy for one or more Tier 3
--                                   retailers. At the stored copy version the list is a union; at
--                                   another version it is replaced by the retailers just accepted.
--   tier3_consent_version           the copy version the app shows now (consent.ts CONSENT_VERSION).
--   connect_browser_session         creates (or re-activates) the member's browser_session
--                                   connection after consent at the current copy version, with its
--                                   on-device session key in Vault.
--   connection_session_key          the connection's own member fetches that key to encrypt or
--                                   decrypt the session blob kept on the phone. Nobody else can.
--   revoke_browser_connection       Disconnect: deletes the Vault key and marks the row revoked.
--   household_ai_spend_since        today's model spend for llm-proxy's daily cap (service role).
--   Storage bucket run-screenshots  private; members read objects under their own runs'
--                                   <run_id>/ prefixes; the service role writes; 30-day lifecycle.
--
-- Sort order: after the WS07 retail migration (retailer_connections, Vault) and WS09's runs
-- migration (20261031100000), whose shopping_runs the screenshot policy reads. The policy reaches
-- shopping_runs through dynamic SQL, so this file also applies cleanly where that table is absent;
-- there it lets nobody read.
--
-- Retailer passwords never reach any table here, and neither does session state: the cookies and
-- storage stay on the phone, encrypted with the key below (docs/05).

-- ---------------------------------------------------------------------------------------
-- households.tier3_consent
-- ---------------------------------------------------------------------------------------

-- The Tier 3 retailer ids (packages/retailers TIER3_RETAILER_IDS). Albertsons and Haggen are
-- banners of safeway, the way QFC is a banner of kroger.
create or replace function public.tier3_retailer_ids()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['safeway', 'costco']::text[]
$$;

-- Shape check for the consent column. Immutable, so timestamps and uuids are checked by pattern
-- rather than by cast (a timestamptz cast depends on the session's settings).
create or replace function public.tier3_consent_is_valid(c jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select c is null or (
    jsonb_typeof(c) = 'object'
    and (select array_agg(k order by k) from jsonb_object_keys(c) as k)
      = array['accepted_at', 'by_user_id', 'copy_version', 'retailers']
    and jsonb_typeof(c -> 'accepted_at') = 'string'
    and (c ->> 'accepted_at') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
    and jsonb_typeof(c -> 'by_user_id') = 'string'
    and (c ->> 'by_user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and jsonb_typeof(c -> 'copy_version') = 'string'
    and (c ->> 'copy_version') ~ '^[A-Za-z0-9._-]{1,40}$'
    and jsonb_typeof(c -> 'retailers') = 'array'
    and jsonb_array_length(c -> 'retailers') between 1 and 8
    and not exists (
      select 1 from jsonb_array_elements(c -> 'retailers') as r
      where jsonb_typeof(r) <> 'string'
        or not ((r #>> '{}') = any (public.tier3_retailer_ids()))
    )
  )
$$;

alter table public.households
  add column tier3_consent jsonb;

alter table public.households
  add constraint households_tier3_consent_shape check (public.tier3_consent_is_valid(tier3_consent));

comment on column public.households.tier3_consent is
  'Tier 3 consent (WS08): {accepted_at, by_user_id, retailers[], copy_version}. Written only by record_tier3_consent.';

-- households is granted to clients by column (WS01). The new column gets no UPDATE grant: it is
-- written through record_tier3_consent only. The revoke is a no-op today and states the intent.
revoke update (tier3_consent) on public.households from anon, authenticated;

-- The consent copy version the app shows now: apps/mobile/src/features/tier3/consent.ts
-- CONSENT_VERSION (a test keeps the two equal). Changing the copy means a new CONSENT_VERSION and a
-- migration that replaces this function, so the database and the app agree on what is current.
create or replace function public.tier3_consent_version()
returns text
language sql
immutable
set search_path = ''
as $$
  select '2026-10-31'::text
$$;

-- ---------------------------------------------------------------------------------------
-- record_tier3_consent
-- ---------------------------------------------------------------------------------------

-- A member of the household accepts the consent copy at `copy_version` for `retailers`. When the
-- stored copy_version is the same, the stored list becomes the union of what was there and what
-- was passed. When it differs, the list is replaced by the retailers just accepted: the others were
-- accepted only at another copy, so they are not consented at this one (decided 2026-10-31).
-- accepted_at, by_user_id and copy_version are set to this acceptance. Returns the new column value.
create or replace function public.record_tier3_consent(
  household_id uuid,
  retailers text[],
  copy_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_existing jsonb;
  v_merged text[];
  v_value jsonb;
begin
  if v_user is null then
    raise exception 'not_signed_in' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.household_members m
    where m.household_id = record_tier3_consent.household_id and m.user_id = v_user
  ) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;
  if record_tier3_consent.retailers is null
    or cardinality(record_tier3_consent.retailers) = 0
    or exists (
      select 1 from unnest(record_tier3_consent.retailers) as r
      where r is null or not (r = any (public.tier3_retailer_ids()))
    )
  then
    raise exception 'invalid_retailers' using errcode = '22023';
  end if;
  if record_tier3_consent.copy_version is null
    or record_tier3_consent.copy_version !~ '^[A-Za-z0-9._-]{1,40}$'
  then
    raise exception 'invalid_copy_version' using errcode = '22023';
  end if;

  select h.tier3_consent into v_existing
  from public.households h
  where h.id = record_tier3_consent.household_id and h.deleted_at is null
  for update;
  if not found then
    raise exception 'household_not_found' using errcode = 'P0002';
  end if;

  if v_existing is not null and (v_existing ->> 'copy_version') = record_tier3_consent.copy_version then
    select coalesce(array_agg(distinct r order by r), array[]::text[]) into v_merged
    from (
      select jsonb_array_elements_text(coalesce(v_existing -> 'retailers', '[]'::jsonb)) as r
      union
      select unnest(record_tier3_consent.retailers)
    ) as all_retailers;
  else
    select coalesce(array_agg(distinct r order by r), array[]::text[]) into v_merged
    from unnest(record_tier3_consent.retailers) as t(r);
  end if;

  v_value := jsonb_build_object(
    'accepted_at', to_jsonb(now()),
    'by_user_id', v_user,
    'retailers', to_jsonb(v_merged),
    'copy_version', record_tier3_consent.copy_version
  );

  update public.households h
  set tier3_consent = v_value
  where h.id = record_tier3_consent.household_id;

  insert into public.audit_events (household_id, actor_user_id, kind, payload)
  values (
    record_tier3_consent.household_id, v_user, 'consent_given',
    jsonb_build_object(
      'retailers', to_jsonb(record_tier3_consent.retailers),
      'copy_version', record_tier3_consent.copy_version
    )
  );

  return v_value;
end;
$$;

revoke all on function public.record_tier3_consent(uuid, text[], text) from public, anon;
grant execute on function public.record_tier3_consent(uuid, text[], text) to authenticated;

-- ---------------------------------------------------------------------------------------
-- On-device session keys (docs/05 §Retailer credentials and sessions)
-- ---------------------------------------------------------------------------------------
-- A Tier 3 connection's session (cookies and site storage) is encrypted on the phone with a random
-- 256-bit key held in Vault, one key per connection. The phone fetches it with
-- connection_session_key while it runs, holds it in memory, and never stores it. Only the
-- connection's own member can fetch it: the session lives on that person's phone.

-- Creates a Vault secret holding a fresh key and returns its id.
create or replace function public.tier3_new_session_key(p_connection_id uuid)
returns uuid
language sql
volatile
security definer
set search_path = ''
as $$
  select vault.create_secret(
    encode(extensions.gen_random_bytes(32), 'base64'),
    'retailer_connection:' || p_connection_id::text || ':' || gen_random_uuid()::text,
    'On-device session key for browser_session retailer_connections ' || p_connection_id::text
      || ' (WS08). Never a password or session state.'
  )
$$;

revoke all on function public.tier3_new_session_key(uuid) from public, anon, authenticated;

-- After the person signs in on the retailer's page inside the app: creates the member's
-- browser_session connection, or re-activates a revoked or needs_reauth one, with a new key.
-- Requires the household's consent for the retailer at the current copy version (the gate's rule,
-- packages/retailers browser/gating.ts). Returns the connection id.
create or replace function public.connect_browser_session(
  household_id uuid,
  retailer public.retailer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_consent jsonb;
  v_id uuid;
  v_secret uuid;
  v_status public.retailer_connections_status;
  v_auth public.retailer_connections_auth_type;
  v_reconnect boolean := false;
begin
  if v_user is null then
    raise exception 'not_signed_in' using errcode = '42501';
  end if;
  if not (connect_browser_session.retailer::text = any (public.tier3_retailer_ids())) then
    raise exception 'not_a_tier3_retailer' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.household_members m
    where m.household_id = connect_browser_session.household_id and m.user_id = v_user
  ) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  select h.tier3_consent into v_consent
  from public.households h
  where h.id = connect_browser_session.household_id;
  if v_consent is null
    or not (v_consent -> 'retailers') ? connect_browser_session.retailer::text
  then
    raise exception 'consent_required' using errcode = '42501';
  end if;
  if (v_consent ->> 'copy_version') is distinct from public.tier3_consent_version() then
    raise exception 'stale_consent' using errcode = '42501';
  end if;

  select c.id, c.vault_secret_id, c.status, c.auth_type
    into v_id, v_secret, v_status, v_auth
  from public.retailer_connections c
  where c.household_id = connect_browser_session.household_id
    and c.user_id = v_user
    and c.retailer = connect_browser_session.retailer
  for update;

  if v_id is null then
    v_id := gen_random_uuid();
    v_secret := public.tier3_new_session_key(v_id);
    insert into public.retailer_connections (
      id, household_id, user_id, retailer, auth_type, vault_secret_id, status, last_verified_at
    ) values (
      v_id, connect_browser_session.household_id, v_user, connect_browser_session.retailer,
      'browser_session', v_secret, 'active', now()
    );
  else
    v_reconnect := true;
    if v_auth <> 'browser_session' then
      raise exception 'not_a_browser_connection' using errcode = '22023';
    end if;
    if v_status = 'revoked' or v_secret is null then
      v_secret := public.tier3_new_session_key(v_id);
    end if;
    update public.retailer_connections c
    set vault_secret_id = v_secret, status = 'active', last_verified_at = now()
    where c.id = v_id;
  end if;

  insert into public.audit_events (household_id, actor_user_id, kind, payload)
  values (
    connect_browser_session.household_id, v_user, 'connection_added',
    jsonb_build_object(
      'connection_id', v_id, 'retailer', connect_browser_session.retailer,
      'auth_type', 'browser_session', 'reconnect', v_reconnect
    )
  );

  return v_id;
end;
$$;

revoke all on function public.connect_browser_session(uuid, public.retailer) from public, anon;
grant execute on function public.connect_browser_session(uuid, public.retailer) to authenticated;

-- The decrypted session key, for the connection's own member only, while they still belong to the
-- household and the connection is not revoked. Creates the key if the connection has none.
create or replace function public.connection_session_key(connection_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_owner uuid;
  v_household uuid;
  v_secret uuid;
  v_status public.retailer_connections_status;
  v_auth public.retailer_connections_auth_type;
  v_key text;
begin
  if v_user is null then
    raise exception 'not_signed_in' using errcode = '42501';
  end if;
  select c.user_id, c.household_id, c.vault_secret_id, c.status, c.auth_type
    into v_owner, v_household, v_secret, v_status, v_auth
  from public.retailer_connections c
  where c.id = connection_session_key.connection_id
  for update;
  -- Same answer for "no such connection" and "not yours", so ids cannot be probed.
  if v_owner is null or v_owner <> v_user or v_auth <> 'browser_session' then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.household_members m
    where m.household_id = v_household and m.user_id = v_user
  ) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if v_status = 'revoked' then
    raise exception 'connection_revoked' using errcode = '42501';
  end if;

  if v_secret is not null then
    select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.id = v_secret;
  end if;
  if v_key is null then
    v_secret := public.tier3_new_session_key(connection_session_key.connection_id);
    update public.retailer_connections c
    set vault_secret_id = v_secret
    where c.id = connection_session_key.connection_id;
    select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.id = v_secret;
  end if;
  return v_key;
end;
$$;

revoke all on function public.connection_session_key(uuid) from public, anon;
grant execute on function public.connection_session_key(uuid) to authenticated;

-- Disconnect, from the connection's own member: the Vault key is deleted (so the blob on the phone
-- can never be decrypted again), the row is marked revoked, the household default is cleared if it
-- pointed here, and it is audited. The phone clears its cookie store and secure-store entry
-- (apps/mobile/src/features/tier3/secureSession.ts). Revoking twice is a no-op.
create or replace function public.revoke_browser_connection(connection_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_owner uuid;
  v_household uuid;
  v_secret uuid;
  v_status public.retailer_connections_status;
  v_auth public.retailer_connections_auth_type;
  v_retailer public.retailer;
begin
  if v_user is null then
    raise exception 'not_signed_in' using errcode = '42501';
  end if;
  select c.user_id, c.household_id, c.vault_secret_id, c.status, c.auth_type, c.retailer
    into v_owner, v_household, v_secret, v_status, v_auth, v_retailer
  from public.retailer_connections c
  where c.id = revoke_browser_connection.connection_id
  for update;
  if v_owner is null or v_owner <> v_user or v_auth <> 'browser_session' then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if v_status = 'revoked' and v_secret is null then
    return;
  end if;

  update public.retailer_connections c
  set status = 'revoked', vault_secret_id = null
  where c.id = revoke_browser_connection.connection_id;
  if v_secret is not null then
    delete from vault.secrets where id = v_secret;
  end if;

  update public.households h
  set default_connection_id = null
  where h.id = v_household and h.default_connection_id = revoke_browser_connection.connection_id;

  insert into public.audit_events (household_id, actor_user_id, kind, payload)
  values (
    v_household, v_user, 'connection_revoked',
    jsonb_build_object(
      'connection_id', revoke_browser_connection.connection_id, 'retailer', v_retailer,
      'auth_type', 'browser_session'
    )
  );
end;
$$;

revoke all on function public.revoke_browser_connection(uuid) from public, anon;
grant execute on function public.revoke_browser_connection(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------
-- llm-proxy's daily cap (service role)
-- ---------------------------------------------------------------------------------------

-- What a household has spent on model calls since a moment (the start of the UTC day for the
-- daily cap). Summed in SQL so PostgREST's row limit cannot undercount.
create or replace function public.household_ai_spend_since(
  p_household_id uuid,
  p_since timestamptz
)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(r.cost_usd), 0)
  from public.ai_runs r
  where r.household_id = p_household_id and r.created_at >= p_since
$$;

revoke all on function public.household_ai_spend_since(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.household_ai_spend_since(uuid, timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------
-- Storage: run-screenshots
-- ---------------------------------------------------------------------------------------
-- Private bucket. Objects live at <run_id>/<step>.jpg: one JPEG per browser step of a Tier 3 run
-- (WS10 writes them through the service role). A member reads the objects of their household's
-- runs only. Deleted after 30 days by the job below (docs/05 §Audit).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('run-screenshots', 'run-screenshots', false, 2097152, array['image/jpeg'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- True when the object's first path segment is a run of one of the caller's households.
-- shopping_runs (WS09) is read through dynamic SQL so this function does not depend on the order
-- the two migrations land in; without the table nobody can read.
create or replace function public.run_screenshot_readable(object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_first text := split_part(coalesce(object_name, ''), '/', 1);
  v_runs regclass := to_regclass('public.shopping_runs');
  v_found boolean;
begin
  if v_first !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or position('/' in coalesce(object_name, '')) = 0
  then
    return false;
  end if;
  if v_runs is null then
    return false;
  end if;
  -- The table name comes from to_regclass, so the statement is built at run time (and the schema
  -- linter does not resolve it against a database where WS09 has not landed).
  execute format(
    'select exists (select 1 from %s r where r.id = $1 '
      || 'and r.household_id in (select public.current_household_ids()))',
    v_runs
  )
    into v_found
    using v_first::uuid;
  return coalesce(v_found, false);
end;
$$;

revoke all on function public.run_screenshot_readable(text) from public, anon;
grant execute on function public.run_screenshot_readable(text) to authenticated, service_role;

create policy "run-screenshots: members read own runs" on storage.objects
  for select to authenticated
  using (bucket_id = 'run-screenshots' and public.run_screenshot_readable(name));

create policy "run-screenshots: service role writes" on storage.objects
  for insert to service_role
  with check (bucket_id = 'run-screenshots');

create policy "run-screenshots: service role deletes" on storage.objects
  for delete to service_role
  using (bucket_id = 'run-screenshots');

-- The lifecycle rule. Supabase Storage has no native object expiry, so a daily job removes objects
-- older than this. Known gap: deleting the storage.objects row does not remove the file from the
-- storage backend; the run-screenshot upload path (WS10) sweeps through the Storage API.
create or replace function public.run_screenshots_max_age()
returns interval
language sql
immutable
set search_path = ''
as $$
  select interval '30 days'
$$;

create or replace function public.expire_run_screenshots()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  -- Storage refuses direct deletes unless the API's own switch is on for this transaction.
  perform set_config('storage.allow_delete_query', 'true', true);
  delete from storage.objects o
  where o.bucket_id = 'run-screenshots'
    and o.created_at < now() - public.run_screenshots_max_age();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.expire_run_screenshots() from public, anon, authenticated;
grant execute on function public.expire_run_screenshots() to service_role;

-- Daily at 04:17 UTC. cron.schedule replaces a job of the same name, so a re-run is safe.
select cron.schedule(
  'run-screenshots-lifecycle',
  '17 4 * * *',
  'select public.expire_run_screenshots()'
);
