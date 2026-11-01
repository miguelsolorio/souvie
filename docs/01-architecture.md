# 01 · Architecture

## System shape

```
┌──────────────────────────── Clients (apps/mobile, one Expo codebase) ────────────────────────────┐
│  iOS / Android (Expo)        Web (Expo Router static export, Cloudflare Pages)     Desktop (Tauri) │
│  Expo Router · NativeWind · TanStack Query (persisted) · supabase-js · Expo Push · Realtime        │
│  Assisted-checkout WebView (Tier 3 Mode A: the agent drives the retailer site on the user's device)│
└───────────────┬───────────────────────────────────────────────────────────────────────────────────┘
                │ HTTPS (supabase-js, RLS enforced)             ▲ Realtime (run progress, shared lists)
┌───────────────▼───────────────────────────────────────────────────────────────────────────────────┐
│ Supabase                                                                                          │
│  Auth (Apple / Google / magic link)   Postgres (+pgvector, RLS by household)   Storage (images)    │
│  Edge Functions (Deno, short tasks): recipe-import · parse-ingredients · suggest · list-build      │
│  Vault (retailer OAuth tokens, encrypted browser sessions)   Cron (schedules)   Queues (pgmq)      │
└───────────────┬───────────────────────────────────────────────────────────────────────────────────┘
                │ pgmq jobs: shopping_run · import_job · reindex
┌───────────────▼───────────────────────────────────────────────────────────────────────────────────┐
│ services/shopper-worker (Node, Fly.io or Railway, long-running)                                   │
│  Claude tool-use agent loop · Retailer adapters · Playwright (Tier 3 Mode B only) · run progress   │
└───────┬──────────────────┬──────────────────────┬─────────────────────────────────────────────────┘
        ▼                  ▼                      ▼
  Kroger Public API   Retailer websites (browser adapters, driven in the app's WebView)
  (QFC, Fred Meyer)   safeway.com · costco.com · kroger.com checkout
        ▲
   Anthropic API (Haiku / Sonnet / Opus) · USDA FoodData Central (nutrition, optional) · Open Food Facts (UPC facts)
```

### Why a separate worker

Edge Functions have wall-clock limits and cannot run Chromium. A shopping run takes minutes, needs retries, pauses for human review, and in Tier 3 Mode B needs a browser. The worker consumes a Postgres-backed queue (pgmq via Supabase Queues) so there is no extra queue vendor. It writes progress to `shopping_runs` and clients see it through Realtime.

### Why Expo web instead of a separate Next.js app

One UI codebase, one router, one design system. The marketing site is separate (`apps/marketing`, Astro) because it has different needs: SEO, static content, a waitlist form.

### Why the agent loop is host-agnostic

Tier 3 Mode A runs the agent against a WebView on the user's phone. Mode B runs it in a household-hosted worker. The same `packages/agent` code must run in both, so it has no Node-only dependencies and gets its tools injected by the host.

## Platform versions (verified October 2026)

- Expo SDK 58 on React Native 0.88. Three Expo releases per year.
- Expo Router web defaults to `web.output: "server"`. This project sets `"static"` so the export is plain files that Cloudflare Pages hosts and Tauri 2 wraps.
- Expo has no official desktop target. `react-native-macos` lags React Native by several versions and is unsupported by SDK 58. Desktop is Tauri wrapping the web build, not React Native macOS.
- Supabase: Free tier pauses projects after seven idle days, so the household project runs on Pro ($25/month) once it is in daily use. pgvector is the `vector` extension with HNSW indexes.
- Anthropic: `claude-haiku-5-5` $0.10/$0.50 per MTok in/out, `claude-sonnet-5-5` $2/$10, `claude-opus-5-5` $4/$20. Structured outputs via `output_config` JSON schema and `messages.parse()`. Tool-runner loop in the SDK.

## Monorepo layout

```
meal-planner/
├── apps/
│   ├── mobile/                 # Expo app: iOS, Android, web. Desktop = Tauri wrapping the web export
│   └── marketing/              # Astro landing page (WS14)
├── packages/
│   ├── core/                   # Domain types (zod), unit conversion, list aggregation, pure logic. No I/O
│   ├── db/                     # Generated Supabase types, typed query helpers, RLS test fixtures
│   ├── ui/                     # Design system: tokens, NativeWind primitives, icons, theming
│   ├── llm/                    # Anthropic client wrapper, prompt registry, structured-output helpers, cost logging
│   ├── recipe-import/          # URL → recipe-scrapers → normalized Recipe; text, photo, caption fallbacks
│   ├── ingredient-parser/      # "2 cups diced yellow onion" → {qty, unit, ingredient, prep}
│   ├── retailers/              # RetailerAdapter interface + kroger/, browser/, mock/
│   └── agent/                  # Shopping agent: tools, policies, run state machine, review gates
├── services/
│   └── shopper-worker/         # Node worker: pgmq consumer, agent runner, Playwright host (Mode B)
├── supabase/
│   ├── migrations/             # SQL migrations, the source of truth for schema
│   ├── functions/              # Edge Functions (Deno)
│   ├── seed/                   # Ingredient ontology CSV, unit densities, sample recipes, test households
│   └── tests/                  # pgTAP RLS policy tests
├── docs/                       # These documents, the implementation guide, the status ledger, the briefs
├── .github/workflows/          # typecheck, lint, unit tests, supabase db lint, eval thresholds, web export
├── turbo.json · pnpm-workspace.yaml · biome.json · tsconfig.base.json · .env.example
└── CLAUDE.md                   # Conventions for coding agents
```

