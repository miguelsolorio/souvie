# Status ledger

The orchestrator updates this file after every dispatch, report, review, merge, or block. It is the resume point for a fresh session: read it before anything else except the implementation guide.

**Current wave:** 0 (not started)
**Last updated:** 2026-10-29 by the planning session

## Workstreams

| WS | Name | Wave | State | Branch | Model | Started | Merged | Notes |
|---|---|---|---|---|---|---|---|---|
| 00 | Repo & infra scaffold | 0 | not started | | | | | Human checkpoint 1 after merge |
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
| Register Kroger developer app at developer.kroger.com | Miguel | open | Needed before WS07. Credentials go in `.env.local`, never the repo |
| Submit Instacart Developer Platform application | Miguel | open | Needed before WS08 production; dev key works without approval. Marketing page said "not accepting" on 2026-10-29; docs still say apply |
| Trademark, domain, and App Store name checks for the shortlist | Miguel | open | Needed before WS14 finishes |

## Wave summaries

_None yet._

## Decisions log

- 2026-10-29: Stack: Expo + React Native (TypeScript), Supabase, separate Node worker. Audience v1: household first. Checkout tiers 1, 2, and 3 all allowed; Tier 3 is on-device assisted mode first. (Planning session.)
- 2026-10-29: Reconciliation after brief drafting. Package scope `@mp/*`; Node 22 and pnpm 9; migrations use Supabase timestamp names in the logical order in docs/02; RLS helper is `current_household_ids()`; pgmq queue `shopping_run` with message `{ run_id }`; ledger columns `delta_sent`, `delta_result`, `sent_at`; `scheduled_runs.last_enqueued_for`; Kroger redirect `mealplanner://oauth/kroger`; app web export and marketing site on Cloudflare Pages; `orders` owned by WS12; `llm-proxy` owned by WS10; `export-data` created by WS01 and extended by WS12; 16 store sections per WS03. (Planning session.)
