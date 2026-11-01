import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DIST } from "./support/dist";
import { expect, test } from "./support/test";

// WS13 acceptance criterion 1: the export is plain files. No Node host, no server bundle, so it
// can sit on Cloudflare Pages and inside the desktop app. These read the folder, not a page.

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

test.describe("the web export", () => {
  test("is static: index.html, no server folder", () => {
    expect(existsSync(join(DIST, "index.html"))).toBe(true);
    expect(existsSync(join(DIST, "server"))).toBe(false);
  });

  test("carries what Cloudflare Pages reads, and no 404.html", () => {
    expect(existsSync(join(DIST, "_headers"))).toBe(true);
    // A 404.html would stop Pages from sending dynamic routes to the router.
    expect(existsSync(join(DIST, "404.html"))).toBe(false);
    expect(existsSync(join(DIST, "favicon.ico"))).toBe(true);
  });

  test("has a page for each fixed route the app links to", () => {
    for (const page of [
      "sign-in.html",
      "callback.html",
      "plan/index.html",
      "list/index.html",
      "list/store-mode.html",
      "shopping/index.html",
      "recipes/new.html",
      "profile.html",
    ]) {
      expect(existsSync(join(DIST, page)), page).toBe(true);
    }
  });

  test("ships no secret and no server-only variable in its files", () => {
    const text = walk(DIST)
      .filter((path) => /\.(js|html|json|css)$/.test(path))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    // The service-role key and the worker's database URL belong to the worker and the Edge
    // Functions only (docs/05-security-privacy.md). Their names never appear in the bundle.
    for (const name of ["SUPABASE_SERVICE_ROLE_KEY", "WORKER_DATABASE_URL", "ANTHROPIC_API_KEY"]) {
      expect(text.includes(name), `${name} found in the export`).toBe(false);
    }
  });

  test("loads its scripts and styles from the site's own root (the desktop shell needs that)", () => {
    const html = readFileSync(join(DIST, "index.html"), "utf8");
    const sources = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
    expect(sources.length).toBeGreaterThan(3);
    for (const source of sources) {
      // "/_expo/static/..." resolves against tauri://localhost and against the Pages origin alike.
      expect(source, "an absolute path on the same site").toMatch(/^\/_expo\//);
    }
  });
});
