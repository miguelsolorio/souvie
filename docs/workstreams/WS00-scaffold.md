# WS00: Repo & infra scaffold

**Wave:** 0 · **Suggested model:** Opus · **Branch:** `ws/00-scaffold`

## Goal
A working monorepo skeleton that every later workstream builds inside. When this is done, a fresh clone installs, typechecks, lints, tests, boots the Expo app on iOS Simulator and web with a placeholder screen, starts a local Supabase stack with one Edge Function, and runs a worker that connects to Postgres and polls an empty queue. CI runs the same checks. Nothing product-specific is built here; the value is that waves 1 through 6 never fight over tooling.

## Depends on
None. This is the first workstream. It consumes only the decisions in `docs/01-architecture.md`.

## Read first
1. `docs/01-architecture.md` (whole file: system diagram, monorepo layout, tooling, platform versions)
2. `docs/02-data-model.md` §RLS pattern (to know what `packages/db` will hold later; create no tables here)
3. `CLAUDE.md` (conventions; do not edit it)

## In scope
- pnpm workspaces + Turborepo root with `turbo.json`, `pnpm-workspace.yaml`, `biome.json`, `tsconfig.base.json`, `.gitignore`, `.env.example`
- `apps/mobile`: Expo SDK 58 (React Native 0.88) app with Expo Router, `web.output: "static"`, NativeWind configured, TanStack Query provider with a persisted cache (MMKV on native, localStorage on web), supabase-js client reading `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`, one placeholder home screen
- `apps/marketing`: empty Astro project placeholder with a README only (WS14 fills it)
- `packages/core`, `packages/db`, `packages/ui`, `packages/llm`, `packages/recipe-import`, `packages/ingredient-parser`, `packages/retailers`, `packages/agent`: each with `package.json`, `src/index.ts`, `README.md`, a Vitest smoke test, and a `tsconfig.json` extending the base
- `packages/retailers/src/mock/MockRetailer.ts`: a stub class exporting the name only, so WS07 has a known location
- `services/shopper-worker`: Node 22 + TypeScript skeleton that reads `WORKER_DATABASE_URL`, connects with `postgres` (postgres.js), and polls a pgmq queue named `shopping_run` every 5 seconds, logging "idle" when empty
- `supabase/`: `supabase init` output, `supabase/functions/health/index.ts` returning `{ ok: true, version }`, `supabase/seed/README.md`, `supabase/tests/README.md`, a migration `<timestamp>_extensions.sql` enabling `pgmq`, `pg_cron`, `vector`, `pg_trgm`, and `pgtap`
- `.github/workflows/ci.yml`: install, typecheck, lint, test, `supabase db lint`
- Root scripts: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm eval` (runs `vitest run --project evals`, passes with zero evals), `pnpm dev`

## Out of scope
- Any product table or RLS policy (WS01 creates identity tables; each later WS adds its own migration)
- Auth screens or providers (WS01)
- Design tokens beyond a NativeWind config and one color (WS14 and later UI work)
- Real queue job handlers in the worker (WS09)
- Sentry and PostHog wiring beyond reading their env vars (WS15)
- EAS Build configuration (WS13)

## Deliverables
- `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `biome.json`, `tsconfig.base.json`, `.gitignore`, `.env.example`, `README.md` (update the "Getting started" section only)
- `.github/workflows/ci.yml`
- `apps/mobile/` with `app.json` (or `app.config.ts`), `app/_layout.tsx`, `app/index.tsx`, `src/lib/supabase.ts`, `src/lib/queryClient.ts`, `tailwind.config.js`, `global.css`, `babel.config.js`, `metro.config.js`
- `apps/marketing/README.md`
- `packages/<name>/package.json`, `packages/<name>/src/index.ts`, `packages/<name>/src/index.test.ts`, `packages/<name>/README.md`, `packages/<name>/tsconfig.json` for all eight packages
- `packages/retailers/src/mock/MockRetailer.ts`
- `services/shopper-worker/package.json`, `services/shopper-worker/src/index.ts`, `services/shopper-worker/src/queue.ts`, `services/shopper-worker/README.md`
- `supabase/config.toml`, `supabase/migrations/<timestamp>_extensions.sql`, `supabase/functions/health/index.ts`, `supabase/seed/README.md`, `supabase/tests/README.md`
- `docs/01-architecture.md`: append a short "As built" note under the monorepo layout if any path differs from the doc

