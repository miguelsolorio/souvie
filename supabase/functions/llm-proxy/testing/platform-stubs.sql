-- Test harness only (WS08). What the Tier 3 migration needs from a Supabase project beyond the
-- stubs suggest/testing/supabase-stubs.sql already gives (API roles, auth, storage): Vault and
-- pg_cron. Shapes follow the real extensions closely enough for our functions; nothing here ships.
--
--   vault.secrets / vault.decrypted_secrets / vault.create_secret / vault.update_secret
--     The real Vault encrypts `secret` at rest; this stand-in keeps it as text. Clients have no
--     usage on the schema, as on a real project.
--   cron.job / cron.schedule
--     Records the job; nothing runs it.

create schema if not exists vault;
revoke all on schema vault from public;

create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text not null default '',
  secret text not null,
  key_id uuid,
  nonce bytea,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create view vault.decrypted_secrets as
  select id, name, description, secret, secret as decrypted_secret, key_id, nonce, created_at,
    updated_at
  from vault.secrets;

create function vault.create_secret(
  new_secret text,
  new_name text default null,
  new_description text default '',
  new_key_id uuid default null
) returns uuid
language sql as $$
  insert into vault.secrets (secret, name, description, key_id)
  values (new_secret, new_name, coalesce(new_description, ''), new_key_id)
  returning id
$$;

create function vault.update_secret(
  secret_id uuid,
  new_secret text default null,
  new_name text default null,
  new_description text default null,
  new_key_id uuid default null
) returns void
language sql as $$
  update vault.secrets
  set secret = coalesce(new_secret, secret),
      name = coalesce(new_name, name),
      description = coalesce(new_description, description),
      key_id = coalesce(new_key_id, key_id),
      updated_at = now()
  where id = secret_id
$$;

revoke all on all tables in schema vault from public, anon, authenticated, service_role;
revoke all on all functions in schema vault from public, anon, authenticated, service_role;

create schema if not exists cron;

create table cron.job (
  jobid bigserial primary key,
  schedule text not null,
  command text not null,
  jobname text unique
);

create function cron.schedule(job_name text, schedule text, command text) returns bigint
language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid
$$;
