# Status ledger

The orchestrator updates this file after every dispatch, report, review, merge, or block. It is the resume point for a fresh session: read it before anything else except the implementation guide.

**Current wave:** 0 (in progress)
**Last updated:** 2026-10-30 by the orchestrator (WS00 fix landed, re-review running)

## Workstreams

| WS | Name | Wave | State | Branch | Model | Started | Merged | Notes |
|---|---|---|---|---|---|---|---|---|
| 00 | Repo & infra scaffold | 0 | in review | ws/00-scaffold | opus | 2026-10-29 | | Fix commit 73db72f landed; CI green: https://github.com/miguelsolorio/souvie/actions/runs/41010562175. Re-review by the same reviewer running. Hosted halves of 9-11 need `SUPABASE_ACCESS_TOKEN`; criterion 7 needs the Xcode license. Checkpoint 1 after merge |
| 01 | Auth & households | 1 | not started | | | | | Human checkpoint 2 before merge (migration + RLS) |
| 02 | Recipe domain & import | 2 | not started | | | | | |
| 03 | Ingredient ontology & parser | 1 | not started | | | | | |
| 04 | Planner UI | 3 | not started | | | | | |
| 05 | Grocery list & in-store mode | 4 | not started | | | | | |
| 06 | Onboarding & suggestions | 3 | not started | | | | | |
| 07 | Retailer framework + Kroger | 2 | not started | | | | | Human checkpoint 3 before start (Kroger app registered) |
| 08 | Instacart adapter | 3 | not started | | | | | Human checkpoint 4 before start (IDP application status) |
| 09 | Shopping agent + worker + review UI | 5 | not started | | | | | |
| 10 | Browser adapters | 6 | not started | | | | | Human checkpoint 5 before start (Tier 3 consent copy) |
| 11 | Scheduling & notifications | 6 | not started | | | | | |
| 12 | History & spend | 6 | not started | | | | | |
| 13 | Web & desktop packaging | 6 | not started | | | | | |
| 14 | Brand & marketing site | 1 | not started | | | | | Human checkpoint 6 before finish (name) |
| 15 | Observability & AI evals | 6 | not started | | | | | |

States: `not started` · `in progress` · `in review` · `fix round` · `merged` · `blocked`

## External tasks (human)

| Task | Owner | Status | Notes |
|---|---|---|---|
| Register Kroger developer app at developer.kroger.com | Miguel | done 2026-10-29 | Credentials in `.env.local`, never the repo. Checkpoint 3 prerequisite met |
| Submit Instacart Developer Platform application | Miguel | open | Needed before WS08 production; dev key works without approval. Marketing page said "not accepting" on 2026-10-29; docs still say apply |
| Trademark, domain, and App Store name checks for the shortlist | Miguel | partly done | Sous and Larder checked per docs/08-brand.md §1.3. Souvie, the working name, still needs the checks before checkpoint 6 |
| Create the Supabase project | Miguel | done 2026-10-29 | Credentials in `.env.local` at the primary checkout root. WS00 verifies against local Supabase only |
| Create the GitHub repository for `main` | Miguel | done 2026-10-29 | https://github.com/miguelsolorio/souvie (public). Miguel added `origin` and pushed `main` from the primary checkout |
| Create accounts: Expo/EAS, Fly.io or Railway, Cloudflare Pages, Sentry, PostHog | Miguel | open | `ANTHROPIC_API_KEY` needed before WS02; the rest before WS13, WS14, WS15 |
| Install Xcode and accept its license | Miguel | partly done | Xcode 27.2 installed, iOS runtime present. License not accepted: run `sudo xcodebuild -license accept` or open Xcode once. Blocks WS00 criterion 7 |
| Docker | Miguel | not allowed | Security policy on this Mac. Replaced by hosted project plus CI (decisions log). Podman 5.5 is installed but unused |
| Add `SUPABASE_ACCESS_TOKEN` to `.env.local` | Miguel | open | Personal access token from the Supabase dashboard. Needed for `supabase link`, `db push`, `functions deploy` on the dev machine |

## Wave summaries

_None yet._

## Decisions log

