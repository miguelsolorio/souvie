# WS15: Observability & AI evals in CI

**Wave:** 6 · **Suggested model:** Sonnet · **Branch:** `ws/15-observability-evals`

## Goal
When this is done, we can see what the product and the models are doing and we cannot ship a regression in parsing, import, matching, or agent behavior without CI telling us. Sentry catches errors in the app and the worker, PostHog records the core loop and holds feature flags, `ai_runs` becomes a cost dashboard with an enforced per-household cap, and `pnpm eval` runs every golden set with thresholds that gate merges. Stalled runs page us instead of silently rotting in the queue.

## Depends on
- WS09 (Shopping agent + worker): `shopping_runs`, the pgmq `shopping_run` queue, the worker loop, recorded run fixtures, and `MockRetailer`.
- WS02 (Recipe domain & import): the 50-URL golden set and the import pipeline entry point.
- WS03 (Ingredient ontology & parser): the 500-line golden set and the parser entry point.
- WS07 (Retailer framework + Kroger): `MockRetailer` fixtures and the line-item matcher entry point.
- WS00 (Scaffold): `packages/llm` with the Anthropic wrapper, CI skeleton, `ai_runs` table from the initial migration.

## Read first
1. `docs/03-ai-design.md` §4.1 (model tiers, `ai_runs`, cost cap) and §4.10 (evaluation harness)
2. `docs/01-architecture.md` (Tooling: Sentry, PostHog, flags; worker and queue)
3. `docs/02-data-model.md` (Ops tables: `ai_runs`, `import_jobs`; Retail: `shopping_runs`)
4. `docs/06-risks.md` (R3 LLM cost creep, R10 background jobs stall, R1 wrong product, R13 hallucinated SKUs)
5. `docs/05-security-privacy.md` (what may be logged; no secrets or tokens in events)
6. The Interfaces sections of `WS02`, `WS03`, `WS07`, `WS09` briefs for the exact function names the evals call

## In scope
- **Sentry** in `apps/mobile` (`@sentry/react-native` with Expo plugin, source maps via EAS) and in `services/shopper-worker` (`@sentry/node`), with release tagging from the git SHA and a `household_id` tag (no emails, no tokens). Edge Functions report via the Sentry Deno SDK or a fetch to the ingest endpoint; pick one and document it.
- **PostHog** in `apps/mobile` and the worker: exactly these events for the core loop, with the listed properties and no PII:
  - `onboarding_completed` {steps_completed, store_connected}
  - `plan_created` {entries, source: ai|manual}
  - `list_built` {items, pantry_excluded}
  - `run_started` {retailer, trigger: manual|scheduled}
  - `cart_ready` {retailer, items, subtotal_bucket}
  - `run_approved` {retailer, review_edits}
  - `checkout_completed` {retailer, tier: 1|2|3}
  - Feature flags: `tier3_browser_checkout` (default off), `ai_suggestions_v2` (default off), read through one `useFlag(name)` hook in `apps/mobile` and `getFlag(name, householdId)` in the worker.
- **Cost dashboard and cap:** SQL views `v_ai_cost_daily(household_id, day, kind, model, cost_usd, calls)` and `v_ai_cost_by_prompt(prompt_version, calls, avg_latency_ms, error_rate)`; a `households.ai_daily_cap_usd` column (default 2.00); enforcement in `packages/llm` so a call that would exceed the cap throws `AiBudgetExceeded` before hitting the API; an admin-only screen in `apps/mobile` (behind a dev flag) that renders the views as tables.
- **Eval harness** `pnpm eval` (root script running `packages/evals`):
  - Import: 50 golden URLs from WS02 fixtures (recorded HTML, no live fetch in CI) → normalized recipes; pass if ≥45 match the expected normalized output on title, servings, ingredient count, and instruction count.
  - Parser: 500 golden lines from WS03 → ≥95% exact on quantity and unit, ≥90% on canonical ingredient id. Haiku calls are replayed from a recorded cache in CI; a `--live` flag re-records.
  - Line items: 100 cases per retailer (`kroger`, `safeway`) against `MockRetailer` fixtures → ≥90% choose the expected product or an accepted alternative.
  - Agent replays: every recorded run under `packages/agent/fixtures/runs/*.json` replays against `MockRetailer` and must reach the same terminal status with the same ledger deltas; model calls are replayed from the recording.
  - Output: a JSON report at `packages/evals/report.json` and a Markdown summary printed to the console; CI uploads the report as an artifact and posts the summary as a PR comment.
