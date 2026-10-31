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
