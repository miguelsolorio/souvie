// Recorded pages and recorded model answers for the golden-set eval (WS02).
//
//   fixtures/index.json        per case: the HTTP status seen when it was recorded, and when; for
//                              a page kept with its text, the license and attribution
//   fixtures/<id>.html         the page reduced to a fixture (record.ts): facts only for a
//                              JSON-LD page (redact.ts), the slimmed page for an openly licensed
//                              one (slim.ts). Absent for a blocked or failed fetch
//   fixtures/llm/<id>.json     what Sonnet answered for a page the scrapers could not read, with a
//                              hash of the exact prompt, so a changed prompt or page text marks
//                              the recording stale instead of silently replaying an old answer
//
// `pnpm --filter @mp/recipe-import eval:live` refreshes all of it.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(HERE, "fixtures");
const LLM_DIR = join(FIXTURE_DIR, "llm");
const INDEX_FILE = join(FIXTURE_DIR, "index.json");

export interface FixtureMeta {
  /** HTTP status of the recorded fetch; 0 when the request itself failed. */
  status: number;
  /** The import failure reason when the fetch was refused or failed. */
  reason?: string;
  finalUrl?: string;
  fetchedAt: string;
  bytes?: number;
  /** `redacted`: ingredient facts and placeholder steps. `licensed`: real text under an open license. */
  kind?: "redacted" | "licensed";
  /** Which runtime fetched the page. Some sites answer Deno but refuse Node. */
  recordedWith?: "node" | "deno";
  /** Set when `kind` is `licensed`: the license name, its URL, and the credit line to keep. */
  license?: string;
  licenseUrl?: string;
  attribution?: string;
}

export interface LlmRecording {
  model: string;
  promptVersion: string;
  /** sha256 of system + "\n" + user as sent. */
  inputHash: string;
  recordedAt: string;
  /** The model's answer, as the RecipeExtractOutput schema. */
  output: unknown;
}

export function readIndex(): Record<string, FixtureMeta> {
  if (!existsSync(INDEX_FILE)) return {};
  return JSON.parse(readFileSync(INDEX_FILE, "utf8")) as Record<string, FixtureMeta>;
}

export function writeIndex(index: Record<string, FixtureMeta>): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const sorted = Object.fromEntries(Object.entries(index).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(INDEX_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
}

export function htmlPath(id: string): string {
  return join(FIXTURE_DIR, `${id}.html`);
}

export function readHtml(id: string): string | null {
  const file = htmlPath(id);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

export function writeHtml(id: string, html: string): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(htmlPath(id), html);
}

export function recordingPath(id: string): string {
  return join(LLM_DIR, `${id}.json`);
}

export function readRecording(id: string): LlmRecording | null {
  const file = recordingPath(id);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as LlmRecording) : null;
}

export function writeRecording(id: string, recording: LlmRecording): void {
  mkdirSync(LLM_DIR, { recursive: true });
  writeFileSync(recordingPath(id), `${JSON.stringify(recording, null, 2)}\n`);
}

export function inputHash(system: string, user: string): string {
  return createHash("sha256").update(`${system}\n${user}`).digest("hex");
}
