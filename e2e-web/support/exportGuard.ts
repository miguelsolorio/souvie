import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Keeps the browser tests off the hosted Supabase project (WS13 fix round).
//
// The export under test must be the one built with the placeholder values (`e2e:build`). Another
// command writes to the same apps/mobile/dist with the repo's real .env.local: `tauri build` runs
// `export:web` first, and so does a plain `expo export`. Tests run against that build would send
// real requests, among them `signInWithOtp` with `shouldCreateUser: true`, to Miguel's project.
// So before any test runs, the bundle must carry the placeholder address and key, and nothing
// that looks like a hosted project or a real key.

export const FAKE_URL = "http://127.0.0.1:54321";
export const FAKE_KEY = "fake-anon-key-for-browser-tests";

/** https://<project>.supabase.co, .in or .net: a hosted project's address. */
const HOSTED_PROJECT = /https?:\/\/[a-z0-9-]+\.supabase\.(?:co|in|net)\b/i;
/** A JWT, which is what a Supabase anon or service key is (and the placeholder is not). */
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
/** The newer key formats. */
const NEW_STYLE_KEY = /sb_(?:publishable|secret)_[A-Za-z0-9_-]+/;

/** What is wrong with these bundle texts for a test build. Empty when it is a test build. */
export function problemsWithTestBuild(bundles: readonly string[]): string[] {
  const all = bundles.join("\n");
  const problems: string[] = [];
  if (!all.includes(FAKE_URL)) {
    problems.push(`the bundle does not contain the placeholder Supabase address ${FAKE_URL}`);
  }
  if (!all.includes(FAKE_KEY)) {
    problems.push(`the bundle does not contain the placeholder key ${FAKE_KEY}`);
  }
  const hosted = HOSTED_PROJECT.exec(all);
  if (hosted) problems.push(`the bundle contains a hosted Supabase address (${hosted[0]})`);
  if (JWT.test(all)) problems.push("the bundle contains a JWT, which would be a real Supabase key");
  if (NEW_STYLE_KEY.test(all))
    problems.push("the bundle contains a sb_publishable or sb_secret key");
  return problems;
}

function jsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return jsFiles(path);
    return path.endsWith(".js") ? [path] : [];
  });
}

/** Reads every JavaScript file the export ships and checks it. Throws, with how to fix it. */
export function assertTestBuild(dist: string): void {
  const how =
    "Build the export the tests need with `pnpm --filter @mp/e2e-web e2e:build` and run them again.\n" +
    "Do not run them against an export made with the repo's .env.local (tauri build and a plain\n" +
    "expo export both write one): its requests would reach the hosted Supabase project.";
  if (!existsSync(join(dist, "index.html"))) {
    throw new Error(`No export at ${dist}. ${how}`);
  }
  const bundles = jsFiles(join(dist, "_expo")).map((path) => readFileSync(path, "utf8"));
  const problems = problemsWithTestBuild(bundles);
  if (problems.length > 0) {
    throw new Error(`${dist} is not a test build:\n  - ${problems.join("\n  - ")}\n${how}`);
  }
}
