-- Orchestrator contract change on WS07's request (CCR2, 2026-10-30).
--
-- When a member leaves a household or is removed from it, every retailer connection that
-- member holds in that household is revoked the way retailer_disconnect does it: status
-- 'revoked', the Vault secret deleted, the household's default connection cleared, and an
-- audit event written. Without this the row stayed 'active' after the token had become
-- unreadable (retailer_read_refresh_token returns null for a non-member).
--
-- The audit row is written only while the household still exists: when a whole household is
-- deleted, the cascade removes its members and fires this trigger after the household row is
-- gone, and an insert referencing it would fail the foreign key and abort the deletion.

create or replace function public.retailer_revoke_on_member_removed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn record;
  v_household_exists boolean;
begin
  select exists (select 1 from public.households h where h.id = old.household_id)
    into v_household_exists;

  for v_conn in
    select c.id, c.vault_secret_id, c.retailer
    from public.retailer_connections c
    where c.household_id = old.household_id
      and c.user_id = old.user_id
      and c.status <> 'revoked'
    for update
  loop
    update public.retailer_connections c
    set status = 'revoked', vault_secret_id = null
    where c.id = v_conn.id;

    if v_conn.vault_secret_id is not null then
      delete from vault.secrets where id = v_conn.vault_secret_id;
    end if;

    if v_household_exists then
      update public.households h
      set default_connection_id = null
      where h.id = old.household_id and h.default_connection_id = v_conn.id;

      insert into public.audit_events (household_id, actor_user_id, kind, payload)
      values (
        old.household_id, (select auth.uid()), 'connection_revoked',
        jsonb_build_object(
          'connection_id', v_conn.id, 'retailer', v_conn.retailer,
          'user_id', old.user_id, 'reason', 'member_removed'
        )
      );
    end if;
  end loop;

  return old;
end;
$$;

revoke all on function public.retailer_revoke_on_member_removed() from public, anon, authenticated;

create trigger household_members_revoke_retail
  after delete on public.household_members
  for each row execute function public.retailer_revoke_on_member_removed();
