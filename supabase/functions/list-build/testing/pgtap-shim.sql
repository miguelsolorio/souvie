-- Test harness only (WS05). The small part of pgTAP that supabase/tests/004_rls_planning.sql and
-- 006_rls_lists.sql use, written in plain plpgsql so the real pgTAP files can run on PGlite, which
-- has no pgTAP extension and cannot start the Supabase stack (the development Mac has no container
-- runtime). CI runs the same files with the real pgTAP through `supabase test db`; this shim only
-- gives a builder the same pass or fail answer before pushing.
--
-- Supported: plan, ok, is, isnt, throws_ok (four arguments), lives_ok, is_empty, policies_are,
-- finish. Each returns the TAP line pgTAP would, so a runner can read them. State lives in
-- transaction-local settings, so any role can call these, including `authenticated`.

create or replace function extensions.__tap_count(name text) returns int
language sql stable as $$
  select coalesce(nullif(current_setting('tap.' || name, true), ''), '0')::int
$$;

create or replace function extensions.__tap_result(passed boolean, descr text, diag text default null)
returns text
language plpgsql as $$
declare
  n int := extensions.__tap_count('n') + 1;
begin
  perform set_config('tap.n', n::text, true);
  if not passed then
    perform set_config('tap.failed', (extensions.__tap_count('failed') + 1)::text, true);
  end if;
  return case when passed then 'ok ' else 'not ok ' end
    || n || coalesce(' - ' || nullif(descr, ''), '')
    || case when diag is null then '' else E'\n# ' || diag end;
end;
$$;

create or replace function extensions.plan(n int) returns text
language plpgsql as $$
begin
  perform set_config('tap.plan', n::text, true);
  perform set_config('tap.n', '0', true);
  perform set_config('tap.failed', '0', true);
  return '1..' || n;
end;
$$;

create or replace function extensions.ok(passed boolean, descr text default '') returns text
language sql as $$
  select extensions.__tap_result(coalesce(passed, false), descr)
$$;

create or replace function extensions.is(have anyelement, want anyelement, descr text default '')
returns text
language sql as $$
  select extensions.__tap_result(
    have is not distinct from want, descr,
    'have: ' || coalesce(have::text, 'NULL') || E'\n#   want: ' || coalesce(want::text, 'NULL')
  )
$$;

create or replace function extensions.isnt(have anyelement, want anyelement, descr text default '')
returns text
language sql as $$
  select extensions.__tap_result(have is distinct from want, descr)
$$;

create or replace function extensions.throws_ok(
  sql text, errcode text, errmsg text, descr text default ''
) returns text
language plpgsql as $$
declare
  got_state text;
  got_message text;
begin
  execute sql;
  return extensions.__tap_result(false, descr, 'no exception thrown, wanted ' || coalesce(errcode, errmsg));
exception when others then
  get stacked diagnostics got_state = returned_sqlstate, got_message = message_text;
  return extensions.__tap_result(
    (errcode is null or got_state = errcode) and (errmsg is null or got_message = errmsg),
    descr,
    'caught: ' || got_state || ': ' || got_message
      || E'\n#   wanted: ' || coalesce(errcode, 'any') || ': ' || coalesce(errmsg, 'any')
  );
end;
$$;

create or replace function extensions.lives_ok(sql text, descr text default '') returns text
language plpgsql as $$
declare
  got_state text;
  got_message text;
begin
  execute sql;
  return extensions.__tap_result(true, descr);
exception when others then
  get stacked diagnostics got_state = returned_sqlstate, got_message = message_text;
  return extensions.__tap_result(false, descr, 'died: ' || got_state || ': ' || got_message);
end;
$$;

create or replace function extensions.is_empty(sql text, descr text default '') returns text
language plpgsql as $$
declare
  found int;
begin
  execute 'select count(*) from (' || sql || ') q' into found;
  return extensions.__tap_result(found = 0, descr, found || ' row(s) returned');
end;
$$;

create or replace function extensions.policies_are(
  schema_name name, table_name name, want name[], descr text default ''
) returns text
language plpgsql as $$
declare
  have name[];
begin
  select coalesce(array_agg(policyname::name order by policyname), '{}')
    into have
    from pg_policies
   where schemaname = schema_name and tablename = table_name;
  return extensions.__tap_result(
    have @> want and have <@ want, descr,
    'have: ' || have::text || E'\n#   want: ' || want::text
  );
end;
$$;

create or replace function extensions.finish() returns setof text
language plpgsql as $$
declare
  planned int := extensions.__tap_count('plan');
  ran int := extensions.__tap_count('n');
  failed int := extensions.__tap_count('failed');
begin
  if planned <> ran then
    return next '# Looks like you planned ' || planned || ' tests but ran ' || ran;
  end if;
  if failed > 0 then
    return next '# Looks like you failed ' || failed || ' test(s) of ' || ran;
  end if;
end;
$$;

grant usage on schema extensions to public;
grant execute on all functions in schema extensions to public;
