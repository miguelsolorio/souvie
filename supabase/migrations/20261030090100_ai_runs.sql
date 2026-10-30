-- WS02: ai_runs, one row per model call. docs/02-data-model.md §Ops, migration order 5.
--
-- WS02 is the first workstream to call a model through @mp/llm (WS03's parse-ingredients function
-- already writes here once the table exists). Writers are the Edge Functions and the worker, all
-- on the service role. Clients may read their household's rows; nobody on the client writes.
-- WS15 adds the cost views (v_ai_cost_daily, v_ai_cost_by_prompt) and the daily cap column.

create table public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  -- Null for system jobs.
  household_id uuid references public.households (id) on delete cascade,
  -- parse_ingredients, extract_recipe, suggest, agent_step, embed, ...
  kind text not null,
  model text not null,
  -- "<name>.v<n>" from the @mp/llm prompt registry, for example recipe-extract.v1.
  prompt_version text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cost_usd numeric not null default 0,
  latency_ms integer,
  ok boolean not null,
  error text,
  created_at timestamptz not null default now(),

  constraint ai_runs_kind_length check (char_length(kind) between 1 and 80),
  constraint ai_runs_tokens_nonnegative check (
    input_tokens >= 0 and output_tokens >= 0 and cache_read_tokens >= 0
  ),
  constraint ai_runs_cost_nonnegative check (cost_usd >= 0)
);

comment on table public.ai_runs is
  'One row per model call (docs/05 §Audit, risk R3). Service role writes; members read their household''s rows.';

create index ai_runs_household_created_idx on public.ai_runs (household_id, created_at);

revoke all on public.ai_runs from anon, authenticated;
grant select on public.ai_runs to authenticated;

alter table public.ai_runs enable row level security;

create policy "ai_runs: members read" on public.ai_runs
  for select to authenticated
  using (household_id in (select public.current_household_ids()));
