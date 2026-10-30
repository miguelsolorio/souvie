// Generates the files that come from packages/ui so nothing is maintained twice:
//   src/styles/tokens.css   from packages/ui/src/tokens.ts
//   public/*.svg            from packages/ui/assets
//
// node scripts/sync-brand.mjs           write the files
// node scripts/sync-brand.mjs --check   exit 1 if any file is out of date (CI and tests)
//
// Needs Node 22.18 or newer: it loads TypeScript source with Node's built-in type stripping.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tokensCss } from "@mp/ui/css";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const uiAssets = resolve(app, "../../packages/ui/assets");
const check = process.argv.includes("--check");

const outputs = [
  { path: resolve(app, "src/styles/tokens.css"), content: tokensCss() },
  ...["logo.svg", "logo-mark.svg", "favicon.svg"].map((name) => ({
    path: resolve(app, "public", name),
    content: readFileSync(resolve(uiAssets, name), "utf8"),
  })),
];

const stale = [];
for (const { path, content } of outputs) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (current === content) continue;
  stale.push(path);
  if (!check) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

if (check && stale.length > 0) {
  console.error("Out of date. Run `pnpm --filter @mp/marketing tokens`:");
  for (const path of stale) console.error(`  ${path}`);
  process.exit(1);
}
console.log(
  check ? "brand files are up to date" : `synced ${stale.length} of ${outputs.length} brand files`,
);