- 2026-10-29: Stack: Expo + React Native (TypeScript), Supabase, separate Node worker. Audience v1: household first. Checkout tiers 1, 2, and 3 all allowed; Tier 3 is on-device assisted mode first. (Planning session.)
- 2026-10-29: `main` lives on GitHub in a repository Miguel creates. Merges go through PRs and GitHub Actions. The orchestrator session runs in an app-made worktree on branch `claude/repo-orchestration-setup-4365a5`, which mirrors `origin/main`. Ledger and contract commits are made there and pushed with `git push origin HEAD:main`. The primary checkout's local `main` is refreshed by Miguel with `git pull`. (Orchestrator, confirmed with Miguel.)
- 2026-10-29: `main` is at https://github.com/miguelsolorio/souvie, default branch `main`, public. PRs from `ws/*` branches target it; GitHub Actions runs CI. (Miguel created and pushed; orchestrator recorded.)
- 2026-10-29: Wave 0 gate met. The Supabase project exists and its credentials are in `.env.local` at the primary checkout root. WS00 verifies against local Supabase and never needs the hosted project. (Orchestrator.)
- 2026-10-29: WS00 dispatched before Docker and Xcode were installed. The builder self-installs pnpm, the Supabase CLI, and Node 22. Criteria 7, 9, 10, 11 are verified once Docker and Xcode exist, with one evidence round to the same builder if the report lands first. (Orchestrator, confirmed with Miguel.)
- 2026-10-29: Docker cannot be installed on the development Mac (security policy). Container-only Supabase commands (`start`, `db reset`, `functions serve`, `db lint --local`, `test db`) run in GitHub Actions. Local development uses the hosted project through `supabase link`, `db push`, and `functions deploy --use-api`. WS00 criteria 9 to 12 amended in the brief; docs/01 Environments updated. `.env.example` gains `SUPABASE_ACCESS_TOKEN` as a developer-tool variable, thirteen in total. Podman 5.5 is present but unused pending policy. (Orchestrator, confirmed with Miguel.)
- 2026-10-30: WS00 review (Sonnet, detached worktree) returned merge with no blockers and no false claims in the builder's report. Criteria 1 to 6, 8, 12, 13 and the CI halves of 9 to 11 pass; 7 and the hosted halves wait on Miguel. Fix round sent to the same builder for: CI creating `shopping_run` so the real `pgmq.read` path runs; Vitest excluding `**/.claude/**` and `.gitignore` adding `.claude/worktrees/`; Metro copying only `EXPO_PUBLIC_*` from `.env.local`; a root `.node-version`; pooler-mode notes for `WORKER_DATABASE_URL`. Carried into briefs: WS01 (CI services to re-enable, `db lint` schema list), WS05 and WS07 (retailer data never sets `meta.persist`). Noted for checkpoint 1: `pnpm typecheck` does not cover `supabase/functions`, CI actions pinned to major tags, PRs run CI twice. (Orchestrator.)
- 2026-10-30: WS00 second report received. CI run 41008341567 is green with two jobs: checks (install, typecheck, lint, test, eval) and a Supabase stack job (start, db reset, extension check, db lint on the public schema, health curl, 15-second worker run). CI starts the stack with auth, realtime, storage, postgrest, studio and supavisor excluded; WS01 adds back what its tests need. `db lint` is scoped to `--schema public` because plpgsql_check flags pgTAP's own functions; later migrations add their schemas to that flag. Hosted halves of 9 to 11 and criterion 7 wait on Miguel. Reviewer dispatched. (Orchestrator.)
- 2026-10-29: WS00 completion report received. Criteria 1 to 6, 8, and 13 pass with pasted output. The branch was pushed by the orchestrator for CI. Disclosed deviations accepted for review: root `.npmrc` pinning the public npm registry (the machine's global npmrc points at a corporate registry; checkpoint 1 item), extra config files the deliverables imply, `pgcrypto` in the extensions migration per docs/02, `shopping_run` queue creation left to WS09 per docs/02, Tailwind `darkMode: "class"`, opt-in query persistence via `meta.persist`. No contract change requests. (Orchestrator.)
- 2026-10-29: Kroger developer app registered and name checks for Sous and Larder done. Instacart application and the hosting and analytics accounts remain open. (Miguel.)
- 2026-10-29: Reconciliation after brief drafting. Package scope `@mp/*`; Node 22 and pnpm 9; migrations use Supabase timestamp names in the logical order in docs/02; RLS helper is `current_household_ids()`; pgmq queue `shopping_run` with message `{ run_id }`; ledger columns `delta_sent`, `delta_result`, `sent_at`; `scheduled_runs.last_enqueued_for`; Kroger redirect `mealplanner://oauth/kroger`; app web export and marketing site on Cloudflare Pages; `orders` owned by WS12; `llm-proxy` owned by WS10; `export-data` created by WS01 and extended by WS12; 16 store sections per WS03. (Planning session.)
- 2026-10-29: Working name is Souvie (Sous plus vie, said "SOO-vee"). Sous is the fallback, then Larder. The §1.3 checks in docs/08-brand.md have not been run; [Name] placeholders stay until they pass. (Brand naming session.)
