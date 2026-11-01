-- Test harness only (WS08). The one pgTAP function supabase/tests/ws08_tier3_rls.sql uses that the
-- WS05 shim (../../list-build/testing/pgtap-shim.sql) does not have. Same TAP output contract.

create or replace function extensions.column_privs_are(
  schema_name name, table_name name, column_name name, role_name name, want text[],
  descr text default ''
) returns text
language plpgsql as $$
declare
  have text[] := '{}';
  priv text;
  target text := quote_ident(schema_name) || '.' || quote_ident(table_name);
begin
  foreach priv in array array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] loop
    if has_column_privilege(role_name, target, column_name, priv) then
      have := have || priv;
    end if;
  end loop;
  return extensions.__tap_result(
    have @> want and have <@ want, descr,
    'have: ' || have::text || E'\n#   want: ' || want::text
  );
end;
$$;

grant execute on function extensions.column_privs_are(name, name, name, name, text[], text) to public;