## Interfaces
**Implements**
- Workspace package names: `@mp/core`, `@mp/db`, `@mp/ui`, `@mp/llm`, `@mp/recipe-import`, `@mp/ingredient-parser`, `@mp/retailers`, `@mp/agent`, `@mp/mobile`, `@mp/shopper-worker`. Later briefs import by these names.
- `.env.example` with exactly: `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `KROGER_CLIENT_ID`, `KROGER_CLIENT_SECRET`, `KROGER_REDIRECT_URI`, `INSTACART_API_KEY`, `INSTACART_ENV`, `EXPO_PUBLIC_POSTHOG_KEY`, `SENTRY_DSN`, `WORKER_DATABASE_URL`
- Queue name `shopping_run` in pgmq
- Vitest projects: `unit` (default) and `evals` (files matching `**/evals/**/*.eval.ts`)

**Consumes**
- Nothing from other workstreams.

Shared contracts (`packages/core` types, `RetailerAdapter`) are not defined here. Leave `packages/core/src/index.ts` exporting an empty object with a comment pointing to `docs/02-data-model.md`.

**Example `turbo.json` pipeline**
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "typecheck": { "dependsOn": ["^typecheck"] },
    "lint": {},
    "test": { "dependsOn": ["^build"] },
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "dev": { "cache": false, "persistent": true }
  }
}
```

**Example `.env.example`** (values empty, comments explain where each comes from)
```bash
EXPO_PUBLIC_SUPABASE_URL=            # supabase status -> API URL
EXPO_PUBLIC_SUPABASE_ANON_KEY=       # supabase status -> anon key
SUPABASE_SERVICE_ROLE_KEY=           # worker and Edge Functions only
ANTHROPIC_API_KEY=
KROGER_CLIENT_ID=                    # developer.kroger.com app (WS07)
KROGER_CLIENT_SECRET=
KROGER_REDIRECT_URI=mealplanner://oauth/kroger
INSTACART_API_KEY=                   # dev key works without approval (WS08)
INSTACART_ENV=dev                    # dev | prod
EXPO_PUBLIC_POSTHOG_KEY=
SENTRY_DSN=
WORKER_DATABASE_URL=                 # supabase status -> DB URL
```

## Acceptance criteria
1. `pnpm install` completes on a clean clone with Node 22 and pnpm 9 with no peer-dependency errors.
2. `pnpm typecheck` exits 0 across all workspaces.
3. `pnpm lint` exits 0 (Biome) across all workspaces.
4. `pnpm test` runs at least one Vitest test per package and exits 0.
5. `pnpm eval` exits 0 with "no tests found" treated as success for the `evals` project.
6. `pnpm --filter @mp/mobile start` then pressing `w` serves the placeholder screen at `http://localhost:8081` and the text "Meal Planner" is visible.
7. `pnpm --filter @mp/mobile start` then pressing `i` opens the iOS Simulator and renders the same screen (verified by screenshot in the report).
8. `npx expo export --platform web` in `apps/mobile` produces a `dist/` folder with `index.html` (static output).
9. `supabase start` boots; `supabase db reset` applies `<timestamp>_extensions.sql`; `select extname from pg_extension` lists `pgmq`, `pg_cron`, `vector`, `pg_trgm`, `pgtap`.
10. `supabase functions serve health` then `curl http://localhost:54321/functions/v1/health` returns `{"ok":true,...}`.
11. `pnpm --filter @mp/shopper-worker dev` with `WORKER_DATABASE_URL` pointing at local Supabase logs "connected" and then "idle" at least twice within 15 seconds.
12. `.github/workflows/ci.yml` runs install, typecheck, lint, test, and `supabase db lint` and is green on the branch (paste the run URL or local `act` output).
13. `git grep -n "KROGER_CLIENT_SECRET=" -- ':!.env.example'` returns nothing (no secrets committed).

## Verification commands
```bash
pnpm install                      # exit 0
pnpm typecheck                    # exit 0
pnpm lint                         # exit 0
pnpm test                         # exit 0, >= 9 test files
pnpm eval                         # exit 0
cd apps/mobile && npx expo export --platform web && ls dist/index.html && cd ../..
supabase start && supabase db reset
psql "$WORKER_DATABASE_URL" -c "select extname from pg_extension" | grep -E "pgmq|pg_cron|vector|pg_trgm|pgtap"
supabase functions serve health & sleep 3 && curl -s http://localhost:54321/functions/v1/health
timeout 15 pnpm --filter @mp/shopper-worker dev   # logs "connected" then "idle"
```

## Risks and notes
- Expo SDK 58 defaults `web.output` to `server`. Set `"static"` in `app.json` or the web export and Tauri wrapping (WS13) break.
- `react-native-macos` lags RN 0.88. Do not add a macOS target; desktop is Tauri over the web export (WS13).
- Keep NativeWind at the version that supports RN 0.88; pin it in `apps/mobile/package.json`.
- `pg_cron` and `pgmq` are available in local Supabase but `pg_cron` needs `shared_preload_libraries`; confirm `supabase/config.toml` enables it, or document the gap for WS11.
- Mitigates R7 (Expo web gaps) by proving web and iOS render from the same code on day one.
- Mitigates R8 (scope creep) by giving every later WS fixed paths and commands.
- Human checkpoint 1 follows this WS: the orchestrator pauses for the human to approve lint rules, package names, and CI shape before wave 1.

