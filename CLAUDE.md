# Meal Planner: conventions for Claude sessions

This repo is a cross-platform (Expo + Supabase) meal-planning and grocery-shopping app whose core loop is: onboard → AI-curated recipes → weekly plan → aggregated grocery list → retailer line items → agent fills the cart → user reviews and pays → pickup. Until code exists, **the documents in `docs/` are the source of truth.**

## Start here

0. Read `TODO.md`. It is the ordered checklist of what's next, with the kickoff and resume prompts.
1. Read `docs/implementation-guide.md`. It defines the orchestration model (a Fable session orchestrates builder and reviewer agents) and the exact templates to use.
2. Read `docs/status.md` to see the current wave and what is merged, in progress, or blocked.
3. Read only the docs the current wave needs. The doc map is below.

If you are a **builder agent**, you were given one brief in `docs/workstreams/`. Read it, then its "Read first" list, and nothing else unless the brief says so.

## Doc map

| Path | What it holds |
|---|---|
| `docs/00-overview.md` | Product definition, decisions, landscape and differentiation |
| `docs/01-architecture.md` | System diagram, monorepo layout, tooling, platform versions |
| `docs/02-data-model.md` | Every table, RLS pattern, data-retention constraints from retailer terms |
| `docs/03-ai-design.md` | Model tiers, onboarding, recommendations, import, parser, aggregation, shopping agent, evals |
| `docs/04-integrations.md` | Retailer and platform research with sources, feasibility matrix, adapter contract, Tier 3 design |
| `docs/05-security-privacy.md` | Controls, token handling, spending caps, audit, allergen safety, copyright posture |
| `docs/06-risks.md` | Risk register R1–R22 with mitigating workstreams |
| `docs/07-roadmap.md` | Phases and dependency waves |
| `docs/08-brand.md` | Names, slogans, positioning, marketing materials |
| `docs/09-open-questions.md` | Unconfirmed facts and who can resolve them |
| `TODO.md` | Ordered checklist of next steps; tick items as they complete |
| `docs/implementation-guide.md` | Orchestrator playbook and templates |
| `docs/status.md` | Live ledger: wave, per-WS state, decisions log |
| `docs/workstreams/` | Sixteen builder briefs; `README.md` there holds the brief template and index |

## Conventions (apply once code exists)

- TypeScript strict everywhere; pnpm workspaces + Turborepo; Biome for lint and format; Vitest for unit tests.
- Branches: `ws/NN-slug`, one per workstream. No direct commits to `main` except the orchestrator's contract changes and ledger updates.
- Shared contracts live in `packages/core` (zod schemas and types) and `packages/retailers` (`RetailerAdapter`). Only the orchestrator edits them.
- Secrets never enter the repo. `.env.example` lists every variable; `.env.local` is gitignored.
- Retailer data rules are product rules: display Kroger product data exactly as returned, never cache catalog data past its cache headers, never show prices from different retailers on one screen, never store search-derived data. See `docs/04-integrations.md` and `docs/02-data-model.md`.
- Allergies are enforced in SQL and deterministic code, never by a model alone.
- The app name must not contain "Kroger" or any retailer mark.
- Prose style for docs and copy: short sentences, no em dashes, no filler.
