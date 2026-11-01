import { defineConfig, devices } from "@playwright/test";
import { DIST } from "./support/dist";

// Browser tests for the static web export (WS13). They serve apps/mobile/dist, so build it first.
// The tests answer the app's Supabase calls themselves (support/fakeSupabase.ts), so the export
// must be built with the matching placeholder values:
//
//   EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
//   EXPO_PUBLIC_SUPABASE_ANON_KEY=fake-anon-key-for-browser-tests \
//     pnpm --filter @mp/mobile export:web
//   pnpm --filter @mp/e2e-web e2e
//
// `pnpm --filter @mp/e2e-web e2e:build` does the first step. .github/workflows/web.yml runs both.
//
// Locally the Playwright browser download is optional: set E2E_BROWSER_CHANNEL=chrome to use the
// Google Chrome that is already installed. CI installs Playwright's own Chromium instead.

const PORT = Number(process.env.E2E_PORT ?? 4173);
const channel = process.env.E2E_BROWSER_CHANNEL || undefined;

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  // Refuses to run against an export that could reach the hosted Supabase project.
  globalSetup: "./global-setup.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  // One browser and the brief's 1280 by 800 laptop window. A spec that needs the phone layout says
  // so with `test.use(PHONE)` (support/viewports.ts) for its own tests.
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 800 },
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    // The fixtures fix the clock to a date in UTC (support/app.ts).
    timezoneId: "UTC",
    locale: "en-US",
    ...(channel ? { channel } : {}),
  },
  webServer: {
    command: `node serve.ts "${DIST}" ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
