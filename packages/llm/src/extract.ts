// extract<T>(schema, request, context): one structured-output call, validated, logged, retried
// once on a schema failure (docs/03-ai-design.md §1: every call declares a zod schema, uses
// structured outputs, and writes an ai_runs row).
//
//   const { value } = await extract(RecipeExtractOutput, {
//     system: RECIPE_EXTRACT_V1.system(),
//     user: RECIPE_EXTRACT_V1.user({ source: "pasted_text", text }),
//     kind: "extract_recipe",
//     promptVersion: RECIPE_EXTRACT_V1.id,
//     householdId,
//   }, { client, log });
//
// The model proposes; this function checks. It never throws for a model that "mostly" answered:
// a response that fails the schema or the caller's `check` is retried once with the problem
// described, and then reported as LlmError("invalid").

import type { z } from "zod";
import {
  type ApiUsage,
  createAnthropicClient,
  DEFAULT_MODEL,
  type Effort,
  LlmError,
  type MessagesClient,
  type ParsedResponse,
} from "./client.ts";
import {
  type AiRunRecord,
  type AiRunSink,
  type CostGuard,
  estimateCostUsd,
  estimateInputCostUsd,
} from "./log.ts";

export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

/** An image sent to the model, as base64 (no data: prefix). */
export interface ExtractImage {
  mediaType: ImageMediaType;
  data: string;
}

export interface ExtractRequest<T = unknown> {
  /** The stable instructions. Sent as a cacheable system block. */
  system: string;
  /** The per-call input. Untrusted content goes here, never in `system`. */
  user: string;
  images?: readonly ExtractImage[];
  /** Defaults to claude-sonnet-5-5. */
  model?: string;
  /** Output ceiling, which also bounds thinking. Default 16000. */
  maxTokens?: number;
  /** Extraction is not reasoning; "low" is the default. */
  effort?: Effort;
  /** ai_runs.kind. Default "extract". */
  kind?: string;
  /** ai_runs.prompt_version, for example "recipe-extract.v1". */
  promptVersion?: string;
  /** ai_runs.household_id, and the household the cost guard checks. */
  householdId?: string | null;
  /** ai_runs.user_id, and the user the cost guard caps when there is no household. */
  userId?: string | null;
  /**
   * A second check on the parsed value (rules the model's JSON schema cannot express). Return a
   * short problem description to trigger the one retry, or null when the value is acceptable.
   */
  check?: (value: T) => string | null;
}

export interface ExtractContext {
  /** The SDK client. When omitted, one is created from `apiKey`. */
  client?: MessagesClient;
  apiKey?: string;
  /** Receives one record per model call, including failures. */
  log?: AiRunSink;
  /** Checked before each call. */
  guard?: CostGuard;
  /**
   * Ask the API to retry on a substitute model when the requested one declines for policy reasons
   * (beta `server-side-fallback-2026-07-01`, fallbacks "default"). Off by default: it is a beta
   * path that needs a live key to verify, and recipe text rarely trips a safeguard.
   */
  serverFallback?: boolean;
  /** Clock for latency, injectable for tests. */
  now?: () => number;
  /** Schema retries after the first attempt. Default 1. */
  maxRetries?: number;
}

export interface ExtractResult<T> {
  value: T;
  model: string;
  /** Model calls made, 1 or 2. */
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

const DEFAULT_MAX_TOKENS = 16_000;
const SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01";

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

function usageOf(usage: ApiUsage) {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function userContent(
  request: { user: string; images?: readonly ExtractImage[] },
  retryNote: string | null,
) {
  const text = retryNote ? `${request.user}\n\n${retryNote}` : request.user;
  if (!request.images || request.images.length === 0) return text;
  return [
    ...request.images.map((image) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
    })),
    { type: "text" as const, text },
  ];
}