**As built (WS00).** Every path above exists. Additions and one interpretation:

- The root also holds `vitest.config.ts` (projects `unit` and `evals`), `.npmrc` (public npm registry, strict peer dependencies), and `pnpm-lock.yaml`.
- `apps/mobile/src/lib/` has `env.ts` and the storage split (`storage.ts` for web, `storage.native.ts` for MMKV, `storage.types.ts`) beside `supabase.ts` and `queryClient.ts`.
- `supabase/functions/health/` has `deno.json` and `index.test.ts` (run by Vitest) beside `index.ts`.
- `apps/marketing/` holds only a README until WS14. With no `package.json`, pnpm and Turborepo skip it.
- "Project references via `tsconfig.base.json`" is built as a shared base config, not `tsc -b`. Each package extends the base and exports its TypeScript source (`"exports": { ".": "./src/index.ts" }`), so there is no build step. Turborepo orders `typecheck` by the dependency graph.

### Package boundaries

- `packages/core` is pure: zod schemas for every domain object, unit conversion, list aggregation, line-item scoring inputs. No network, no database, no React. Everything else depends on it.
- `packages/db` wraps supabase-js with generated types. Clients and Edge Functions use the anon key under RLS. The worker uses the service-role key and must filter by household explicitly.
- `packages/retailers` exposes `RetailerAdapter` (see `04-integrations.md` §Adapter contract) and one folder per adapter. `mock/` ships fixtures for tests and evals.
- `packages/agent` depends on `core`, `retailers`, and `llm`. Hosts (worker, WebView bridge) inject the adapter instance and a persistence callback.
- `apps/mobile` depends on `core`, `db`, `ui`, and uses `agent` only in Tier 3 Mode A.

## Tooling

| Concern | Choice |
|---|---|
| Package manager and tasks | pnpm workspaces + Turborepo |
| Runtime | Node 22, pnpm 9 |
| Package scope | `@mp/*` (`@mp/core`, `@mp/db`, `@mp/ui`, `@mp/llm`, `@mp/recipe-import`, `@mp/ingredient-parser`, `@mp/retailers`, `@mp/agent`, `@mp/mobile`, `@mp/shopper-worker`) |
| Language | TypeScript, strict, project references via `tsconfig.base.json` |
| Lint and format | Biome |
| Unit tests | Vitest |
| Mobile E2E | Maestro (Phase 3+) |
| Database | Supabase CLI: `supabase start` locally, SQL migrations, `supabase gen types` into `packages/db` |
| RLS tests | pgTAP via `supabase test db` |
| Mobile distribution | EAS Build and EAS Update (internal distribution only in v1) |
| Web hosting | Cloudflare Pages for the app's static export and the marketing site (decided in the WS13 and WS14 briefs) |
| Worker hosting | Fly.io or Railway, one small always-on machine |
| Errors | Sentry: `@sentry/react-native` in the app (iOS and Android; the web build has none yet) with the Expo plugin and source maps through EAS, `@sentry/node` in the worker. Events carry the commit SHA as the release and a `household_id` tag, never a user. Edge Functions report with a plain `fetch` to Sentry's envelope endpoint (`supabase/functions/_shared/sentry.ts`), not the Deno SDK: one POST from the catch block that answers 500, scrubbed, tagged with the function and the household. suggest, recipe-import, parse-ingredients and llm-proxy report today (WS15) |
| Analytics and flags | PostHog: `posthog-react-native` in the app and `posthog-node` in the worker. Seven core-loop events with fixed properties and no PII. The flags `tier3_browser_checkout`, `shopping_agent_enabled` and `ai_suggestions_v2` are kill switches, on unless PostHog says off (`useFlag(name)` in the app, `getFlag(name, householdId)` in the worker) |
| CI | GitHub Actions: typecheck, lint, test, `supabase db lint`, eval thresholds (WS15), web export (WS13) |

## Edge Functions

