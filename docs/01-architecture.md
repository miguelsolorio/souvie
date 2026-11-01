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
- Tauri 2 (CLI 2.12) with its deep link and opener plugins, which need Rust 1.90. The Rust toolchain is not installed on the development Mac; CI compiles the shell (`.github/workflows/desktop.yml`).
- Playwright 1.64 drives the web export in `e2e-web/`. Expo Router web serves any path that is not a file from `index.html` on Cloudflare Pages, which the dynamic routes rely on (see "Web hosting and the desktop shell").
- Supabase: Free tier pauses projects after seven idle days, so the household project runs on Pro ($25/month) once it is in daily use. pgvector is the `vector` extension with HNSW indexes.
- Anthropic: `claude-haiku-5-5` $0.10/$0.50 per MTok in/out, `claude-sonnet-5-5` $2/$10, `claude-opus-5-5` $4/$20. Structured outputs via `output_config` JSON schema and `messages.parse()`. Tool-runner loop in the SDK.

## Monorepo layout

```
meal-planner/
├── apps/
│   ├── mobile/                 # Expo app: iOS, Android, web. Desktop = Tauri wrapping the web export
│   ├── desktop/                # Tauri 2 shell around apps/mobile/dist: menus, deep links (WS13)
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
├── e2e-web/                    # Playwright browser tests of the web export, against a fake Supabase (WS13)
├── docs/                       # These documents, the implementation guide, the status ledger, the briefs
├── .github/workflows/          # typecheck, lint, unit tests, supabase db lint, eval thresholds, web export, desktop build
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
| Web E2E | Playwright in `e2e-web/`, the only package that depends on it, against the static export and a fake Supabase (WS13) |
| Desktop | Tauri 2 in `apps/desktop`, wrapping `apps/mobile/dist`; macOS first (WS13) |
| Database | Supabase CLI: `supabase start` locally, SQL migrations, `supabase gen types` into `packages/db` |
| RLS tests | pgTAP via `supabase test db` |
| Mobile distribution | EAS Build and EAS Update (internal distribution only in v1) |
| Web hosting | Cloudflare Pages for the app's static export and the marketing site. Decided in WS13 and WS14; the reasons and the setup are under "Web hosting and the desktop shell" |
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
| `export-data` | WS01, extended by WS12 | Export everything a user owns |

## Deep links and storage buckets

Scheme `souvie://`, registered in WS01. Routes: `callback` (sign-in, WS01), `join/<token>` (invites, WS01), `oauth/kroger` (Kroger redirect URI, WS07), `shopping/<id>` (the run a push notification opens, WS09 and WS11; the app opens it itself from the notification's data). The web build serves the same paths. The desktop app takes `callback`, `join` and `oauth` as deep links and ignores any other first segment (`apps/mobile/src/features/auth/desktopLinks.ts`).

Storage buckets: `avatars` (WS01), `recipe-images` (WS02), `run-screenshots` (WS08, 30-day retention).

## Web hosting and the desktop shell

Built in WS13. One Expo codebase ships as a hosted web app and as a desktop app.

### Cloudflare Pages (decided)

**Why Pages.** The export is static files, so no Node host is needed. The free tier has unlimited bandwidth for static sites, a deploy is one `wrangler pages deploy`, and every branch gets a preview address. Its free tier also allows commercial use, which matters if v2 charges. Vercel's free tier is for non-commercial use. The marketing site is already on Pages (`.github/workflows/marketing.yml`).

**What is deployed.** `apps/mobile/dist`, from `expo export --platform web` with `web.output: "static"`. Never `"server"`, which is SDK 58's default: it needs a Node host and cannot be wrapped by Tauri.

- `apps/mobile/public/_headers` caches the hashed files under `/_expo/static` and `/assets` for a year and sends the basic security headers. HTML pages keep Pages' default (revalidate).
- There is no `404.html` and no `_redirects`, on purpose. Dynamic routes (`/list/<id>`, `/plan/<date>`, `/shopping/<id>`, `/recipes/<id>`, `/join/<token>`) have no file. Pages answers a path that is not a file with `/index.html` and status 200, and the router reads the address. A `404.html` would turn those paths into error pages. A rewrite such as `/list/* /list/[id].html 200` would also catch `/list/store-mode`, because Pages applies rewrites even where a file exists. `e2e-web/serve.ts` serves a folder this way, and `apps/mobile/src/lib/pagesConfig.test.ts` and `e2e-web/export.spec.ts` keep both files out.
- `apps/mobile/app/+html.tsx` is the page shell: title "Souvie", language, theme color, and a keyboard focus ring in the `borderFocus` color.
- `apps/mobile/app.config.ts` adds expo-router's `origin` from `EXPO_PUBLIC_WEB_ORIGIN`, for an https address only.

