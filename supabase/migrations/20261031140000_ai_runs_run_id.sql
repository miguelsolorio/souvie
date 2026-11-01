-- ai_runs.run_id (orchestrator, 2026-10-31, requested by WS08's llm-proxy and useful to WS09).
-- Ties a model call to a shopping run so a per-run cost cap can sum the run's calls instead of
-- counting each call alone. Nullable: imports, parsing and suggestions have no run.

alter table public.ai_runs
  add column run_id uuid references public.shopping_runs (id) on delete set null;

create index ai_runs_household_run_idx on public.ai_runs (household_id, run_id);

comment on column public.ai_runs.run_id is
  'The shopping run this call belongs to, when any; null for imports, parsing, suggestions and system jobs.';
