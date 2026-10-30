import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { defineConfig } from "astro/config";

// The repo keeps one .env.local at its root for the app, the worker, and this site.
const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const envFile = fileURLToPath(new URL("../../.env.local", import.meta.url));
const local = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};

// Set MARKETING_SITE_URL (for example the Cloudflare Pages URL) to get absolute canonical and
// Open Graph URLs. Without it the build still works and those tags are left out. The real
// environment wins over .env.local.
const site = process.env.MARKETING_SITE_URL || local.MARKETING_SITE_URL || undefined;

export default defineConfig({
  site,
  output: "static",
  // Inline the one small stylesheet so the first paint needs no extra request.
  build: { inlineStylesheets: "always" },
  devToolbar: { enabled: false },
  vite: {
    envDir: rootDir,
    // Only these prefixes reach the browser bundle. Keys without them (the service role key,
    // the database URL) are never exposed.
    envPrefix: ["PUBLIC_", "EXPO_PUBLIC_"],
    // Keep scripts as files so the Content-Security-Policy in public/_headers can say
    // script-src 'self' without hashes.
    build: { assetsInlineLimit: 0 },
  },
});