- **Thresholds gate merges:** `eval.yml` workflow runs `pnpm eval` on every PR touching `packages/{recipe-import,ingredient-parser,retailers,agent,llm}` or `supabase/seed`, and fails if any suite is below threshold or any suite regresses by more than 2 points versus the `main` baseline stored in `packages/evals/baseline.json`.
- **Run health:** worker heartbeat writes `shopping_runs.heartbeat_at` every 30 seconds while running; a pg_cron job every 5 minutes marks runs with `status = 'running'` and `heartbeat_at` older than 10 minutes as `failed` with `error = 'stalled'`, moves the pgmq message to a `shopping_run_dlq` queue, and inserts a `notification_outbox` row (WS11) so the household is told; the worker reports a Sentry event `run_stalled` with the run id.
- **Dead-letter handling:** `shopping_run_dlq` queue, an admin command `pnpm --filter shopper-worker dlq:list|dlq:retry <msg_id>`.
- Alerting: Sentry alert rule for `run_stalled` and for worker error rate >5% over 10 minutes; documented in `services/shopper-worker/README.md` (alert rules are configured in the Sentry UI by the human; this WS writes the exact settings).

## Out of scope
- Product analytics design beyond the seven events (future WSs add events to their own features using the same helper).
- LLM observability vendors (Langfuse, Braintrust). `ai_runs` plus views is the v1 answer.
- Evaluating recommendation quality (WS06). No golden set exists for taste; add a placeholder suite that is skipped.
- Mobile performance monitoring, session replay, or crash-free-rate dashboards.
- Building the golden sets themselves. WS02, WS03, WS07, and WS09 own their fixtures; this WS consumes them and fails loudly if they are missing.
- Any change to prompts or agent policy to make evals pass. Report regressions; do not tune.

## Deliverables
- `apps/mobile/src/observability/sentry.ts`, `posthog.ts`, `useFlag.ts`, `track.ts` (typed event helper, one function per event).
- `services/shopper-worker/src/observability/{sentry,posthog,flags,heartbeat}.ts`.
- `packages/llm/src/budget.ts`: `assertBudget(householdId, estimatedCostUsd)` and `AiBudgetExceeded`; wired into the single call path in `packages/llm/src/client.ts`.
- `supabase/migrations/<timestamp>_observability.sql`: `households.ai_daily_cap_usd`, `shopping_runs.heartbeat_at`, views `v_ai_cost_daily` and `v_ai_cost_by_prompt`, pgmq queue `shopping_run_dlq`, cron job `mark_stalled_runs`.
- `supabase/tests/mark_stalled_runs.sql` (pgTAP).
- `packages/evals/`: `package.json`, `src/run.ts`, `src/suites/{import,parser,lineItems,agentReplay}.ts`, `src/report.ts`, `baseline.json`, `README.md`.
- Root `package.json` script `"eval": "pnpm --filter evals run eval"`.
- `.github/workflows/eval.yml` with path filters, baseline comparison, artifact upload, PR comment.
- `apps/mobile/app/(dev)/ai-costs.tsx` behind the `__DEV__` or a dev flag.
- `services/shopper-worker/README.md`: alert rules, DLQ commands, heartbeat semantics.
- `docs/03-ai-design.md` §4.10: update with the final thresholds and how to re-record caches.

## Interfaces
**Implements**
- `track.<event>(props)` typed helpers in `apps/mobile/src/observability/track.ts` and `services/shopper-worker/src/observability/posthog.ts`; event names and property keys exactly as listed above.
- `useFlag(name: 'tier3_browser_checkout' | 'ai_suggestions_v2'): boolean` and worker `getFlag(name, householdId): Promise<boolean>`.
- `assertBudget(householdId: string, estimatedCostUsd: number): Promise<void>` throwing `AiBudgetExceeded`.
- Column `shopping_runs.heartbeat_at timestamptz`; column `households.ai_daily_cap_usd numeric default 2.00`.
- Queue `shopping_run_dlq`.
- CLI: `pnpm eval [--suite import|parser|lineItems|agentReplay] [--live]`.

