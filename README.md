# Souvie

A cross-platform meal-planning app that does the shopping. It suggests and imports recipes, turns a week's plan into one grocery list, converts that list into real products at your store, and has an agent fill the cart at QFC or Fred Meyer (Kroger API) or drive the Safeway or Costco site inside the app to the pay button.

Mobile first (Expo, iOS and Android), then web (Expo Router static export), then desktop (Tauri). Backend on Supabase with a small Node worker for long agent runs.

## Where things stand

Wave 0 is merged: the monorepo scaffold exists and CI is green (see Getting started). Product features start in wave 1. The documents in `docs/` remain the source of truth for the design, and `docs/implementation-guide.md` tells a Claude Fable session how to run the build as the orchestrator of builder and reviewer agents.

See `docs/status.md` for the live ledger.

## Start the implementation

1. Work through section 0 of `TODO.md` (Supabase project, Kroger developer app, accounts, name checks).
2. Open a Claude Code session in this folder with Fable as the model and paste the kickoff prompt from the bottom of `TODO.md`.

3. The orchestrator dispatches one wave at a time, reviews each workstream, merges, and updates `docs/status.md`. It stops at the seven human checkpoints listed in the guide.

## Getting started

You need Node 22 (22.23 or later, which Astro 7 requires; `.node-version` pins 22.23.4, because a bare major let CI runners pick a patch Astro rejects), pnpm 9 through corepack, and Xcode with an iOS Simulator for iOS. Node 25 and later no longer bundle corepack, so check `corepack --version` first; then run `corepack enable --install-directory <a directory on your PATH that you own> pnpm` once (on a Homebrew Mac, `/opt/homebrew/bin`), and `pnpm` resolves to the version pinned in `package.json`. Without that step the shell says `command not found: pnpm`. If `corepack` is missing, install pnpm under your Node with `npm install -g pnpm@9`. Development runs against the hosted Supabase project. The local Supabase stack (`supabase start`) needs a container runtime, so it runs only in CI.

```bash
scripts/setup-git-identity.sh       # once per clone
pnpm install
cp .env.example .env.local          # one env file for the whole repo; never commit it
set -a; . ./.env.local; set +a      # the Supabase CLI reads SUPABASE_ACCESS_TOKEN from the shell
pnpm supabase link --project-ref <ref>   # <ref> is the host part of EXPO_PUBLIC_SUPABASE_URL
pnpm supabase db push               # apply supabase/migrations to the hosted project
```

| Command | What it does |
|---|---|
| `pnpm dev` | Expo dev server (web at http://localhost:8081) and the worker together, through Turborepo. Expo's key shortcuts need the next command |
| `pnpm --filter @mp/mobile start` | Expo only. Press `w` for web at http://localhost:8081, `i` for the iOS Simulator |
| `pnpm --filter @mp/shopper-worker dev` | Worker only. Logs `connected`, then `idle` every 5 seconds |
| `pnpm supabase functions deploy <name> --use-api --project-ref <ref>` | Deploy an Edge Function to the hosted project without Docker. `--project-ref` (the host part of `EXPO_PUBLIC_SUPABASE_URL`) means no `supabase link` is needed, which matters when the access token lacks `projects_read` |
| `pnpm supabase db push` | Apply new migrations to the hosted project. If your access token cannot `link`, `pnpm supabase db push --db-url "$WORKER_DATABASE_URL"` pushes over the database connection instead (percent-encode the password); `--dry-run` first lists what would apply |
| `pnpm typecheck` | `tsc --noEmit` in every workspace |
| `pnpm lint` | Biome check of the whole repo. `pnpm format` applies fixes |
| `pnpm test` | Vitest `unit` project: every `*.test.ts` |
| `pnpm eval` | Vitest `evals` project: `**/evals/**/*.eval.ts`. Passes with none |
| `cd apps/mobile && npx expo export --platform web` | Static web build in `apps/mobile/dist` |

Notes:

- Metro (`apps/mobile/metro.config.js`) and the worker's dev script both read the root `.env.local`. Only `EXPO_PUBLIC_*` values reach the app bundle.
- `.npmrc` pins the public npm registry, so a user-level registry in `~/.npmrc` does not apply here.
- Expo Go runs the app, but the query cache persists to MMKV only in a development build. Expo Go keeps it in memory.
- The Supabase CLI is a dev dependency (`pnpm supabase ...`), so everyone and CI use the same version.
- CI (`.github/workflows/ci.yml`) runs `supabase start`, `db reset`, `db lint`, `functions serve`, and the worker against the local stack on every push to `main` and `ws/**`.

## Documents

| Doc | What it holds |
|---|---|
| [docs/00-overview.md](docs/00-overview.md) | Product definition, decisions, landscape |
| [docs/01-architecture.md](docs/01-architecture.md) | System shape, monorepo, tooling, environment variables |
| [docs/02-data-model.md](docs/02-data-model.md) | Tables, RLS, migration ownership |
| [docs/03-ai-design.md](docs/03-ai-design.md) | Onboarding, suggestions, import, parsing, aggregation, the shopping agent, evals |
| [docs/04-integrations.md](docs/04-integrations.md) | Kroger, Costco, Safeway research; feasibility matrix; adapter contract; Tier 3 |
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

## Name

Souvie, said "SOO-vee", chosen 2026-10-30. The availability checks and the open trademark note are in `docs/08-brand.md` §1. The deep-link scheme is `souvie://` and the bundle id is `com.miguelsolorio.souvie`.
