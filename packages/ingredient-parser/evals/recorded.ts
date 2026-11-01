// Recorded Haiku answers for the parser eval (WS15). The deterministic path (grammar and lookup)
// carries 478 of the 500 golden lines; the rest go to Haiku, in batches of 20. This client stands
// in for the model: offline it replays what Haiku answered when the set was last recorded, and
// with EVAL_LIVE=1 it calls Haiku and writes the answers down.
//
//   recordings/<hash>.json   one model call: the lines sent, what came back, and the usage
//
// The file name is a hash of the model, the prompt version, the system prompt and the user message,
// so a prompt change or a different batch finds no recording and says so, instead of replaying an
// answer to a different question. CI sets EVAL_REQUIRE_RECORDINGS=1: a missing recording fails the
// run there. Re-record with `EVAL_LIVE=1 pnpm eval --suite parser --live` and commit the files.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSystemPrompt,
  buildUserPrompt,
  type LlmBatchResult,
  type LlmItem,
  type LlmParseClient,
  type LlmUsage,
} from "../src/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RECORDINGS_DIR = join(HERE, "recordings");

export interface Recording {
  model: string;
  promptVersion: string;
  recordedAt: string;
  lines: string[];
  /** [input index, items] for every line the model answered. */
  answers: Array<[number, LlmItem[]]>;
  usage: LlmUsage;
}

export class MissingRecordingError extends Error {
  readonly code = "missing_recording";
  constructor(readonly hash: string) {
    super(`no recorded Haiku answer for this batch (${hash}); re-record with EVAL_LIVE=1`);
    this.name = "MissingRecordingError";
  }
}

/** The recording's key: the model, the prompt version and the exact prompt text for these lines. */
export function recordingHash(
  model: string,
  promptVersion: string,
  lines: readonly string[],
): string {
  const input = JSON.stringify([model, promptVersion, buildSystemPrompt(), buildUserPrompt(lines)]);
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export interface RecordedClientOptions {
  /** The real client, to call and record. Absent: replay only. */
  live?: LlmParseClient | undefined;
  dir?: string;
  now?: () => Date;
}

export interface RecordedClient extends LlmParseClient {
  /** Hashes of batches that had no recording, in the order they were asked for. */
  readonly missing: string[];
  /** Model calls served, from a recording or live. */
  readonly calls: number;
  /** Recordings written by this run. */
  readonly written: string[];
}

/**
 * A parser model client over the recordings. `model` and `promptVersion` come from `base`, so the
 * parser's cache and the hashes agree with the real client's.
 */
export function createRecordedClient(
  base: Pick<LlmParseClient, "model" | "promptVersion">,
  options: RecordedClientOptions = {},
): RecordedClient {
  const dir = options.dir ?? RECORDINGS_DIR;
  const now = options.now ?? (() => new Date());
  const missing: string[] = [];
  const written: string[] = [];
  let calls = 0;

  const client: RecordedClient = {
    model: base.model,
    promptVersion: base.promptVersion,
    missing,
    written,
    get calls() {
      return calls;
    },
    async parseBatch(lines): Promise<LlmBatchResult> {
      const hash = recordingHash(base.model, base.promptVersion, lines);
      const file = join(dir, `${hash}.json`);

      if (options.live) {
        const result = await options.live.parseBatch(lines);
        calls += 1;
        const recording: Recording = {
          model: base.model,
          promptVersion: base.promptVersion,
          recordedAt: now().toISOString(),
          lines: [...lines],
          answers: [...result.byIndex].map(([index, items]) => [index, [...items]]),
          usage: result.usage,
        };
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, `${JSON.stringify(recording, null, 2)}\n`);
        written.push(hash);
        return result;
      }

      if (!existsSync(file)) {
        missing.push(hash);
        throw new MissingRecordingError(hash);
      }
      const recording = JSON.parse(readFileSync(file, "utf8")) as Recording;
      calls += 1;
      return {
        byIndex: new Map(recording.answers),
        // Replayed calls cost nothing: the usage is the recorded call's, for the record only.
        usage: recording.usage,
      };
    },
  };
  return client;
}
