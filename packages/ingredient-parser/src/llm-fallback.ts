// Model fallback stage (WS03): lines the grammar and lookup are unsure about go to Haiku in
// batches, with a strict schema. This file defines the client interface the pipeline depends on
// and a minimal Anthropic implementation behind it. When WS02 lands `@mp/llm`'s `extract`, swap
// the factory for an adapter over it; nothing else changes.

import { INGREDIENT_CATEGORIES, normalizeUnit } from "@mp/core";
import { z } from "zod";
import { buildSystemPrompt, buildUserPrompt, INGREDIENT_PARSE_PROMPT_VERSION } from "./prompt.ts";

export const HAIKU_MODEL = "claude-haiku-5-5";
/** Lines per model call (docs/03-ai-design.md §5). */
export const LLM_BATCH_SIZE = 20;

export const LlmItemSchema = z.object({
  qty: z.number().nullable(),
  qty_max: z.number().nullable(),
  unit: z.string().nullable(),
  ingredient: z.string().nullable(),
  category: z.enum(INGREDIENT_CATEGORIES).nullable(),
  prep: z.string().nullable(),
  optional: z.boolean(),
  confidence: z.number(),
});
export type LlmItem = z.infer<typeof LlmItemSchema>;

export const LlmBatchSchema = z.object({
  lines: z.array(z.object({ index: z.number().int(), items: z.array(LlmItemSchema) })),
});
export type LlmBatch = z.infer<typeof LlmBatchSchema>;

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

// Haiku 5.5 list prices, USD per million tokens (docs/03-ai-design.md §1). Cache reads are 0.1x input.
const INPUT_USD_PER_MTOK = 0.1;
const OUTPUT_USD_PER_MTOK = 0.5;
const CACHE_READ_FACTOR = 0.1;

/** Cost of one call, for the `ai_runs` row. */
export function estimateCostUsd(
  usage: Pick<LlmUsage, "inputTokens" | "outputTokens" | "cacheReadTokens">,
): number {
  const cost =
    (usage.inputTokens * INPUT_USD_PER_MTOK +
      usage.cacheReadTokens * INPUT_USD_PER_MTOK * CACHE_READ_FACTOR +
      usage.outputTokens * OUTPUT_USD_PER_MTOK) /
    1_000_000;
  return Math.round(cost * 1e8) / 1e8;
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
// Anthropic implementation
// ---------------------------------------------------------------------------

/** The slice of the SDK this file uses, so tests can pass a fake. */
export interface MessagesParseLike {
  messages: {
    parse(params: Record<string, unknown>): Promise<{
      parsed_output: unknown;
      stop_reason: string | null;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number | null;
      };
    }>;
  };
}

export interface AnthropicParseClientOptions {
  /** Defaults to ANTHROPIC_API_KEY from the environment when the SDK is created lazily. */
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  /** Inject a client (tests). */
  client?: MessagesParseLike;
  /** Clock for latency, injectable for tests. */
  now?: () => number;
}

export function createAnthropicParseClient(
  options: AnthropicParseClientOptions = {},
): LlmParseClient {
  const model = options.model ?? HAIKU_MODEL;
  const maxTokens = options.maxTokens ?? 4096;
  const now = options.now ?? (() => Date.now());
  let sdk: MessagesParseLike | undefined = options.client;
  let formatFor: (() => unknown) | undefined;

  async function ensure(): Promise<{ client: MessagesParseLike; format: unknown }> {
    if (!sdk || !formatFor) {
      const [{ default: Anthropic }, { zodOutputFormat }] = await Promise.all([
        import("@anthropic-ai/sdk"),
        import("@anthropic-ai/sdk/helpers/zod"),
      ]);
      if (!sdk) {
        sdk = new Anthropic(
          options.apiKey ? { apiKey: options.apiKey } : {},
        ) as unknown as MessagesParseLike;
      }
      formatFor = () => zodOutputFormat(LlmBatchSchema);
    }
    return { client: sdk, format: formatFor() };
  }

  return {
    model,
    promptVersion: INGREDIENT_PARSE_PROMPT_VERSION,
    async parseBatch(lines) {
      const started = now();
      const base: Omit<
        LlmUsage,
        "ok" | "error" | "inputTokens" | "outputTokens" | "cacheReadTokens"
      > = {
        model,
        promptVersion: INGREDIENT_PARSE_PROMPT_VERSION,
        latencyMs: 0,
        lines: lines.length,
      };
      const fail = (
        code: LlmParseErrorCode,
        message: string,
        tokens?: [number, number, number],
      ) => {
        const usage: LlmUsage = {
          ...base,
          latencyMs: now() - started,
          inputTokens: tokens?.[0] ?? 0,
          outputTokens: tokens?.[1] ?? 0,
          cacheReadTokens: tokens?.[2] ?? 0,
          ok: false,
          error: message,
        };
        return new LlmParseError(code, message, usage);
      };

      let response: Awaited<ReturnType<MessagesParseLike["messages"]["parse"]>>;
      try {
        const { client, format } = await ensure();
        response = await client.messages.parse({
          model,
          max_tokens: maxTokens,
          system: [
            { type: "text", text: buildSystemPrompt(), cache_control: { type: "ephemeral" } },
          ],
          messages: [{ role: "user", content: buildUserPrompt(lines) }],
          // Low effort: this is extraction, not reasoning. Haiku 5.5 rejects sampling parameters.
          output_config: { effort: "low", format },
        });
      } catch (err) {
        throw fail("api", err instanceof Error ? err.message : String(err));
      }

      const tokens: [number, number, number] = [
        response.usage.input_tokens,
        response.usage.output_tokens,
        response.usage.cache_read_input_tokens ?? 0,
      ];
      if (response.stop_reason === "refusal")
        throw fail("refusal", "model refused the request", tokens);
      if (response.stop_reason === "max_tokens")
        throw fail("truncated", "response hit max_tokens", tokens);

      const parsed = LlmBatchSchema.safeParse(response.parsed_output);
      if (!parsed.success)
        throw fail("invalid", `response did not match the schema: ${parsed.error.message}`, tokens);

      const byIndex = new Map<number, LlmItem[]>();
      for (const line of parsed.data.lines) {
        if (line.index >= 0 && line.index < lines.length && !byIndex.has(line.index)) {
          byIndex.set(line.index, line.items.map(sanitizeItem));
        }
      }
      return {
        byIndex,
        usage: {
          ...base,
          latencyMs: now() - started,
          inputTokens: tokens[0],
          outputTokens: tokens[1],
          cacheReadTokens: tokens[2],
          ok: true,
        },
      };
    },
  };
}