**The pipeline** (`.github/workflows/web.yml`):

| Job | Runs | Does |
|---|---|---|
| `web-export` | every pull request and push | Exports with a placeholder Supabase address, checks the export is static, runs the Playwright suite in Chromium, uploads `dist` (`web-dist-test-build`) and the report |
| `preview-web` | pull requests from this repository, once Pages is set up | Exports with the real public values and deploys to a per-branch preview address |
| `deploy-web` | `main`, once Pages is set up | Exports with the real public values and deploys to production |

**Setup for Miguel.** Until step 1 the preview and deploy jobs are skipped and main stays green. The live address is recorded in `docs/status.md` after the first deploy.

1. `npx wrangler pages project create <name> --production-branch main`, then set the repository variable `CF_PAGES_PROJECT_WEB` to `<name>`.
2. Secrets `CLOUDFLARE_API_TOKEN` (edit access to Pages) and `CLOUDFLARE_ACCOUNT_ID`, the same two the marketing site uses.
3. Variables `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`, and optionally `EXPO_PUBLIC_POSTHOG_KEY`, `EXPO_PUBLIC_SUGGEST_ENABLED` and `EXPO_PUBLIC_WEB_ORIGIN` (the site's https address, for invite links). These ship in the bundle by design.
4. In Supabase, Authentication, URL Configuration, add the redirect `https://<site origin>/callback`, and the preview origin while testing sign-in there. Set the Site URL to the production origin.

### Auth redirects

| Where | Redirect URL to allow |
|---|---|
| Web (production) | `https://<site origin>/callback` |
| Web (development) | `http://localhost:8081/**` |
| iOS, Android and the desktop app | `souvie://callback` |

Never `tauri://localhost`. A page there cannot be opened by an email client or an identity provider, and Google refuses to sign anyone in inside an embedded web view. The desktop app opens the sign-in address in the system browser and comes back through `souvie://callback`, the same link the phones use (see "The desktop shell").

### One breakpoint system

`packages/ui/src/layout.ts` defines it: phone under 768, tablet from 768, desktop from 1024. `useBreakpoint` in `apps/mobile/src/lib` reads the window width, and the Sheet primitive reads the same function, so a sheet is a bottom sheet on a phone and a centered dialog from 768. Do not compare widths to numbers anywhere else.

At the desktop breakpoint:

- The planner shows all seven days in one row. On the web, a meal can be dragged to another slot, and the arrow keys move focus between days (`apps/mobile/src/features/plan/gridInput.ts`, mounted by `GridDesktopInput.tsx`). The entry sheet's Move panel remains the way to move a meal on a phone or tablet.
- The grocery list is two panes: store sections on the left, the chosen section's items on the right (`ListTwoPane.tsx`, `panes.ts`).
- A shopping run is reviewed in a table, one row per line, with the same data and handlers as the phone's cards (`LineItemRow.tsx`).

Phone layouts are unchanged: below 768 the screens, their labels and their behavior are what they were, and `e2e-web` checks each at 390 by 844 (an `origin/main` build and this one give identical screenshots of the planner, a run and sign-in; on the web only, a checked list item's text is one shade darker for contrast). Three things do move on a tablet:

- A Sheet is a centered dialog from 768, not 640. An iPad mini in portrait (744 points wide) now gets a bottom sheet where it got a dialog.
- The seven-column planner starts at 1024, not 900. A window 900 to 1023 wide shows day cards.
- On iOS and Android the Sheet's close button is now labeled "Done, close <title>" (it was "Close <title>"), so its spoken name starts with the word on it.

### Platform files

The split is `X.native.tsx` (iOS and Android) beside an unsuffixed default (web and the desktop app). Never `*.web.*`. WS13 added or extended: `pickRecipePhoto` (a file picker and canvas on the web), `ShareIntentReceiver` and `shareCapability` (no share sheet in a browser or the desktop app, so the add screen points at pasting), `PushNotice` (a settings notice where push cannot reach), `desktop` (the shell check, the system browser and deep links), `DesktopDeepLinks` and `GridDesktopInput`. There is no haptics code, so nothing was added for it.

### The desktop shell

`apps/desktop` is a Tauri 2 project. `tauri build` runs `pnpm --filter @mp/mobile export:web`, bundles `apps/mobile/dist` into the app and writes `Souvie.app`. The bundle is inside the app, so it opens with no network and no deploy. Nothing loads a remote page.

- App id `com.miguelsolorio.souvie.desktop` (a placeholder WS14 may rename), window title Souvie, 1280 by 800.
- Menus: App, Edit, View, Window, Help, with a disabled "Check for Updates" placeholder.
- Two plugins, both allowed by name in `src-tauri/capabilities/default.json`: deep link (the operating system hands `souvie://` links to the page) and opener (the page opens an `https` address in the system browser).
- A content security policy in `tauri.conf.json`: scripts only from the bundle, calls to Supabase, PostHog and Sentry, pictures over https.
- Sign-in: Google and email links finish in the system browser and return by `souvie://callback?code=...`. The PKCE verifier stays in the window's storage.
- Rust is not installed on the development Mac and must not be installed globally. CI compiles the shell (`.github/workflows/desktop.yml`: a macOS job on main and on changes to the shell, and a Windows job that may fail). `apps/desktop/config.test.ts` holds the config to the brief without Rust.
- Signing and notarization are documented in `apps/desktop/README.md` and not done: no certificates are held.
- Not in the shell yet: the Kroger connect screen and the assisted checkout host (WS08), which open pages inside the app. They need a desktop mount.

### Browser tests

`e2e-web/` is a workspace package with Playwright and axe-core, and the only one. It serves `apps/mobile/dist` the way Pages does and answers the app's Supabase calls with `support/fakeSupabase.ts`, so no real project is touched. The export under test is built with `EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321`. The clock is fixed to Wednesday 4 November 2026. Run them with:

```bash
pnpm --filter @mp/e2e-web e2e:build    # exports with the placeholder values
pnpm --filter @mp/e2e-web e2e          # set E2E_BROWSER_CHANNEL=chrome to use an installed Chrome
```

Two locks keep them off the hosted Supabase project. `tauri build` and a plain `expo export` write to the same `apps/mobile/dist` with the repo's `.env.local`, so before any test runs `global-setup.ts` reads the bundle and stops unless it carries the placeholder address and key and no hosted project address or key. Then every spec takes `test` from `support/test.ts`, which aborts any request to a host that is not this computer and fails the test that made it (`guard.spec.ts` proves it, `support/exportGuard.test.ts` covers the first lock in the unit tests).

They cover the sign-in screen and console errors, sign-in through `/callback` with PKCE, the planner (seven columns, drag, arrows, Tab order, focus rings), the grocery list (two panes, Enter and Space, Escape on sheets), the run table, photo import, the share and push fallbacks, the desktop shell's sign-in with the real Tauri plugin packages, and an axe-core scan of each screen with every rule on and no violation of any impact allowed. They do not cover a real Supabase project, a real identity provider or the Cloudflare deploy.

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
A client taps Shop this list, or the pg_cron job `enqueue-due-scheduled-runs` (every five minutes, WS11) finds a `scheduled_runs` row whose `next_run_at` has passed and calls `enqueue_due_scheduled_runs()`. Either path goes through `enqueue_shopping_run`, which inserts a `shopping_runs` row with status `queued` and enqueues a pgmq message; a scheduled run carries `trigger = 'scheduled'` with `auto_checkout` forced off, and a schedule that cannot start (no list for the week, an inactive or Tier 3 connection, a run in progress, the daily limit, more than six hours late) is skipped with a `schedule_skipped` notification instead of a failed run. The worker claims the message, loads the list and the retailer connection, and runs the agent: build the proposed cart from catalog searches, write `shopping_run_items`, set status `needs_review` or `cart_ready`, and notify the household: every push goes through each member's `notification_preferences` and the household's quiet hours (a held push waits in `notification_outbox`, which the worker drains; a held review is marked urgent). There is no `send-push` function. After the user approves, the worker pushes cart adds through the adapter (ledger-driven, idempotent), sets `cart_ready`, and deep-links the user to the retailer checkout. In Tier 3 the adapter continues through slot selection and checkout under policy.

### Realtime and offline
Shared lists and run progress use Supabase Realtime on `grocery_list_items` and `shopping_runs`. The grocery list screen persists the TanStack Query cache to device storage, applies check-offs optimistically, and reconciles on reconnect. Check-off is last-write-wins per item, which is acceptable because two people rarely check the same item within seconds.

## Environments

| Env | Supabase | Worker | Retailers |
|---|---|---|---|
| Local | Hosted project via `supabase link`, `db push`, `functions deploy --use-api`. `supabase start` runs only in CI, since the development Mac has no container runtime (WS00 amendment, 2026-10-29) | `pnpm --filter shopper-worker dev` against the hosted database | MockRetailer; Kroger certification env for Products/Locations only; browser adapters against saved snapshots |
| Household (prod) | Supabase Pro project | Fly.io or Railway | Kroger production (Cart only works here); browser adapters against live sites in the WebView |

There is no separate staging in v1. The household project is production. Public launch (v2) adds staging.