**Consumes**
- `ai_runs` writes already performed by `packages/llm` (WS00/WS02/WS03): `cost_usd`, `model`, `kind`, `prompt_version`, `latency_ms`, `ok`.
- `importFromHtml(html, url)` from `packages/recipe-import` (WS02), `parseLine(rawText)` from `packages/ingredient-parser` (WS03), `matchLineItems(items, adapter, store)` and `replayRun(fixture, adapter)` from `packages/agent` (WS09). If any name differs, use the real one and note it; do not change their signatures.
- `notification_outbox` from WS11 for stalled-run notices.
- Shared contracts in `packages/core` are owned by the orchestrator. Adding `heartbeat_at` to the `ShoppingRun` zod schema requires a contract change request.

## Acceptance criteria
1. Throwing an error in a dev build of `apps/mobile` and in the worker produces Sentry events tagged with the release SHA and `household_id`, and containing no email, token, or cookie values (verified by inspecting two events).
2. Walking the core loop in the Simulator against local Supabase emits the seven PostHog events in order with the listed properties and no PII (verified in PostHog live events or the local capture log).
3. `useFlag('tier3_browser_checkout')` returns false by default and flips within one app foreground when the flag is enabled in PostHog; the worker's `getFlag` agrees.
4. With `ai_daily_cap_usd = 0.01` on a test household, the next `packages/llm` call throws `AiBudgetExceeded` before any network request (verified with a mocked transport in a unit test) and writes an `ai_runs` row with `ok = false` and `error = 'budget_exceeded'`.
5. `v_ai_cost_daily` totals equal the sum of `ai_runs.cost_usd` for seeded rows per day and household (SQL test).
6. `pnpm eval` runs all four suites offline (no network) in under 10 minutes on CI and writes `packages/evals/report.json` with per-suite scores and pass/fail.
7. Lowering a threshold fixture (for example, corrupting one expected parse) makes `pnpm eval --suite parser` report a score drop and exit non-zero when below threshold or regressed >2 points versus `baseline.json`.
8. The `eval.yml` workflow is skipped on a PR that only touches `docs/`, runs on a PR touching `packages/ingredient-parser`, and posts a summary comment.
9. Inserting a `shopping_runs` row with `status = 'running'` and `heartbeat_at = now() - interval '11 minutes'` then calling `mark_stalled_runs()` sets `status = 'failed'`, `error = 'stalled'`, moves the queue message to `shopping_run_dlq`, and inserts one `notification_outbox` row (pgTAP).
10. `pnpm --filter shopper-worker dlq:list` shows the message and `dlq:retry <id>` re-enqueues it on `shopping_run`.
11. The worker writes `heartbeat_at` at least every 30 seconds during a mocked 2-minute run (observed via `select heartbeat_at from shopping_runs where id = ...` sampled every 10 seconds).
12. `pnpm typecheck && pnpm lint && pnpm test` pass at the repo root.

## Verification commands
```bash
pnpm eval                                       # expected: four suites run offline, report.json written, exit 0
pnpm eval --suite parser                        # expected: parser score printed, >=95/90
pnpm test --filter llm                          # expected: budget tests pass
supabase start && supabase db reset && supabase test db   # expected: mark_stalled_runs.sql and cost view tests pass
pnpm --filter shopper-worker dev                # then simulate a run; expected: heartbeat_at updates
pnpm --filter shopper-worker dlq:list           # expected: lists DLQ messages
pnpm typecheck && pnpm lint && pnpm test        # expected: clean
gh run list --workflow eval.yml --limit 1       # expected: success on a PR touching packages/ingredient-parser
```

