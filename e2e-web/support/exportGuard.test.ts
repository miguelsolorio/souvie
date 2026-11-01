/// <reference types="node" />
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { assertTestBuild, FAKE_KEY, FAKE_URL, problemsWithTestBuild } from "./exportGuard";

// The first lock that keeps the browser tests off the hosted Supabase project (WS13 fix round):
// global-setup.ts calls assertTestBuild, which refuses any export but the placeholder build. These
// run in the repo's ordinary unit tests, so the lock itself is tested without a browser.

const GOOD = `const url="${FAKE_URL}",key="${FAKE_KEY}";`;
const PROJECT = "https://abcdefghijklmnopqrst.supabase.co";
// Not a real key: three base64url parts, the first two starting the way a JWT's do.
const JWT = `eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.${"a".repeat(20)}`;

describe("problemsWithTestBuild", () => {
  it("accepts the placeholder build", () => {
    expect(problemsWithTestBuild([GOOD])).toEqual([]);
  });

  it("reads across files: the address in one, the key in another", () => {
    expect(problemsWithTestBuild([`x="${FAKE_URL}"`, `y="${FAKE_KEY}"`])).toEqual([]);
  });

  it("refuses a build that lacks the placeholder address, which is what a real .env.local gives", () => {
    const problems = problemsWithTestBuild([`const url="${PROJECT}",key="${FAKE_KEY}";`]);
    expect(problems.join("\n")).toContain(`placeholder Supabase address ${FAKE_URL}`);
  });

  it("refuses a build that lacks the placeholder key", () => {
    const problems = problemsWithTestBuild([`const url="${FAKE_URL}";`]);
    expect(problems.join("\n")).toContain(FAKE_KEY);
  });

  it("refuses a hosted project address even when the placeholder is there too", () => {
    const problems = problemsWithTestBuild([GOOD, `fetch("${PROJECT}/auth/v1/otp")`]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(PROJECT);
  });

  it("refuses every hosted domain Supabase uses", () => {
    for (const host of ["abc.supabase.co", "abc.supabase.in", "abc.supabase.net"]) {
      expect(problemsWithTestBuild([GOOD, `"http://${host}"`]).length, host).toBe(1);
    }
  });

  it("refuses a JWT, which a real anon or service key is", () => {
    expect(problemsWithTestBuild([GOOD, `const key="${JWT}";`]).join("\n")).toContain("JWT");
  });

  it("refuses the newer key formats", () => {
    expect(problemsWithTestBuild([GOOD, `"sb_publishable_AbCd1234"`]).length).toBe(1);
    expect(problemsWithTestBuild([GOOD, `"sb_secret_AbCd1234"`]).length).toBe(1);
  });

  it("leaves alone the bare .supabase.co strings the libraries carry", () => {
    // supabase-js ships ".supabase.co" and ".supabase.in" without a project name, as the real
    // placeholder build does. Only an address with a project in front is a project.
    expect(problemsWithTestBuild([GOOD, `host.replace(".supabase.co",".supabase.in")`])).toEqual(
      [],
    );
  });

  it("lists every problem at once", () => {
    expect(problemsWithTestBuild([`"${PROJECT}" "${JWT}"`]).length).toBe(4);
  });
});

describe("assertTestBuild", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function exportWith(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "mp-export-"));
    made.push(dir);
    writeFileSync(join(dir, "index.html"), "<html></html>");
    for (const [path, text] of Object.entries(files)) {
      const full = join(dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
    return dir;
  }

  it("passes an export built with the placeholder values, in any bundle file", () => {
    const dist = exportWith({
      "_expo/static/js/web/entry-1.js": "console.log(1)",
      "_expo/static/js/web/__common-2.js": GOOD,
    });
    expect(() => assertTestBuild(dist)).not.toThrow();
  });

  it("stops the run on an export made with a hosted address, and says how to fix it", () => {
    const dist = exportWith({
      "_expo/static/js/web/entry-1.js": `const url="${PROJECT}",key="${JWT}";`,
    });
    expect(() => assertTestBuild(dist)).toThrow(/is not a test build/);
    expect(() => assertTestBuild(dist)).toThrow(/hosted Supabase address/);
    expect(() => assertTestBuild(dist)).toThrow(/e2e:build/);
    // It names what produced the bad export, and does not echo the key.
    expect(() => assertTestBuild(dist)).toThrow(/tauri build/);
    expect(() => assertTestBuild(dist)).not.toThrow(new RegExp(JWT));
  });

  it("stops the run when there is no export at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "mp-empty-"));
    made.push(dir);
    expect(() => assertTestBuild(dir)).toThrow(/No export at/);
  });
});

describe("the specs", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const SPECS = readdirSync(join(HERE, "..")).filter((name) => name.endsWith(".spec.ts"));

  it("finds the specs", () => {
    expect(SPECS.length).toBeGreaterThan(5);
  });

  it("all take `test` from support/test.ts, where the outside-world guard is", () => {
    // A spec that imported `test` from Playwright directly would run without the guard.
    for (const spec of SPECS) {
      const source = readFileSync(join(HERE, "..", spec), "utf8");
      expect(source, spec).not.toMatch(/import \{[^}]*\btest\b[^}]*\} from "@playwright\/test"/);
      expect(source, spec).toMatch(/from "\.\/support\/test"/);
    }
  });

  it("never name a hosted Supabase project", () => {
    for (const spec of ["fixtures/world.ts", ...SPECS, "support/fakeSupabase.ts"]) {
      const source = readFileSync(join(HERE, "..", spec), "utf8");
      // guard.spec.ts names a made-up project, on purpose, to prove it is aborted.
      if (spec === "guard.spec.ts") continue;
      expect(source, spec).not.toMatch(/https?:\/\/[a-z0-9-]+\.supabase\.(co|in|net)/i);
    }
  });
});
