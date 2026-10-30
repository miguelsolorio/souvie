// Records golden-set cases with Deno's fetch (WS02).
//
// Some sites answer Deno and refuse Node (allrecipes.com and seriouseats.com did on 2026-10-30,
// probably on the TLS fingerprint). `eval:live` runs on Node, so it leaves the cases marked
// `"recorder": "deno"` in urls.json alone, and this script records them. It runs the same
// `recordCase` (redaction included), so the fixture is the same kind of file.
//
//   deno run -A --config supabase/functions/recipe-import/deno.json \
//     packages/recipe-import/evals/record-deno.ts [case-id ...]
//
// With no ids it records every case marked `"recorder": "deno"`. The Supabase Edge runtime is
// Deno, so this is also the closest local check of how production sees those sites.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readIndex, writeHtml, writeIndex } from "./fixtures.ts";
import { recordCase } from "./record.ts";
import type { Case } from "./score.ts";

const urlsFile = fileURLToPath(new URL("./urls.json", import.meta.url));
const cases = (JSON.parse(readFileSync(urlsFile, "utf8")) as { cases: Case[] }).cases;

// `process` is Node's global, which Deno also provides, so the script type-checks as part of the
// package.
const wanted = process.argv.slice(2);
const selected =
  wanted.length > 0
    ? cases.filter((c) => wanted.includes(c.id))
    : cases.filter((c) => c.recorder === "deno");
const unknown = wanted.filter((id) => !cases.some((c) => c.id === id));
if (unknown.length > 0) {
  console.error(`unknown case id: ${unknown.join(", ")}`);
  process.exit(2);
}

const index = readIndex();
let failed = 0;
for (const c of selected) {
  try {
    const { html, meta } = await recordCase(c, "deno");
    index[c.id] = meta;
    if (html === null) {
      failed++;
      console.log(`FAIL ${c.id}: ${meta.reason ?? "fetch failed"} (HTTP ${meta.status})`);
      continue;
    }
    writeHtml(c.id, html);
    console.log(`ok   ${c.id}: ${meta.kind}, ${html.length} bytes, HTTP ${meta.status}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 800));
}
writeIndex(index);
console.log(`${selected.length - failed}/${selected.length} recorded`);
process.exit(failed > 0 ? 1 : 0);
