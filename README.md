# Meal planner

A cross-platform meal-planning app that does the shopping. It suggests and imports recipes, turns a week's plan into one grocery list, converts that list into real products at your store, and has an agent fill the cart at QFC or Fred Meyer (Kroger API), hand Safeway and Costco lists to Instacart, or, for households that opt in, drive the retailer site to the pay button.

Mobile first (Expo, iOS and Android), then web (Expo Router static export), then desktop (Tauri). Backend on Supabase with a small Node worker for long agent runs.

## Where things stand

Design and orchestration are complete. **No application code exists yet.** The documents in `docs/` are the source of truth, and `docs/implementation-guide.md` tells a Claude Fable session how to run the build as the orchestrator of builder and reviewer agents.

See `docs/status.md` for the live ledger.

## Start the implementation

1. Work through section 0 of `TODO.md` (Supabase project, Kroger developer app, Instacart application, accounts, name checks).
2. Open a Claude Code session in this folder with Fable as the model and paste the kickoff prompt from the bottom of `TODO.md`.

3. The orchestrator dispatches one wave at a time, reviews each workstream, merges, and updates `docs/status.md`. It stops at the seven human checkpoints listed in the guide.

## Documents

| Doc | What it holds |
|---|---|
| [docs/00-overview.md](docs/00-overview.md) | Product definition, decisions, landscape |
| [docs/01-architecture.md](docs/01-architecture.md) | System shape, monorepo, tooling, environment variables |
| [docs/02-data-model.md](docs/02-data-model.md) | Tables, RLS, migration ownership |
| [docs/03-ai-design.md](docs/03-ai-design.md) | Onboarding, suggestions, import, parsing, aggregation, the shopping agent, evals |
| [docs/04-integrations.md](docs/04-integrations.md) | Kroger, Instacart, Costco, Safeway research; feasibility matrix; adapter contract; Tier 3 |
| [docs/05-security-privacy.md](docs/05-security-privacy.md) | Controls for tokens, money, audit, allergens, user data |
| [docs/06-risks.md](docs/06-risks.md) | Risk register R1–R26 |
| [docs/07-roadmap.md](docs/07-roadmap.md) | Phases, waves, week-one tasks, definitions of done |
| [docs/08-brand.md](docs/08-brand.md) | Names, slogans, positioning, landing page, store listing, emails |
| [docs/09-open-questions.md](docs/09-open-questions.md) | What the research couldn't confirm |
| [TODO.md](TODO.md) | Ordered checklist of next steps, with the kickoff and resume prompts |
| [docs/implementation-guide.md](docs/implementation-guide.md) | The orchestrator playbook and templates |
| [docs/status.md](docs/status.md) | Ledger: wave, per-workstream state, decisions |
| [docs/workstreams/](docs/workstreams/) | Sixteen builder briefs and the template |

## Stack at a glance

Expo SDK 58 · React Native 0.88 · Expo Router · NativeWind · TanStack Query · Supabase (Postgres, RLS, Auth, Storage, Edge Functions, Realtime, pgvector, Vault, Cron, Queues) · Node worker on Fly.io or Railway · Anthropic Claude (Haiku 5.5, Sonnet 5.5, Opus 5.5) · Tauri 2 for desktop · pnpm + Turborepo · Biome · Vitest · pgTAP

## Git identity

This repo commits only as the personal Gmail account. After cloning, run `scripts/setup-git-identity.sh` once; it pins the local config and installs a pre-commit hook that rejects any other author or committer.

## Working name

"Meal planner" until the name is chosen (see `docs/08-brand.md`).
