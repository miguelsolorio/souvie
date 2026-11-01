import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Browser tests for the static web export (WS13). They serve apps/mobile/dist, so build it first:
//
//   pnpm --filter @mp/mobile export:web      (CI uses the placeholder Supabase values in
//                                              support/fakeSupabase.ts, see .github/workflows/web.yml)
//   pnpm --filter @mp/e2e-web e2e
//
// Locally the Playwright browser download is optional: set E2E_BROWSER_CHANNEL=chrome to use the
// Google Chrome that is already installed. CI installs Playwright's own Chromium instead.

const PORT = Number(process.env.E2E_PORT ?? 4173);
const DIST = resolve(import.meta.dirname, process.env.E2E_DIST ?? "../apps/mobile/dist");
const channel = process.env.E2E_BROWSER_CHANNEL || undefined;

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    ...(channel ? { channel } : {}),
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      // The phone layout, to prove it did not change: 390 by 844, a touch device.
      name: "phone",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
  webServer: {
    command: `node serve.ts "${DIST}" ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
