// The recorded Haiku client (WS15): what it keys on, what it writes, and how it fails when a
// recording is missing.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmBatchResult, LlmItem, LlmParseClient } from "../src/index.ts";
import {
  createRecordedClient,
  MissingRecordingError,
  RECORDINGS_DIR,
  recordingHash,
} from "./recorded.ts";

const BASE = { model: "claude-haiku-5-5", promptVersion: "ingredient-parse.v1" };
const ITEM: LlmItem = {
  qty: 1,
  qty_max: null,
  unit: "tbsp",
  ingredient: "gochugaru",
  category: "international",
  prep: null,
  optional: false,
  confidence: 0.9,
};

function liveClient(): LlmParseClient & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    ...BASE,
    calls,
    async parseBatch(lines): Promise<LlmBatchResult> {
      calls.push([...lines]);
      return {
        byIndex: new Map(lines.map((_line, i) => [i, [ITEM]] as [number, LlmItem[]])),
        usage: {
          ...BASE,
          inputTokens: 100,
          outputTokens: 30,
          cacheReadTokens: 0,
          latencyMs: 12,
          ok: true,
          lines: lines.length,
        },
      };
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "parser-recordings-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("recordingHash", () => {
  it("is stable, and changes with the lines, the model and the prompt version", () => {
    const a = recordingHash(BASE.model, BASE.promptVersion, ["1 tbsp gochugaru"]);
    expect(recordingHash(BASE.model, BASE.promptVersion, ["1 tbsp gochugaru"])).toBe(a);
    expect(recordingHash(BASE.model, BASE.promptVersion, ["2 tbsp gochugaru"])).not.toBe(a);
    expect(recordingHash("claude-sonnet-5-5", BASE.promptVersion, ["1 tbsp gochugaru"])).not.toBe(
      a,
    );
    expect(recordingHash(BASE.model, "ingredient-parse.v2", ["1 tbsp gochugaru"])).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("the recorded client", () => {
  it("records what the live client answers and replays it with no live client", async () => {
    const live = liveClient();
    const recorder = createRecordedClient(BASE, {
      live,
      dir,
      now: () => new Date("2026-10-31T12:00:00Z"),
    });
    const lines = ["1 tbsp gochugaru", "2 links lap cheong"];
    const first = await recorder.parseBatch(lines);
    expect(live.calls).toEqual([lines]);
    expect(recorder.written).toHaveLength(1);
    const files = readdirSync(dir);
    expect(files).toEqual([`${recordingHash(BASE.model, BASE.promptVersion, lines)}.json`]);
    const saved = JSON.parse(readFileSync(join(dir, files[0] as string), "utf8"));
    expect(saved).toMatchObject({
      model: BASE.model,
      promptVersion: BASE.promptVersion,
      recordedAt: "2026-10-31T12:00:00.000Z",
      lines,
    });

    const replayer = createRecordedClient(BASE, { dir });
    const again = await replayer.parseBatch(lines);
    expect([...again.byIndex]).toEqual([...first.byIndex]);
    expect(replayer.calls).toBe(1);
    expect(replayer.missing).toEqual([]);
  });

  it("throws a missing-recording error for a batch nobody recorded, and remembers which", async () => {
    const replayer = createRecordedClient(BASE, { dir });
    await expect(replayer.parseBatch(["1 cup crema"])).rejects.toBeInstanceOf(
      MissingRecordingError,
    );
    await expect(replayer.parseBatch(["1 cup crema"])).rejects.toMatchObject({
      code: "missing_recording",
    });
    expect(replayer.missing).toEqual([
      recordingHash(BASE.model, BASE.promptVersion, ["1 cup crema"]),
      recordingHash(BASE.model, BASE.promptVersion, ["1 cup crema"]),
    ]);
    expect(replayer.calls).toBe(0);
  });

  it("the committed recordings cover the golden set's batches (2 files, valid shape)", () => {
    const files = readdirSync(RECORDINGS_DIR).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    for (const file of files) {
      const recording = JSON.parse(readFileSync(join(RECORDINGS_DIR, file), "utf8"));
      expect(recording.model).toBe("claude-haiku-5-5");
      expect(recording.lines.length).toBeGreaterThan(0);
      expect(
        recordingHash(recording.model, recording.promptVersion, recording.lines),
        `${file} was recorded for a prompt that is no longer the current one`,
      ).toBe(file.replace(/\.json$/, ""));
    }
  });
});
