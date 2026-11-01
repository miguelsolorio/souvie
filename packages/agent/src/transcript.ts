// The run transcript (docs/03-ai-design.md §8 Audit, docs/05 §Audit): one entry per tool call,
// appended to shopping_runs.transcript, shown on the review screen.
//
// What an entry may hold is narrow on purpose. Kroger forbids storing data derived from
// searches, and a transcript lives 90 days, so entries name list lines, candidate indices, counts
// and results. They never hold a product name, an id, a UPC or a price. The one piece of model
// text an entry keeps is a search's `query` (at most 120 characters): the tool input docs/03 §8
// says the audit must show. The model's reasons stay on the run's items, which retention clears.
// The ledger, not the transcript, is the source of truth for recovery.
import type { TranscriptEntry } from "./types.ts";

/** Where entries go. The worker appends them to the run row; tests keep them in memory. */
export interface TranscriptSink {
  append(entries: readonly TranscriptEntry[]): Promise<void>;
}

/** Most entries one run keeps. A run past it records one note and drops the rest. */
export const MAX_TRANSCRIPT_ENTRIES = 600;

/** Input keys an entry may carry, all of them about the household's own list or our counters. */
const INPUT_KEYS = new Set([
  "listItemId",
  "query",
  "limit",
  "candidateIndex",
  "quantity",
  "runItemId",
  "zip",
  "slotIndex",
  "count",
  "delta",
]);

function shortValue(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, 120);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.length;
  return undefined;
}

/** Keeps only the allowed keys of a tool input, with short values. */
export function redactInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!INPUT_KEYS.has(key)) continue;
    const short = shortValue(value);
    if (short !== undefined) out[key] = short;
  }
  return out;
}

export class Transcript {
  readonly #entries: TranscriptEntry[] = [];
  #flushed = 0;
  #truncated = false;
  readonly #sink: TranscriptSink | null;
  readonly #now: () => number;

  constructor(sink: TranscriptSink | null = null, now: () => number = Date.now) {
    this.#sink = sink;
    this.#now = now;
  }

  /** Records one tool call. Returns the entry as stored. */
  record(
    entry: Omit<TranscriptEntry, "ts" | "input"> & { input: unknown },
  ): TranscriptEntry | null {
    if (this.#entries.length >= MAX_TRANSCRIPT_ENTRIES) {
      if (!this.#truncated) {
        this.#truncated = true;
        this.#entries.push({
          ts: new Date(this.#now()).toISOString(),
          tool: "transcript",
          by: "host",
          input: {},
          output_summary: `Transcript limit of ${MAX_TRANSCRIPT_ENTRIES} entries reached; later calls are not listed.`,
          ok: true,
        });
      }
      return null;
    }
    const stored: TranscriptEntry = {
      ts: new Date(this.#now()).toISOString(),
      tool: entry.tool,
      by: entry.by,
      input: redactInput(entry.input),
      output_summary: entry.output_summary.slice(0, 300),
      ok: entry.ok,
      ...(entry.screenshot_path ? { screenshot_path: entry.screenshot_path } : {}),
    };
    this.#entries.push(stored);
    return stored;
  }

  /** Every entry recorded in this process, oldest first. */
  entries(): TranscriptEntry[] {
    return [...this.#entries];
  }

  /** Entries for one tool. */
  calls(tool: string): TranscriptEntry[] {
    return this.#entries.filter((entry) => entry.tool === tool);
  }

  /** Sends what the sink has not seen yet. Safe to call often. */
  async flush(): Promise<void> {
    if (!this.#sink || this.#flushed >= this.#entries.length) return;
    const pending = this.#entries.slice(this.#flushed);
    await this.#sink.append(pending);
    this.#flushed += pending.length;
  }
}