**Suggested build order**
1. Root: `pnpm init`, workspace file, Turborepo, Biome, base tsconfig, `.gitignore`, `.env.example`.
2. `packages/*` shells with one smoke test each; confirm `pnpm typecheck && pnpm test` pass before any app code.
3. `apps/mobile`: `npx create-expo-app` with the Expo Router template, pin SDK 58, add NativeWind, TanStack Query, supabase-js; placeholder screen; verify web and iOS.
4. `supabase init`, `<timestamp>_extensions.sql`, `health` function; verify `supabase start` and the curl.
5. `services/shopper-worker`: postgres.js connection, pgmq `read` loop, `idle` log.
6. `.github/workflows/ci.yml`; run it (or `act`) until green.
7. Fill READMEs; write the completion report with screenshots and the CI link.

## Completion report
End with the completion report from `docs/implementation-guide.md` §6.2 (Message templates). Include the iOS Simulator screenshot path and the CI run link under Verification output.

## Amendment 2026-10-29: no container runtime on the development machine

Docker cannot be installed on the development Mac. The Supabase CLI commands that need containers (`supabase start`, `supabase db reset`, `supabase functions serve`, `supabase db lint --local`, and later `supabase test db`) run in GitHub Actions instead. Local verification uses the hosted Supabase project. This section replaces criteria 9 to 12 and the matching verification commands above. Everything else in the brief stands.

**Environment on the development machine**
- `.env.local` lives at the primary checkout root. Copy it into your worktree root before the hosted steps. It is gitignored. Never paste any of its values into a report or a commit.
- The Supabase CLI reads `SUPABASE_ACCESS_TOKEN` from the environment for `link`, `db push`, and `functions deploy`. Miguel adds it to `.env.local`. Load the file into your shell first: `set -a; . ./.env.local; set +a`. If the token is not there yet, finish the CI path, report the hosted steps as pending the token, and say so plainly.
- `psql` is at `/opt/homebrew/opt/libpq/bin/psql`. Node 22 and pnpm 9 are not installed globally; install them for your own shell only (nvm, corepack, or brew) and change no global config.
- Xcode is installed at `/Applications/Xcode.app`. If `xcode-select -p` still points at the Command Line Tools, prefix Simulator commands with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`. Criterion 7 stands as written.

**Interfaces change.** `.env.example` lists thirteen variables: the twelve above plus `SUPABASE_ACCESS_TOKEN` (comment: personal access token for the Supabase CLI, developer machines only, never used by the app or the worker).

**Criterion 9 (replaces the original).** Two parts, both required.
- CI: a job runs `supabase start` (or `supabase db start`), `supabase db reset`, then `psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')" -c "select extname from pg_extension"` and fails unless `pgmq`, `pg_cron`, `vector`, `pg_trgm`, and `pgtap` are all listed.
- Hosted: `supabase link --project-ref <ref>` (the ref is the host part of `EXPO_PUBLIC_SUPABASE_URL`) and `supabase db push` apply `<timestamp>_extensions.sql` to the hosted project. `psql "$WORKER_DATABASE_URL" -c "select extname from pg_extension"` lists the same five extensions.

**Criterion 10 (replaces the original).** Two parts, both required.
- CI: `supabase functions serve health &`, then `curl -s http://localhost:54321/functions/v1/health` returns a body containing `"ok":true`.
- Hosted: `supabase functions deploy health --use-api --no-verify-jwt`, then `curl -s -H "apikey: $EXPO_PUBLIC_SUPABASE_ANON_KEY" "$EXPO_PUBLIC_SUPABASE_URL/functions/v1/health"` returns a body containing `"ok":true`.

**Criterion 11 (replaces the original).** Two parts, both required.
- CI: with `WORKER_DATABASE_URL` taken from `supabase status`, run the worker for 15 seconds and fail unless the log contains `connected` and at least two `idle` lines.
- Hosted: with `WORKER_DATABASE_URL` from `.env.local`, the same run shows `connected` and at least two `idle` lines within 15 seconds.

**Criterion 12 (replaces the original).** `.github/workflows/ci.yml` runs install, typecheck, lint, test, eval, `supabase db lint`, and the three CI parts above. It is green on `ws/00-scaffold`. Paste the run URL. There is no `act` fallback.

**Verification commands (replace the Supabase and worker lines above)**
```bash
pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm eval
cd apps/mobile && npx expo export --platform web && ls dist/index.html && cd ../..
set -a; . ./.env.local; set +a
pnpm supabase link --project-ref "$(echo "$EXPO_PUBLIC_SUPABASE_URL" | sed -E 's#https://([^.]+)\..*#\1#')"
pnpm supabase db push
/opt/homebrew/opt/libpq/bin/psql "$WORKER_DATABASE_URL" -c "select extname from pg_extension" | grep -E "pgmq|pg_cron|vector|pg_trgm|pgtap"
pnpm supabase functions deploy health --use-api --no-verify-jwt
curl -s -H "apikey: $EXPO_PUBLIC_SUPABASE_ANON_KEY" "$EXPO_PUBLIC_SUPABASE_URL/functions/v1/health"
pnpm --filter @mp/shopper-worker dev   # stop after 15 s; logs "connected" then "idle" at least twice
gh run list --branch ws/00-scaffold --limit 1   # the CI run URL for criterion 12
```