## Risks and notes
- From the WS03 review (2026-10-30): `parse-ingredients` `lines` mode has no household context, so `ai_runs.household_id` is null and the per-household daily cap cannot apply; any signed-in user can send 200 lines per call repeatedly. Design the cap so it covers user-scoped calls too (cap by `auth.uid()` when `household_id` is null) and coordinate the function change with the orchestrator; the function is WS03's code.
- From the WS01 review (2026-10-30): `households` has column-level UPDATE grants for `authenticated` (`name`, `zip` only). A column you add is not client-editable unless your migration grants `update (<column>)` on it explicitly; otherwise write it through a security-definer function. Add a pgTAP assertion either way. Applies to `ai_daily_cap_usd`.
- R3: the cap is enforced in code before the API call. Estimate cost from input token count and model price (Haiku 5.5 $0.10/$0.50, Sonnet 5.5 $2/$10, Opus 5.5 $4/$20 per MTok, Oct 2026); reconcile with actual usage after the call.
- R10: heartbeats and the stalled-run cron are the only defense against a worker that dies mid-run. Keep the threshold at 10 minutes; Tier 3 Mode A runs waiting on a human are `needs_review`, not `running`, so they are not marked stalled.
- R1 and R13: the line-item suite is where wrong-product regressions show up. Keep the accepted-alternatives list in fixtures small and explicit.
- Evals must be offline in CI. Record model responses keyed by a hash of (model, prompt_version, input) under `packages/evals/cache/`; `--live` re-records and should be run locally before changing a prompt.
- PostHog and Sentry keys are public-ish (client) and secret (worker) respectively; the worker's Sentry DSN and PostHog project API key live in env, never in the repo.
- Do not log prompts or model outputs to Sentry or PostHog; `ai_runs` stores only metrics. Recipe text and shopping lists are household data.
- If WS09 did not ship recorded run fixtures, the agent replay suite must fail with a clear "no fixtures" message, not pass vacuously.

## Completion report
End with the completion report format from `docs/implementation-guide.md` §6.2 (Message templates). Nothing else is read by the orchestrator.

## Orchestrator corrections (2026-10-31, before dispatch)

These override the sections above where they differ.

