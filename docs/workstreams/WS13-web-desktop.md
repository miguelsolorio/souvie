# WS13: Web & desktop packaging

**Wave:** 6 · **Suggested model:** Sonnet · **Branch:** `ws/13-web-desktop`

## Goal
When this is done, the same Expo codebase ships as a hosted web app and as a desktop app. The planner and grocery list work comfortably at laptop widths with a keyboard, the web build deploys from CI, and a Tauri 2 shell wraps the static export for macOS and Windows with native menus. This is how "start with mobile, then desktop" lands without a second codebase.

## Depends on
- WS00 (Scaffold): `apps/mobile` Expo Router app with `web.output: "static"` already configured, pnpm workspaces, CI skeleton.
- WS04 (Planner UI): the week view and slot assignment screens that need responsive layouts.
- WS05 (Grocery list): the list and in-store mode screens that need responsive layouts.
- WS01 (Auth & households): sign-in must work on web (Supabase OAuth redirect flow for Google; Apple web sign-in).

## Read first
1. `docs/01-architecture.md` (Clients, "Why Expo web instead of a separate Next.js app", Platform versions)
2. `docs/00-overview.md` §1 (what the planner and list must do; v1 cut list)
3. `docs/06-risks.md` (R7 Expo web gaps for native modules)
4. `docs/workstreams/WS04-planner-ui.md` and `WS05-grocery-list.md` (Deliverables sections only, to know the screen paths)

