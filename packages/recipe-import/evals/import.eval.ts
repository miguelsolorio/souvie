// Golden-set eval for recipe import (WS02). docs/03-ai-design.md §10: 50 recipe URLs, at least 45
// must import with the right title, an ingredient count within one, and at least one step.
//
//   pnpm --filter @mp/recipe-import eval        offline: recorded pages through importFromHtml
//   pnpm --filter @mp/recipe-import eval:live   re-fetch every URL, refresh the fixtures, and (with
//                                               ANTHROPIC_API_KEY) re-run and re-record Sonnet
//
// Offline, the model path replays recorded answers (fixtures/llm). A page that needs the Sonnet
// fallback and has no recording shows as PEND, not PASS. The gate (`gate` in score.ts):
//   * any FAIL turns the run red while a case is pending, so pending cannot hide a regression
//   * once nothing is pending, the run needs 45 real passes
//   * EVAL_REQUIRE_RECORDINGS=1 counts a pending case as a failure (CI sets it once the
//     recordings are committed)
//
// Also proven here, offline, with a mocked fetch: video platform links and captions never make a
// network request (R11, acceptance criterion 7).

import { readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAnthropicClient,
  extract,
  RECIPE_EXTRACT_V1,
  type RecipeExtractOutput,
} from "@mp/llm";
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { recordScore } from "../../evals-report/src/record.ts";
import {
  type ImportResult,
  importFromCaption,
  importFromHtml,
  importFromUrl,
  type ModelExtract,
  readableText,
} from "../src/index.ts";
import {
  type FixtureMeta,
  inputHash,
  readHtml,
  readIndex,
  readRecording,
  writeHtml,
  writeIndex,
  writeRecording,
} from "./fixtures.ts";
import { recordCase } from "./record.ts";
import {
  type Case,
  domainOf,
  formatLine,
  gate,
  type Outcome,
  pageTextCarriesRecipe,
  scoreRecipe,
  summarize,
} from "./score.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE = process.env.EVAL_LIVE === "1";
/**
 * ANTHROPIC_API_KEY from the environment, else from the repo root .env.local (gitignored). Only
 * that one key is read, and its value is never printed.
 */
