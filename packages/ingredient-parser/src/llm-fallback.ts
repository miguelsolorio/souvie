// Model fallback stage (WS03): lines the grammar and lookup are unsure about go to Haiku in
// batches, with a strict schema. This file defines the client interface the pipeline depends on
// (`LlmParseClient`) and the production implementation behind it. WS02 moved the prompt and the
// output schema into the `@mp/llm` registry (ingredient-parse.v1) and put the Anthropic call
// behind `extract`, so retries, logging, and the model id live in one place.
//
// What this file still owns: the batch shape, `sanitizeItem` (the pipeline calls it on every
// model item, whichever client produced it), and the mapping from `@mp/llm` errors to
// `LlmParseError` with the usage of the calls that were billed.

import { normalizeUnit } from "@mp/core";
import {
  type AiRunRecord,
  createAnthropicClient,
  extract,
  INGREDIENT_PARSE_V1,
  IngredientParseItem,
  IngredientParseOutput,
  LlmError,
  type MessagesClient,
  MODELS,
  estimateCostUsd as priceCall,
} from "@mp/llm";

export const HAIKU_MODEL = MODELS.haiku;
/** Lines per model call (docs/03-ai-design.md §5). */
export const LLM_BATCH_SIZE = 20;

/** The registry id, "ingredient-parse.v1". It is what the parse cache records. */
export const INGREDIENT_PARSE_PROMPT_VERSION = INGREDIENT_PARSE_V1.id;
export const buildSystemPrompt = (): string => INGREDIENT_PARSE_V1.system();
export const buildUserPrompt = (lines: readonly string[]): string =>
  INGREDIENT_PARSE_V1.user({ lines });

export const LlmItemSchema = IngredientParseItem;
export type LlmItem = IngredientParseItem;

export const LlmBatchSchema = IngredientParseOutput;
export type LlmBatch = IngredientParseOutput;

export interface LlmUsage {
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  latencyMs: number;
  ok: boolean;
  error?: string;
  /** Lines in the call. */
  lines: number;
}

export interface LlmBatchResult {
  /** Items by input index. A missing index means the model skipped that line. */
  byIndex: ReadonlyMap<number, readonly LlmItem[]>;
  usage: LlmUsage;
}

export interface LlmParseClient {
  readonly model: string;
  readonly promptVersion: string;
  /** Parse up to LLM_BATCH_SIZE lines. Throws LlmParseError on failure. */
  parseBatch(lines: readonly string[]): Promise<LlmBatchResult>;
}

export type LlmParseErrorCode = "refusal" | "truncated" | "invalid" | "api";

export class LlmParseError extends Error {
  readonly code: LlmParseErrorCode;
  readonly usage?: LlmUsage;
  constructor(code: LlmParseErrorCode, message: string, usage?: LlmUsage) {
    super(message);
    this.name = "LlmParseError";
    this.code = code;
    this.usage = usage;
  }
}

/** Cost of one call at Haiku 5.5 list rates, for the `ai_runs` row. */
export function estimateCostUsd(
  usage: Pick<LlmUsage, "inputTokens" | "outputTokens" | "cacheReadTokens">,
): number {
  return priceCall(HAIKU_MODEL, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
  });
}

/** Clamp and normalize one model item so the rest of the pipeline can trust it. */
export function sanitizeItem(item: LlmItem): LlmItem {
  const unit = item.qty == null ? null : normalizeUnit(item.unit);
  const qty = item.qty != null && Number.isFinite(item.qty) && item.qty >= 0 ? item.qty : null;
  const qtyMax =
    qty != null && item.qty_max != null && Number.isFinite(item.qty_max) && item.qty_max > qty
      ? item.qty_max
      : null;
  const name = item.ingredient?.toLowerCase().replace(/\s+/g, " ").trim() || null;
  return {
    qty,
    qty_max: qtyMax,
    unit: qty == null ? null : (unit ?? "each"),
    ingredient: name,
    category: item.category,
    prep: item.prep?.trim() || null,
    optional: item.optional,
    confidence: Math.min(1, Math.max(0, Number.isFinite(item.confidence) ? item.confidence : 0)),
  };
}

// ---------------------------------------------------------------------------
// Anthropic implementation, over @mp/llm's extract
// ---------------------------------------------------------------------------

/** The slice of the SDK the client needs. The same type `@mp/llm` calls its own. */
export type MessagesParseLike = MessagesClient;

export interface AnthropicParseClientOptions {
  /** Defaults to ANTHROPIC_API_KEY from the environment. */
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  /** Inject a client (tests). */
  client?: MessagesParseLike;
  /** Clock for latency, injectable for tests. */
  now?: () => number;
}

function envApiKey(): string | undefined {
  const g = globalThis as {
    process?: { env?: Record<string, string | undefined> };
    Deno?: { env: { get(name: string): string | undefined } };
  };
  try {
    return g.process?.env?.ANTHROPIC_API_KEY ?? g.Deno?.env.get("ANTHROPIC_API_KEY");
  } catch {
    return undefined;
  }
}

const CODE_MAP: Record<string, LlmParseErrorCode> = {
  refusal: "refusal",
  truncated: "truncated",
  invalid: "invalid",
};

export function createAnthropicParseClient(
  options: AnthropicParseClientOptions = {},
): LlmParseClient {
  const model = options.model ?? HAIKU_MODEL;
  const maxTokens = options.maxTokens ?? 4096;
  const now = options.now ?? (() => Date.now());
  const promptVersion = INGREDIENT_PARSE_V1.id;

  return {
    model,
    promptVersion,
    async parseBatch(lines) {
      const started = now();
      // One record per model call, retries and failures included: all of them were billed.
      const calls: AiRunRecord[] = [];
      const usageOf = (ok: boolean, error?: string): LlmUsage => ({
        model,
        promptVersion,
        inputTokens: calls.reduce((sum, c) => sum + c.inputTokens, 0),
        outputTokens: calls.reduce((sum, c) => sum + c.outputTokens, 0),
        cacheReadTokens: calls.reduce((sum, c) => sum + c.cacheReadTokens, 0),
        latencyMs: now() - started,
        ok,
        ...(error !== undefined ? { error } : {}),
        lines: lines.length,
      });

      let value: IngredientParseOutput;
      try {
        const client =
          options.client ??
          (await createAnthropicClient({ apiKey: options.apiKey ?? envApiKey() }));
        const result = await extract(
          IngredientParseOutput,
          {
            system: INGREDIENT_PARSE_V1.system(),
            user: INGREDIENT_PARSE_V1.user({ lines }),
            model,
            maxTokens,
            // Parsing is extraction, not reasoning.
            effort: "low",
            kind: INGREDIENT_PARSE_V1.kind,
            promptVersion,
          },
          { client, log: (record) => void calls.push(record) },
        );
        value = result.value;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof LlmError ? (CODE_MAP[err.code] ?? "api") : "api";
        throw new LlmParseError(code, message, usageOf(false, message));
      }

      const byIndex = new Map<number, LlmItem[]>();
      for (const line of value.lines) {
        if (line.index >= 0 && line.index < lines.length && !byIndex.has(line.index)) {
          byIndex.set(line.index, line.items.map(sanitizeItem));
        }
      }
      return { byIndex, usage: usageOf(true) };
    },
  };
}