## In scope
- Web static export: `npx expo export --platform web` from `apps/mobile` produces `apps/mobile/dist` with `web.output: "static"` (not `"server"`, which is SDK 58's default and would require a Node host and break Tauri wrapping).
- Hosting on **Cloudflare Pages**. Reason: free tier with unlimited bandwidth for static sites, a single `wrangler pages deploy` step, preview URLs per branch, and no Node runtime needed for a static export. Vercel works too but its free tier is for non-commercial use and we may monetize in v2. Record the choice in `docs/01-architecture.md`.
- Deep-link and auth redirect config for the web origin: Supabase redirect URLs, Expo Router `scheme` and `origin`, and a `/auth/callback` route that works on web.
- Responsive layouts at ≥1024px for: planner week view (7 columns visible at once, drag-to-slot with mouse), grocery list (two-pane: sections on the left, items on the right), run review screen (table layout). Phone layouts must not change.
- Keyboard basics: tab order through interactive elements, Enter to check an item, Escape to close sheets, arrow keys to move between planner days. Visible focus rings.
- Platform-specific files (`*.web.tsx`, `*.native.tsx`) for any module without a web implementation (camera for photo import, share-sheet receiver, Expo Push registration, haptics). Web fallbacks: file picker for photos, "paste a link" for share, no-op for haptics and push with a settings notice.
- Tauri 2 desktop app in `apps/desktop`: loads the static web build (bundled, not remote), window title from the brand name (Souvie), native menu bar with App, Edit, View, Window, Help, and a "Check for updates" placeholder item. macOS first; Windows build job may be allowed to fail until a Windows runner is available.
- CI: `web-export` job on every PR runs the export and uploads `dist` as an artifact; `deploy-web` job on `main` deploys to Cloudflare Pages; `desktop-build` job on `main` builds the macOS Tauri bundle and uploads it as an artifact.
- Smoke test: a Playwright test (`apps/mobile/e2e-web/home.spec.ts`) that serves `dist`, loads `/`, and asserts the sign-in screen renders and the title is correct.

## Out of scope
- React Native macOS or React Native Windows. They lag Expo's React Native version and Expo has no desktop target. Tauri wrapping the web build is the path (see `docs/01-architecture.md`).
- The marketing site (`apps/marketing`, WS14).
- Auto-update infrastructure for the desktop app. Leave the menu item as a placeholder.
- Code signing and notarization for macOS distribution. Document the steps in `apps/desktop/README.md`; do not acquire certificates.
- Tier 3 assisted-checkout WebView on desktop (WS08 host, WS10 adapters). This WS only ensures a WebView-capable shell exists; WS08's host must be able to mount in it.
- Any new product feature. Only layout, input, packaging, and deployment.
- Offline web support beyond what TanStack Query persistence already gives (service worker caching is a later WS).

## Deliverables
- `apps/mobile/app.json` (or `app.config.ts`): `web.output: "static"`, `web.bundler: "metro"`, `scheme`, web `favicon`.
- `apps/mobile/src/layout/useBreakpoint.ts`: `phone | tablet | desktop` hook with tests.
- Responsive variants: `apps/mobile/app/(app)/plan/index.tsx` (and any extracted `WeekGrid` component), `apps/mobile/app/(app)/list/[id].tsx`, `apps/mobile/app/(app)/runs/[id].tsx`, each reading `useBreakpoint`.
- Platform files: `apps/mobile/src/platform/photoPicker.{native,web}.ts`, `shareReceiver.{native,web}.ts`, `push.{native,web}.ts`, `haptics.{native,web}.ts`.
- `apps/mobile/app/auth/callback.tsx` working on web.
- `apps/mobile/e2e-web/home.spec.ts`, `apps/mobile/playwright.config.ts`.
- `apps/desktop/`: `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/src/main.rs` (menus), `package.json` with `tauri dev` and `tauri build` scripts pointing at `../mobile/dist`, `README.md` (build, signing steps, known limits).
- `.github/workflows/web.yml` (export on PR, deploy on main) and `.github/workflows/desktop.yml` (macOS build on main).
- `docs/01-architecture.md`: record Cloudflare Pages choice and the desktop packaging steps.

## Interfaces
**Implements**
- `useBreakpoint(): 'phone' | 'tablet' | 'desktop'` in `apps/mobile/src/layout/useBreakpoint.ts` (thresholds 0, 768, 1024).
- Platform modules with identical signatures across `.native.ts` and `.web.ts`: `pickPhoto(): Promise<Blob | null>`, `onSharedContent(cb)`, `registerPush(): Promise<string | null>`, `haptic(kind)`.
- Tauri app id `com.miguelsolorio.souvie.desktop` (placeholder; WS14 may rename, coordinate in the report).

**Consumes**
- Screens and components from WS04 and WS05 as they exist; add layout branches, do not change behavior.
- Supabase Auth redirect configuration from WS01 (add the web origin and the Tauri origin `tauri://localhost`).
- `packages/ui` tokens for focus ring color and spacing.
- Shared contracts in `packages/core` are not touched by this WS.

## Acceptance criteria
1. `cd apps/mobile && npx expo export --platform web` completes and `dist/index.html` exists; the export contains no server bundle (`dist/server` does not exist).
2. `npx playwright test` in `apps/mobile` passes `home.spec.ts` against the static `dist` served locally.
3. At a 1280×800 viewport the planner shows all seven days in one row and drag-and-drop with a mouse moves a recipe between days; at 390×844 the phone layout is unchanged from WS04 (screenshot comparison in the PR).
4. At 1280×800 the grocery list renders two panes and checking an item with the Enter key toggles it; Escape closes an open sheet; Tab reaches every interactive control in order (manual checklist in the PR, plus an axe-core pass with zero serious violations).
5. Google sign-in completes on web via `/auth/callback` on the local static server and on the Cloudflare preview URL.
6. Photo import on web opens a file picker and produces a recipe through the same WS02 pipeline; share-sheet import on web shows the "paste a link" fallback.
7. `cd apps/desktop && pnpm tauri build` produces a macOS `.app` that opens, shows the window title, shows the native menu bar with the five menus, and loads the home screen offline (no network required for the shell).
8. The `web-export` workflow passes on the PR and uploads a `dist` artifact; the `deploy-web` workflow on `main` deploys to Cloudflare Pages and the URL serves the app (record the URL in `docs/status.md` via the completion report).
9. No web console errors on load of `/` and `/plan` (checked in the Playwright test with a console error listener).
10. `pnpm typecheck && pnpm lint && pnpm test` pass at the repo root.

## Verification commands
```bash
cd apps/mobile && npx expo export --platform web && ls dist/index.html   # expected: file exists
cd apps/mobile && npx playwright test                                      # expected: home.spec.ts passes
pnpm --filter mobile start   # press w; expected: app opens in browser; resize to 1280 wide and check planner/list layouts
cd apps/desktop && pnpm tauri dev                                          # expected: window opens with menus and home screen
cd apps/desktop && pnpm tauri build                                        # expected: .app in src-tauri/target/release/bundle
pnpm typecheck && pnpm lint && pnpm test                                   # expected: clean
gh run list --workflow web.yml --limit 1                                   # expected: success on the PR
```

## Risks and notes
- R7: Expo SDK 58 defaults `web.output` to `"server"`. Set `"static"` explicitly or the export will not work under Tauri or Cloudflare Pages static hosting.
- Metro web requires every imported native module to have a web shim. Audit imports with `npx expo-doctor` and by running the export; any failing module gets a platform-specific file.
- React Native Web and drag-and-drop: use the same gesture library as WS04 (likely `react-native-gesture-handler` + `react-native-reanimated`), both of which support web; verify mouse drags, not just touch.
- Tauri 2 requires Rust toolchain on the CI runner; cache it. Windows builds need a Windows runner; allow that job to be optional until one exists.
- Tauri loads local files from a custom protocol; Supabase OAuth redirects need the `tauri://localhost` origin allowed in the Supabase dashboard, or use the system browser plus a deep link. Document whichever you pick.
- Do not fetch the web build remotely in Tauri. Bundle `dist` so the shell works without a deploy and the offline list still opens.
- Keep phone layouts byte-for-byte unchanged in behavior; reviewers will compare screenshots.

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

WS13-specific:
1. **Paths.** The auth callback is `app/(auth)/callback.tsx` served at `/callback`; the run route is `app/(app)/shopping/[id].tsx` (docs/01 still says `runs/<id>`: fix that line). `WeekGrid` is already extracted and already seven-column at 900 px (`WIDE_GRID_MIN_WIDTH`); `SHEET_DIALOG_MIN_WIDTH` is 640 in `packages/ui/src/primitives/logic.ts`. Use those constants or move them into one `useBreakpoint` in `apps/mobile/src/lib/` and update both call sites; do not add a second breakpoint system.
2. **Platform files.** The repo's split is `X.native.tsx` plus the unsuffixed default for web (`lib/storage`, `lib/authStorage`, `PushLifecycle`); keep it, never `*.web.*`. Existing modules to extend rather than replace: `features/recipes/pickRecipePhoto.ts` (returns `{bytes, contentType}`), `ShareIntentReceiver.tsx` with `sharedInbox.ts`, `lib/share.ts`. There is no haptics code.
3. **What is already done.** `app.json` has `web.output: "static"`, `bundler: "metro"`, the favicon and `scheme: "souvie"`; `export:web` exists in `apps/mobile/package.json`; docs/01 already records Cloudflare Pages and Tauri. Missing: `extra.eas.projectId` (Miguel's) and the `expo-router` `origin`.
4. **Playwright (decided).** Web end-to-end tests live in a root workspace package `e2e-web/` (its own `package.json`, `@playwright/test`, `playwright.config.ts`, `*.spec.ts`), not under `apps/mobile`; WS10's no-Playwright grep excludes that directory. Root `pnpm test` collects only `*.test.ts(x)`, so wire the Playwright run as its own script and CI step.
5. **CI and deploy.** No `web.yml` or `desktop.yml` exists; add them. `marketing.yml`'s `deploy-marketing` job is the template for Pages (secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, a `CF_PAGES_PROJECT_*` variable); the Pages project does not exist yet, so the deploy job is gated on the variable and the live URL waits on Miguel. `apps/desktop` joins the workspace through `apps/*`; keep its tasks out of root `typecheck`, `lint` and `test` until Tauri's toolchain is confirmed on the dev Mac (Rust is not installed there; CI builds it).
6. **Responsive work that does not exist yet:** the grocery two-pane layout, the run-review table, any drag-and-drop in the planner (`moveEntry` and menus are the move path; `react-native-gesture-handler` is not a dependency). Scope drag-and-drop out unless the brief's criterion requires it; say so in Deviations.
7. **Docs.** docs/00 has no §1: use "v1 must-haves" and "Explicitly out of v1". docs/01 has no "Clients" heading: "Why Expo web instead of a separate Next.js app" and "Platform versions". Tokens: `borderFocus` exists in light and dark.


## Follow-ups recorded after review (2026-11-01, merged 04fcd1d)

Non-blocking items from the two review rounds, for a later round or for the workstreams named:
1. docs/01's phone-layout sentence says labels below 768 are unchanged; three label strings did change on every platform ("Add another recipe to ...", "Open recipe for ...", the Sheet close label "Done, close X"). Reword it. Meaning is equivalent and no layout moves.
2. `e2e-web/support/test.ts` sets the non-loopback route guard on `page` only; a spec using `browser.newContext()`, `context.newPage()` or the `request` fixture would bypass it. Move the guard onto the `context` fixture.
3. The wide planner is never tested in `plan_mode: "simple"` (`world.ts:46` is `"full"`), the default for new households. Add a simple-mode scan and drag test.
4. Drag-and-drop ran only in Chromium; add a WebKit or Firefox project, and run it once in WKWebView and WebView2.
5. `_headers` carries no CSP or HSTS.
6. Miguel: create the Cloudflare Pages project and set `CF_PAGES_PROJECT_WEB`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` in GitHub; add `https://<origin>/callback` to the Supabase redirect list; then run the sign-in check on the preview URL and record the live URL in docs/status.md.
7. Desktop: sign and notarize the macOS app, then add `"dmg"` to `bundle.targets`; an updater behind the placeholder menu item; run the Windows installer on a real machine; mount WS08's host and WS10's adapters in the desktop shell; a real `souvie://` deep link on an installed `.app`.
8. Cache Playwright's browsers in CI; consider `sitemap: false` in the expo-router plugin for production; the Sheet's initial focus lands on the backdrop Close button; a genuinely unknown URL logs React error 418.