function readApiKey(): string | undefined {
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const file = readFileSync(join(HERE, "../../../.env.local"), "utf8");
    const line = file.split(/\r?\n/).find((l) => /^ANTHROPIC_API_KEY=/.test(l));
    const value = line
      ?.slice("ANTHROPIC_API_KEY=".length)
      .replace(/\s+#.*$/, "")
      .trim()
      .replace(/^["']|["']$/g, "");
    return value || undefined;
  } catch {
    return undefined;
  }
}
const API_KEY = LIVE ? readApiKey() : undefined;
const THRESHOLD = 45;
/** CI sets this once the Sonnet recordings are committed: a pending case is then a failure. */
const REQUIRE_RECORDINGS = process.env.EVAL_REQUIRE_RECORDINGS === "1";
const MIN_DOMAINS = 20;
const MIN_MODEL_CASES = 5;

const cases = (JSON.parse(readFileSync(join(HERE, "urls.json"), "utf8")) as { cases: Case[] })
  .cases;

/** Straight to stdout, so the report shows under any Vitest reporter. */
function emit(text: string): void {
  writeSync(1, `${text}\n`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------
// The model path: replay a recording offline, or call Sonnet live and record the answer
// ---------------------------------------------------------------------------------------

function replayFor(id: string): ModelExtract | undefined {
  const recording = readRecording(id);
  if (!recording) return undefined;
  return async (schema, request) => {
    const current = inputHash(request.system, request.user);
    if (recording.inputHash !== current || recording.promptVersion !== RECIPE_EXTRACT_V1.id) {
      throw Object.assign(new Error("stale recording"), { code: "stale_recording" });
    }
    return {
      value: schema.parse(recording.output),
      model: recording.model,
      attempts: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
    };
  };
}

let liveClient: Awaited<ReturnType<typeof createAnthropicClient>> | undefined;

function recordingFor(id: string): ModelExtract {
  return async (schema, request) => {
    liveClient ??= await createAnthropicClient({ apiKey: API_KEY });
    const result = await extract(schema, request, { client: liveClient });
    writeRecording(id, {
      model: result.model,
      promptVersion: request.promptVersion ?? RECIPE_EXTRACT_V1.id,
      inputHash: inputHash(request.system, request.user),
      recordedAt: new Date().toISOString(),
      output: result.value as RecipeExtractOutput,
    });
    return result;
  };
}

// ---------------------------------------------------------------------------------------
// One case
// ---------------------------------------------------------------------------------------

/**
 * Live: fetch the page, reduce it to a fixture, and store it (record.ts). A JSON-LD page is
 * redacted to facts. A page with no recipe data is kept only under the open license its case
 * names. A case marked `recorder: "deno"` is not refetched here, because its site refuses Node's
 * fetch: `record-deno.ts` records it.
 */
async function refreshFixture(c: Case, index: Record<string, FixtureMeta>): Promise<string | null> {
  if (c.recorder === "deno") return readHtml(c.id);
  const { html, meta } = await recordCase(c, "node");
  index[c.id] = meta;
  if (html !== null) writeHtml(c.id, html);
  return html;
}

function fixtureFor(
  c: Case,
  index: Record<string, FixtureMeta>,
): { html: string | null; meta: FixtureMeta | undefined } {
  return { html: readHtml(c.id), meta: index[c.id] };
}

async function evaluate(c: Case, index: Record<string, FixtureMeta>): Promise<Outcome> {
  const domain = domainOf(c.url);
  let html: string | null;
  if (LIVE) {
    html = await refreshFixture(c, index);
    await sleep(800);
  } else {
    html = fixtureFor(c, index).html;
  }
  const meta = index[c.id];

  if (html === null) {
    const status = meta?.status ?? 0;
    const blocked =
      meta?.reason === "blocked" || status === 403 || status === 401 || status === 429;
    return blocked
      ? { id: c.id, domain, path: "blocked", status: "FAIL", detail: String(status) }
      : {
          id: c.id,
          domain,
          path: "failed",
          status: "FAIL",
          detail: meta ? `fetch failed: ${meta.reason ?? status}` : "no fixture recorded",
        };
  }

  const useLiveModel = LIVE && Boolean(API_KEY);
  const extractFn = useLiveModel ? recordingFor(c.id) : replayFor(c.id);
  const result: ImportResult = await importFromHtml(html, meta?.finalUrl ?? c.url, {
    ...(extractFn ? { extract: extractFn } : {}),
  });

  if (!result.ok) {
    if (result.reason === "model_unavailable") {
      // No model answer to score. Check the model's input instead: the page text must carry the
      // recipe, or no model could read it.
      const text = readableText(cheerio.load(html));
      if (!pageTextCarriesRecipe(text, c.expect)) {
        return {
          id: c.id,
          domain,
          path: "failed",
          status: "FAIL",
          detail: "the readable page text does not carry the recipe",
        };
      }
      return {
        id: c.id,
        domain,
        path: "llm",
        status: "PEND",
        detail: `page text carries the recipe (${text.length} chars); needs a Sonnet answer: set ANTHROPIC_API_KEY and run eval:live`,
      };
    }
    if (result.reason === "model_failed" && !useLiveModel && readRecording(c.id)) {
      return {
        id: c.id,
        domain,
        path: "llm",
        status: "PEND",
        detail: "recording is stale (prompt or page text changed): run eval:live to re-record",
      };
    }
    return result.reason === "blocked"
      ? { id: c.id, domain, path: "blocked", status: "FAIL", detail: result.message }
      : {
          id: c.id,
          domain,
          path: "failed",
          status: "FAIL",
          detail: `${result.reason}: ${result.message}`,
        };
  }

  const score = scoreRecipe(result.recipe, c.expect);
  const pathOk =
    c.expectPath === result.path || (c.expectPath === "jsonld" && result.path === "scraper");
  const detail = pathOk
    ? score.detail
    : `${score.detail}; read by ${result.path}, expected ${c.expectPath}`;
  return {
    id: c.id,
    domain,
    path: result.path as "jsonld" | "scraper" | "llm",
    status: score.pass && pathOk ? "PASS" : "FAIL",
    detail,
  };
}

// ---------------------------------------------------------------------------------------
// The eval
// ---------------------------------------------------------------------------------------

describe(`recipe import golden set (${LIVE ? "live" : "offline"})`, () => {
  const outcomes: Outcome[] = [];
  const index = readIndex();

  it("lists 50 cases across at least 20 domains, with at least 5 that need the model", () => {
    expect(cases).toHaveLength(50);
    expect(new Set(cases.map((c) => domainOf(c.url))).size).toBeGreaterThanOrEqual(MIN_DOMAINS);
    expect(cases.filter((c) => c.expectPath === "llm").length).toBeGreaterThanOrEqual(
      MIN_MODEL_CASES,
    );
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  for (const c of cases) {
    it(`imports ${c.id}`, { timeout: LIVE ? 90_000 : 30_000 }, async () => {
      outcomes.push(await evaluate(c, index));
    });
  }

  it("reports the table and meets the threshold", () => {
    if (LIVE) writeIndex(index);

    emit("");
    emit(
      `Recipe import golden set (${LIVE ? "live: pages re-fetched" : "offline: recorded pages"})`,
    );
    for (const outcome of outcomes) emit(formatLine(outcome));
    const summary = summarize(outcomes);
    emit(summary.line);
    // WS15: the score `pnpm eval` compares with the baseline (pending cases are not passes).
    recordScore({
      suite: "import",
      metric: "pass_rate",
      value: (summary.pass / Math.max(summary.total, 1)) * 100,
      passed: summary.pass,
      total: summary.total,
      threshold: (THRESHOLD / Math.max(cases.length, 1)) * 100,
    });
    if (summary.pending > 0) {
      emit(
        `NOTE ${summary.pending} case(s) need a recorded Sonnet answer and are not counted as passes. ` +
          `With them, at most ${summary.pass + summary.pending}/${summary.total} could pass (threshold ${THRESHOLD}). ` +
          "Run eval:live with ANTHROPIC_API_KEY to record them.",
      );
      emit(
        REQUIRE_RECORDINGS
          ? "GATE EVAL_REQUIRE_RECORDINGS=1: pending cases count as failures, so this run is red."
          : "GATE pending cases do not cover for failures: any FAIL turns this run red. Set EVAL_REQUIRE_RECORDINGS=1 to count pending cases as failures.",
      );
    }
    emit("");

    expect(outcomes).toHaveLength(cases.length);
    // A pending case never covers for a failure, and the threshold applies to real passes
    // (the rule is `gate` in score.ts, tested in score.test.ts).
    const verdict = gate(outcomes, { threshold: THRESHOLD, requireRecordings: REQUIRE_RECORDINGS });
    expect(verdict.problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// R11: no request to a video platform, and captions never fetch (offline, mocked fetch)
// ---------------------------------------------------------------------------------------

describe("video platforms and captions never reach the network", () => {
  const VIDEO_URLS = [
    "https://www.instagram.com/reel/Cxyz123/",
    "https://www.tiktok.com/@cook/video/7123456789",
    "https://vm.tiktok.com/ZMabc/",
    "https://www.youtube.com/watch?v=abc123",
    "https://youtu.be/abc123",
    "https://m.youtube.com/shorts/abc123",
  ];

  it("refuses video links before any fetch", async () => {
    let calls = 0;
    const mockFetch = (async () => {
      calls++;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    for (const url of VIDEO_URLS) {
      const result = await importFromUrl(url, { fetch: mockFetch });
      expect(result, url).toMatchObject({ ok: false, reason: "video_platform" });
    }
    expect(calls).toBe(0);
  });

  it("imports a caption without a single fetch, even when it names a video link", async () => {
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    try {
      const noModel = await importFromCaption(
        "Easy pasta\n1 lb spaghetti\n2 cloves garlic\nhttps://www.tiktok.com/@a/video/1",
        {},
        {
          sourceUrl: "https://www.tiktok.com/@a/video/1",
        },
      );
      expect(noModel).toMatchObject({ ok: false, reason: "model_unavailable" });
      const notEnough = await importFromCaption("so good!! #foodtok", {});
      expect(notEnough).toMatchObject({ ok: false, reason: "not_enough_text" });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toBe(0);
  });
});
