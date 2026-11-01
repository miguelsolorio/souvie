-- Test harness only (WS09). Stand-ins for the three Supabase extensions the retail and runs
-- migrations call and PGlite cannot load: Vault, pgmq (Supabase Queues) and pg_cron. Each keeps
-- the names, argument lists and observable behaviour our SQL relies on, nothing more. Nothing here
-- is a migration and nothing here ships. CI runs the real extensions (`supabase test db`).
--
-- Loaded by testing/db.ts after ../../suggest/testing/supabase-stubs.sql.

-- ---------------------------------------------------------------------------------------
-- Vault: secrets stored as plain text, which is fine for a throwaway WASM database.
-- ---------------------------------------------------------------------------------------

create schema if not exists vault;

create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text,
  description text,
  secret text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create view vault.decrypted_secrets as
  select id, name, description, secret, secret as decrypted_secret, created_at, updated_at
  from vault.secrets;

create function vault.create_secret(
  new_secret text, new_name text default null, new_description text default '',
  new_key_id uuid default null
) returns uuid
language sql as $$
  insert into vault.secrets (secret, name, description)
  values (new_secret, new_name, new_description)
  returning id
$$;

create function vault.update_secret(
  secret_id uuid, new_secret text default null, new_name text default null,
  new_description text default null, new_key_id uuid default null
) returns void
language sql as $$
  update vault.secrets
  set secret = coalesce(new_secret, secret), name = coalesce(new_name, name),
      description = coalesce(new_description, description), updated_at = now()
  where id = secret_id
$$;

-- ---------------------------------------------------------------------------------------
-- pgmq: one table per queue (q_<name>) and one archive (a_<name>), read with a visibility
-- timeout and FOR UPDATE SKIP LOCKED, as pgmq does. The schema gets no grant to the API roles.
-- ---------------------------------------------------------------------------------------

create schema if not exists pgmq;

create table pgmq.meta (
  queue_name text primary key,
  is_partitioned boolean not null default false,
  is_unlogged boolean not null default false,
  created_at timestamptz not null default now()
);

create type pgmq.message_record as (
  msg_id bigint, read_ct integer, enqueued_at timestamptz, vt timestamptz, message jsonb
);
create type pgmq.queue_record as (
  queue_name varchar, is_partitioned boolean, is_unlogged boolean, created_at timestamptz
);

create function pgmq."create"(queue_name text) returns void
language plpgsql as $$
begin
  execute format(
    'create table if not exists pgmq.%I (
       msg_id bigint generated always as identity primary key,
       read_ct integer not null default 0,
       enqueued_at timestamptz not null default now(),
       vt timestamptz not null,
       message jsonb)', 'q_' || queue_name);
  execute format(
    'create table if not exists pgmq.%I (
       msg_id bigint primary key,
       read_ct integer not null default 0,
       enqueued_at timestamptz not null,
       archived_at timestamptz not null default now(),
       vt timestamptz not null,
       message jsonb)', 'a_' || queue_name);
  insert into pgmq.meta (queue_name) values ("create".queue_name) on conflict do nothing;
end;
$$;

create function pgmq.list_queues() returns setof pgmq.queue_record
language sql as $$
  select m.queue_name::varchar, m.is_partitioned, m.is_unlogged, m.created_at from pgmq.meta m
$$;

create function pgmq.send(queue_name text, msg jsonb, delay integer default 0)
returns setof bigint
language plpgsql as $$
begin
  return query execute format(
    'insert into pgmq.%I (vt, message) values (clock_timestamp() + make_interval(secs => $2), $1)
     returning msg_id', 'q_' || queue_name)
  using msg, delay;
end;
$$;

create function pgmq.read(queue_name text, vt integer, qty integer)
returns setof pgmq.message_record
language plpgsql as $$
begin
  return query execute format(
    'with next as (
       select msg_id from pgmq.%1$I
       where vt <= clock_timestamp()
       order by msg_id
       limit $2
       for update skip locked)
     update pgmq.%1$I m
        set vt = clock_timestamp() + make_interval(secs => $1), read_ct = m.read_ct + 1
       from next
      where m.msg_id = next.msg_id
     returning m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message', 'q_' || queue_name)
  using vt, qty;
end;
$$;

create function pgmq.set_vt(queue_name text, msg_id bigint, vt integer)
returns setof pgmq.message_record
language plpgsql as $$
begin
  return query execute format(
    'update pgmq.%I m set vt = clock_timestamp() + make_interval(secs => $2)
      where m.msg_id = $1
     returning m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message', 'q_' || queue_name)
  using msg_id, vt;
end;
$$;

create function pgmq.archive(queue_name text, msg_id bigint) returns boolean
language plpgsql as $$
declare
  moved integer;
begin
  execute format(
    'with gone as (delete from pgmq.%I m where m.msg_id = $1 returning m.*)
     insert into pgmq.%I (msg_id, read_ct, enqueued_at, vt, message)
     select g.msg_id, g.read_ct, g.enqueued_at, g.vt, g.message from gone g',
    'q_' || queue_name, 'a_' || queue_name)
  using msg_id;
  get diagnostics moved = row_count;
  return moved > 0;
end;
$$;

create function pgmq.delete(queue_name text, msg_id bigint) returns boolean
language plpgsql as $$
declare
  gone integer;
begin
  execute format('delete from pgmq.%I m where m.msg_id = $1', 'q_' || queue_name) using msg_id;
  get diagnostics gone = row_count;
  return gone > 0;
end;
$$;

revoke all on schema pgmq from public;

-- ---------------------------------------------------------------------------------------
-- pg_cron: the job table and cron.schedule (replace by name). Nothing runs on a schedule here;
-- tests call the scheduled function directly.
-- ---------------------------------------------------------------------------------------

create schema if not exists cron;

create table cron.job (
  jobid bigint generated always as identity primary key,
  schedule text not null,
  command text not null,
  jobname text unique,
  active boolean not null default true
);

create function cron.schedule(job_name text, schedule text, command text) returns bigint
language plpgsql as $$
declare
  id bigint;
begin
  insert into cron.job (jobname, schedule, command)
  values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid into id;
  return id;
end;
$$;