| Function | Owner | Purpose |
|---|---|---|
| `health` | WS00 | Liveness and version |
| `recipe-import` | WS02 | URL, text, photo, or caption → recipe |
| `parse-ingredients` | WS03 | Batch ingredient parsing with cache |
| `list-build` | WS05 | Aggregate a plan into a grocery list |
| `suggest` | WS06 | Weekly plan composition |
| `retailer-oauth` | WS07 | Kroger OAuth callback; tokens into Vault |
| `llm-proxy` | WS08 | Server-side model calls for the on-device agent (Tier 3 Mode A), with cost caps and `ai_runs` logging |
| `run-approve` | WS09 | Record review decisions and resume a run |
| `send-push` | WS11 | Fan out one notification to a household's devices, honoring quiet hours |
| `export-data` | WS01, extended by WS12 | Export everything a user owns |

## Deep links and storage buckets

Scheme `souvie://`, registered in WS01. Routes: `join/<token>` (invites, WS01), `oauth/kroger` (Kroger redirect URI, WS07), `runs/<id>` (push notifications, WS09 and WS11). The web build serves the same paths.

Storage buckets: `avatars` (WS01), `recipe-images` (WS02), `run-screenshots` (WS08, 30-day retention).

## Environment variables

`.env.example` lists every variable. `.env.local` is gitignored. Secrets never enter the repo or the docs.

| Variable | Used by | Notes |
|---|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | app | Public |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | app | Public; RLS protects data |
| `SUPABASE_SERVICE_ROLE_KEY` | worker, Edge Functions | Secret. Never in the app bundle |
| `WORKER_DATABASE_URL` | worker | Direct Postgres connection for pgmq |
| `ANTHROPIC_API_KEY` | Edge Functions, worker | Secret |
| `KROGER_CLIENT_ID`, `KROGER_CLIENT_SECRET`, `KROGER_REDIRECT_URI` | worker, auth callback | Registered at developer.kroger.com by the human |
| `EXPO_PUBLIC_POSTHOG_KEY` | app | Public |
| `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_GIT_SHA` | app | Public-ish; the DSN stays out of docs. The SHA is the Sentry release |
| `SENTRY_DSN`, `GIT_SHA`, `POSTHOG_API_KEY` | worker | Secrets of the worker host. Without them Sentry and PostHog are off |

## Key flows

### Recipe import
Client calls Edge Function `recipe-import` with a URL, text, or image path in Storage. The function runs `packages/recipe-import`: scraper first, Sonnet extraction as fallback, Haiku parsing of ingredient lines via `packages/ingredient-parser`. It writes `recipes` and `recipe_ingredients` and returns the recipe id. Long jobs (large images) go through `import_jobs` and the worker.

### Weekly suggestion
Client calls `suggest` with the household id and week. The function retrieves candidates by pgvector similarity, applies hard filters in SQL, asks Sonnet to compose a week with structured output, and writes a draft `meal_plans` row with `meal_plan_entries`. Feedback events update `recipe_feedback`.

### Grocery list build
Client calls `list-build` for a plan. `packages/core/list` aggregates `recipe_ingredients` across entries scaled by servings, normalizes units, removes pantry items, rounds to purchasable quantities, groups by aisle, and writes `grocery_lists` and `grocery_list_items`.

### Shopping run
Client or Cron inserts a `shopping_runs` row with status `queued` and enqueues a pgmq message. The worker claims the message, loads the list and the retailer connection, and runs the agent: build the proposed cart from catalog searches, write `shopping_run_items`, set status `needs_review` or `cart_ready`, push a notification. After the user approves, the worker pushes cart adds through the adapter (ledger-driven, idempotent), sets `cart_ready`, and deep-links the user to the retailer checkout. In Tier 3 the adapter continues through slot selection and checkout under policy.

### Realtime and offline
Shared lists and run progress use Supabase Realtime on `grocery_list_items` and `shopping_runs`. The grocery list screen persists the TanStack Query cache to device storage, applies check-offs optimistically, and reconciles on reconnect. Check-off is last-write-wins per item, which is acceptable because two people rarely check the same item within seconds.

## Environments

| Env | Supabase | Worker | Retailers |
|---|---|---|---|
| Local | Hosted project via `supabase link`, `db push`, `functions deploy --use-api`. `supabase start` runs only in CI, since the development Mac has no container runtime (WS00 amendment, 2026-10-29) | `pnpm --filter shopper-worker dev` against the hosted database | MockRetailer; Kroger certification env for Products/Locations only; browser adapters against saved snapshots |
| Household (prod) | Supabase Pro project | Fly.io or Railway | Kroger production (Cart only works here); browser adapters against live sites in the WebView |

There is no separate staging in v1. The household project is production. Public launch (v2) adds staging.