export async function extract<T>(
  schema: z.ZodType<T>,
  request: ExtractRequest<T>,
  context: ExtractContext = {},
): Promise<ExtractResult<T>> {
  const model = request.model ?? DEFAULT_MODEL;
  const now = context.now ?? (() => Date.now());
  const maxRetries = context.maxRetries ?? 1;
  const householdId = request.householdId ?? null;

  // Fail before any work when there is no way to call a model.
  const client = context.client ?? (await createAnthropicClient({ apiKey: context.apiKey }));
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const format = zodOutputFormat(schema);

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let costUsd = 0;
  let retryNote: string | null = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    await context.guard?.check(householdId, {
      kind: request.kind ?? "extract",
      model,
      promptVersion: request.promptVersion ?? null,
      userId: request.userId ?? null,
      estimatedCostUsd: estimateInputCostUsd(
        model,
        request.system.length + request.user.length + (retryNote?.length ?? 0),
      ),
    });

    const params: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userContent(request, retryNote) }],
      // No thinking or sampling parameters: Sonnet 5.5 runs adaptive thinking when `thinking` is
      // omitted, rejects {type: "disabled"} and rejects non-default sampling values.
      output_config: { effort: request.effort ?? "low", format },
    };
    const useFallback = context.serverFallback === true && client.beta !== undefined;
    if (useFallback) {
      params.betas = [SERVER_FALLBACK_BETA];
      params.fallbacks = "default";
    }

    const started = now();
    const safeLog = async (run: AiRunRecord) => {
      try {
        await context.log?.(run);
      } catch (err) {
        console.warn("ai_runs sink failed", err);
      }
    };
    const record = (
      usage: ReturnType<typeof usageOf> | null,
      ok: boolean,
      error: string | null,
    ) => {
      const used = usage ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      const cost = estimateCostUsd(model, used);
      inputTokens += used.inputTokens;
      outputTokens += used.outputTokens;
      cacheReadTokens += used.cacheReadTokens;
      costUsd += cost;
      return safeLog({
        householdId,
        kind: request.kind ?? "extract",
        model,
        promptVersion: request.promptVersion ?? null,
        inputTokens: used.inputTokens,
        outputTokens: used.outputTokens,
        cacheReadTokens: used.cacheReadTokens,
        costUsd: cost,
        latencyMs: Math.max(0, now() - started),
        ok,
        error,
        ...(request.userId !== undefined ? { userId: request.userId } : {}),
      });
    };

    let response: ParsedResponse;
    try {
      response =
        useFallback && client.beta
          ? await client.beta.messages.parse(params)
          : await client.messages.parse(params);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // An API error carries an HTTP status. The SDK's own "could not parse the structured
      // output" error does not, and that is the kind worth one retry.
      const status = (err as { status?: unknown } | null)?.status;
      const invalid = status === undefined && /parse|schema|json/i.test(message);
      await record(null, false, message);
      if (invalid && attempt <= maxRetries) {
        retryNote = `Your previous answer could not be read (${message.slice(0, 200)}). Answer again with JSON that matches the schema exactly.`;
        continue;
      }
      throw new LlmError(invalid ? "invalid" : "api", message, { cause: err });
    }

    const usage = usageOf(response.usage);

    if (response.stop_reason === "refusal") {
      await record(usage, false, "model refused the request");
      throw new LlmError("refusal", "the model declined to answer");
    }
    if (response.stop_reason === "max_tokens") {
      await record(usage, false, "response hit max_tokens");
      throw new LlmError("truncated", "the response was cut off before the JSON was complete");
    }

    const parsed = schema.safeParse(response.parsed_output);
    const problem = parsed.success
      ? (request.check?.(parsed.data) ?? null)
      : `the answer did not match the schema: ${describeIssues(parsed.error)}`;
    if (!parsed.success || problem !== null) {
      const message = problem ?? "invalid answer";
      await record(usage, false, message);
      if (attempt <= maxRetries) {
        retryNote = `Your previous answer was rejected: ${message}. Answer again with JSON that matches the schema exactly.`;
        continue;
      }
      throw new LlmError("invalid", message);
    }

    await record(usage, true, null);
    return {
      value: parsed.data,
      model,
      attempts: attempt,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      costUsd: Math.round(costUsd * 1e8) / 1e8,
    };
  }

  // Unreachable: the loop returns or throws on its last pass.
  throw new LlmError("invalid", "no valid answer");
}
