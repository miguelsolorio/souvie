/// <reference types="node" />
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The files Cloudflare Pages reads from the export (WS13). They live in apps/mobile/public, which
// `expo export` copies to the root of dist.
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

/** `_headers` as { "/path/*": { "Header-Name": "value" } }. */
function parseHeaders(text: string): Record<string, Record<string, string>> {
  const rules: Record<string, Record<string, string>> = {};
  let current: Record<string, string> | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!line.startsWith(" ")) {
      current = {};
      rules[line.trim()] = current;
    } else if (current) {
      const colon = line.indexOf(":");
      current[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
  }
  return rules;
}

describe("public/_headers", () => {
  const rules = parseHeaders(readFileSync(join(PUBLIC, "_headers"), "utf8"));

  it("keeps the hashed files for a year and says they never change", () => {
    for (const path of ["/_expo/static/*", "/assets/*"]) {
      expect(rules[path]?.["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    }
  });

  it("does not cache the HTML pages: no cache rule on /*", () => {
    expect(rules["/*"]?.["Cache-Control"]).toBeUndefined();
  });

  it("sends the basic security headers on every page", () => {
    expect(rules["/*"]).toMatchObject({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY",
    });
  });

  it("allows the camera only for this origin and nothing else sensitive", () => {
    expect(rules["/*"]?.["Permissions-Policy"]).toBe(
      "camera=(self), microphone=(), geolocation=(), payment=()",
    );
  });
});

describe("public/", () => {
  it("has no 404.html and no _redirects: dynamic routes rely on the single-page fallback", () => {
    // With no top-level 404.html, Cloudflare Pages answers any path that is not a file with the
    // root page and lets the router take over, which is what /list/<id> and /join/<token> need.
    // A 404.html would turn those into error pages. A _redirects rewrite would shadow
    // /list/store-mode, since Pages applies rewrites even where a file exists.
    expect(existsSync(join(PUBLIC, "404.html"))).toBe(false);
    expect(existsSync(join(PUBLIC, "_redirects"))).toBe(false);
  });
});
