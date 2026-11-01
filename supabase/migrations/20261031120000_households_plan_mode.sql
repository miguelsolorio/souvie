-- Simple planning mode (orchestrator, CCR7, 2026-10-31). Miguel asked for a mode that plans one
-- meal a day, on by default, chosen during onboarding and changeable in household settings.
-- The setting is per household because the plan is shared. Entries in slots the mode hides stay
-- in the plan and still feed the grocery list; switching modes never deletes anything.

create type public.households_plan_mode as enum ('simple', 'full');

alter table public.households
  add column plan_mode public.households_plan_mode not null default 'simple';

comment on column public.households.plan_mode is
  'simple shows one dinner a day in the planner; full shows every slot. Entries in hidden slots stay and still feed the list. Owner-editable through the existing "households: owners update" policy.';

-- The existing update grant is column-level (name, zip); the policy already limits it to owners.
grant update (plan_mode) on public.households to authenticated;