Shared facts for every wave 6 brief (the as-built repo, 2026-10-31):
- Packages are `@mp/core`, `@mp/db`, `@mp/llm`, `@mp/retailers`, `@mp/agent`, `@mp/ui`, `@mp/mobile`, `@mp/shopper-worker`; use those names in `--filter`. Root `pnpm test` is the Vitest `unit` project (`*.test.ts(x)`), root `pnpm eval` is the `evals` project (`**/evals/**/*.eval.ts`); there is no turbo `eval` task and no `packages/evals`.
- App code lives under `apps/mobile/src/features/<name>/` and routes under `apps/mobile/app/(app)/...`; the repo's platform split is `X.native.tsx` plus an unsuffixed default for web (never `*.web.*`). Screen tests render through the stand-in in `apps/mobile/src/testing/` (render once, no effects; see `pickScreen.test.tsx`).
- `@mp/llm` exports `createAnthropicClient` (not `createClient`), `callWithTools`, `logAiRun`, `toAiRunRow`, `estimateCostUsd`, `createDailyCapGuard` (throws `LlmError("cost_cap")`), `MODELS` and the prompt registry. `@mp/db` exports `createClient` (the supabase wrapper). `@mp/agent` exports `matchLineItems`, `replayRun`, `canAutoCheckout`, the run steps and the types (`TranscriptEntry` is `{ts, tool, by, input, output_summary, ok, screenshot_path?}`). `RunPolicy` keys are snake_case (`budget_cap_usd`, `per_item_ceiling_usd`, `substitution`, `auto_checkout`, `auto_checkout_cap_usd`, `max_tool_calls`, `max_wall_clock_seconds`).
- docs/03 sections are §1 model tiers, §2 onboarding, §3 suggest, §4 import, §5 parsing, §6 list aggregation, §7 line-item conversion, §8 shopping agent, §9 assistant, §10 evaluation harness, §11 safety; docs/04 has no numbers (headings: Feasibility matrix, Adapter contract, Per-retailer adapter plan, Kroger, Costco, Safeway Albertsons Haggen, Tier 3 with "Mode A host as built (WS08)" and "Mode B").
- Tables that exist: everything in docs/02 through `push_tokens`, `shopping_runs` (with `heartbeat_at`, `subtotal_usd`, `store_name`, `error`), `shopping_run_items` (`unit_price_usd`, `line_total_usd`, `cart_qty`, `user_decision`), `households.tier3_consent`, `households.plan_mode`, `ai_runs.run_id`, `recipes.source_url_normalized`. Not yet: `scheduled_runs`, `notification_preferences`, `notification_outbox`, `households.quiet_hours`, `households.ai_daily_cap_usd`, `orders`, any cost view, `shopping_run_dlq` (the dead letter is pgmq's archive `a_shopping_run`). Extensions: pgmq, pg_cron, vector, pg_trgm, pgtap; not pg_net, so SQL cannot call an Edge Function.
- Every migration that touches a table or function must come with `packages/db/src/types.generated.ts` regenerated from the CI artifact ("Check committed types are current" fails otherwise), a `config.toml` section for any new function, a `deno.json` import map, and fixture-scoped pgTAP named `wsNN_<area>.sql`. Parallel builders all touch the generated types and the lockfile: before your report, `git fetch origin && git merge origin/main`, regenerate both rather than hand-merging, and keep both sides.
- CI: job `checks` (typecheck, lint, unit tests, evals with `EVAL_REQUIRE_RECORDINGS=1`, `deno check`) and job `supabase` (stack, migrations, seeds, extension check, schema lint, pgTAP, magic link, health, queue exists, worker poll, worker mock run, list-build on real Postgres, generated types). Extend those jobs; add no new workflow unless the brief says so.
- `instacart` is retired (CCR9, PR #26): never reference it. Checkpoint facts: no container runtime on the dev Mac, CI is the authority; the hosted project is Miguel's live test bed, write nothing there.

WS15-specific:
1. **Versions and paths.** Migration `20261031190000_ws15_observability.sql`, pgTAP `ws15_observability.sql`. There is no `packages/evals`: evals are `*.eval.ts` under each package's `evals/` (`recipe-import/evals/import.eval.ts` with 50 URLs and recordings, `ingredient-parser/evals/parse.eval.ts` with 500 lines, `agent/evals/agent.eval.ts` with `runs/*.json`, `llm/evals/suggest/suggest.eval.ts`). Keep that layout; the harness work is a root `eval.yml` workflow plus a small `packages/evals-report` (or a script under `scripts/`) that runs `pnpm eval` with JSON reporters, compares against `baseline.json` and posts the PR comment. Live mode is `EVAL_LIVE=1`; recordings are required in CI by `EVAL_REQUIRE_RECORDINGS=1`.
2. **Line-item suite.** It does not exist. Build it under `packages/agent/evals/line-items/` with `matchLineItems(items, adapter, store, options?)` and `MockRetailer({id, seed})` (224 fixture products across kroger, safeway, costco); 100 cases per retailer as the brief says.
3. **Cost cap (decided).** No `budget.ts`: extend the existing `CostGuard` and `createDailyCapGuard` in `packages/llm/src/log.ts` so a refusal writes an `ai_runs` row with `ok = false` and `error = 'cost_cap'` before throwing `LlmError("cost_cap")` (the callers in `suggest`, `recipe-import`, `llm-proxy` and the worker already pass a guard; `parse-ingredients` has none, add one). Add `households.ai_daily_cap_usd numeric default 2.00` and make the guards read it through `household_ai_spend_since` and the household row, falling back to `AI_DAILY_CAP_USD`. Views `v_ai_cost_daily` and `v_ai_cost_by_prompt` as `security_invoker` views; every `ai_runs` column they need exists, including `run_id`.
4. **Runs (decided).** `shopping_runs.heartbeat_at` exists and the worker's sweeper (90 seconds, requeue approved pushes up to twice, fail the rest) stands; do not add a second sweeper or a column. WS15 adds alerting: a Sentry event when a `running` or `checking_out` run has no heartbeat for 10 minutes (no worker alive), and a dashboard query. The dead letter is pgmq's archive `a_shopping_run` after 3 attempts; add `dlq:list` and `dlq:retry` scripts to `@mp/shopper-worker` against that archive instead of a new queue.
5. **Flags (decided).** `tier3_browser_checkout` is on by default and is a kill switch (off only on an explicit `false` or a per-retailer `{off: [...]}` payload), as WS08 built in `features/tier3/flags.ts`. Build `useFlag` and `getFlag` on that client with that default; `ai_suggestions_v2` has no code and `shopping_agent_enabled` is named only in docs/05, so define both with on-by-default semantics and wire `shopping_agent_enabled` around "Shop this list".
6. **Sentry and PostHog.** Nothing from `@sentry/*` is installed; `SENTRY_DSN` is read by the worker only and `.env.example` has no app DSN: add `EXPO_PUBLIC_SENTRY_DSN` for the app and keep `SENTRY_DSN` for the worker and functions. `posthog-react-native` 4.85.1 is installed; the worker has no PostHog key variable, add one if it reports events.
7. **CI.** `pnpm eval` already runs on every push and PR in the `checks` job; `eval.yml` adds the baseline compare and the PR comment, with `ANTHROPIC_API_KEY` as a repository secret for the live job (Miguel sets it).
8. **Docs.** docs/03 §1 and §10 (not §4.1 and §4.10); docs/05 has no "what may be logged" heading: add the logging rules under Privacy and Audit; docs/01 Tooling's Sentry and PostHog rows.


## Follow-ups recorded after review (2026-11-01, merged 403dd29)

Non-blocking items from the two review rounds, for a later round or for the workstreams named:
1. `dlq:retry --new-run` checks only the archived run's own status. A later run on the same list that reached `cart_ready` or `checked_out` does not block a replacement (the replacement is hands-off, so a person still approves it). Refuse when any run on the list is `cart_ready` or `checked_out`.
2. The spend guard reads `null` and `""` as 0 (`Number(null)`), and the recipe-import, parse-ingredients and llm-proxy stores coerce a bad RPC answer to 0 before the guard sees it. `coalesce(sum(), 0)` cannot return null today. Accept only a number or a non-empty numeric string in the guard and pass raw values through from the stores.
3. Unpinned behaviours: dropping the `report` hook in suggest or llm-proxy stays green; suggest's fallback to ranking on `cost_unknown` holds (verified by probe: 200, `composedBy: fallback`, zero model calls) but has no test; the advisory lock's concurrency behaviour is pinned only by statement order (PGlite has one connection).
4. Refused runs (`agent_disabled`) count toward the 20-runs-a-day `enqueue_shopping_run` limit; the kill switch also fails an approved cart mid-run.
5. `swept_requeued` (self-healed) shares the `run_stalled` tag and fingerprint with `no_worker`, so README alert rule 1 pages for both.
6. `ARG GIT_SHA=unknown` in the worker Dockerfile makes the release the string "unknown" instead of unset.
7. The cap day is UTC midnight; switch to `households.timezone` (on main since WS11). Parse-ingredients records spend only in `finish()`, so parallel batches all see the same spend (the cap is advisory under concurrency).
8. The CI dead-letter step exercises only `--force` on a missing run.
9. `list-build`, `run-approve`, `retailer-oauth` and `export-data` do not report to Sentry; no web or desktop Sentry (WS13 seam `sentry.ts`); no Expo Router ErrorBoundary; the worker's `run_id` is not written onto `ai_runs` rows; `checkout_completed` has helpers only (WS10 emits it).
10. WS08's `tier3/__tests__/bridge.test.ts` captcha case has 200 ms of headroom (200 ms debounce against a 400 ms sleep) and flaked once on a loaded runner.
11. Miguel: Sentry projects and DSNs (`SENTRY_DSN` as a function secret and in `.env.local`), EAS secrets and the source map token; the GitHub secret `ANTHROPIC_API_KEY` for the manual live eval job; a PostHog project key and the flags `tier3_browser_checkout`, `ai_suggestions_v2`, `shopping_agent_enabled`; the four Sentry alert rules written in the worker README.
12. `eval.yml` is not a required check by decision: a path-filtered workflow that is skipped stays pending and would block merges. `baseline.json` on main already equals the current scores; refresh it with `pnpm eval --update-baseline` only when a score is meant to move.
