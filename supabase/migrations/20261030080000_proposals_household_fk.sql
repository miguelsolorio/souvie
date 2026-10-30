-- Orchestrator contract change (WS03 contract change request 2, accepted 2026-10-30).
-- ingredient_alias_proposals.household_id was a bare uuid because the WS01 identity
-- migration had not merged when WS03 was built. Both are on main now, so tie it to
-- households. Proposals outlive a deleted household as anonymous rows.
alter table public.ingredient_alias_proposals
  add constraint ingredient_alias_proposals_household_id_fkey
  foreign key (household_id) references public.households (id) on delete set null;
