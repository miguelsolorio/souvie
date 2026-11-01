// One model turn with tools (WS09): the call the shopping agent's loop makes on every turn. Like
// `extract`, every call goes through the daily cost guard first and writes one AiRunRecord, failed
// calls included (docs/03-ai-design.md §1, risk R3).
//
// The loop itself lives in @mp/agent, so its tools, policies and state machine stay in our code
// and replay in tests with a fake client. This file is the SDK seam: the slice of
// `messages.create` the loop uses, typed narrowly the way client.ts types `messages.parse`, so
// importing @mp/llm stays free and Deno-safe.
//
// Request shape for Sonnet 5.5 and Haiku 5.5 (docs/03 §1): no `thinking` (adaptive), no sampling
// parameters, `output_config.effort`, and `tool_choice` left at auto (a forced choice returns
// 400). Tools are sent with `strict: true` by the caller. The system blocks carry cache_control,
// and so does the last block of the newest user message, so each turn reads the turn before it
// from the cache.

import { type ApiUsage, DEFAULT_MODEL, type Effort, LlmError } from "./client.ts";
import {
  type AiRunRecord,
  type AiRunSink,
  type CostGuard,
  estimateCostUsd,
  estimateInputCostUsd,
} from "./log.ts";

/** A tool as the API takes it. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  strict?: boolean;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

/** Thinking and other blocks pass back to the API unchanged; the loop does not read them. */
export interface OtherBlock {
  type: string;
  [key: string]: unknown;
}

export type ResponseBlock = TextBlock | ToolUseBlock | OtherBlock;

export interface ToolResultBlockParam {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  cache_control?: { type: "ephemeral" };
}

export interface TextBlockParam {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export type UserBlockParam = TextBlockParam | ToolResultBlockParam;

export type MessageParam =
  | { role: "user"; content: string | UserBlockParam[] }
  | { role: "assistant"; content: ResponseBlock[] };

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface ToolTurnResponse {
  content: ResponseBlock[];
  stop_reason: string | null;
  usage: ApiUsage;
}

/** The part of the Anthropic SDK a tool loop uses. The real client is the SDK instance. */
export interface ToolMessagesClient {
  messages: { create(params: Record<string, unknown>): Promise<ToolTurnResponse> };
  beta?: { messages: { create(params: Record<string, unknown>): Promise<ToolTurnResponse> } };
}

export interface ToolTurnRequest {
  system: readonly SystemBlock[];
  messages: readonly MessageParam[];
  tools: readonly ToolDefinition[];
  /** Defaults to claude-sonnet-5-5. */
  model?: string;
  /** Default 16000 (a non-streaming request). */
  maxTokens?: number;
  /** Default "low": the agent chooses among numbered candidates. */
  effort?: Effort;
  /** ai_runs.kind: agent_plan for a run's first turn, agent_step after it. */
  kind: string;
  /** ai_runs.prompt_version */
  promptVersion: string;
  householdId: string | null;
  /** ai_runs.user_id, and the user the cost guard caps when there is no household. */
  userId?: string | null;
}

export interface ToolTurnContext {
  client: ToolMessagesClient;
  log?: AiRunSink;
  guard?: CostGuard;
  /** Opt-in server-side refusal fallback (beta), off by default like `extract`. */
  serverFallback?: boolean;
  now?: () => number;
}

export interface ToolTurnResult {
  content: ResponseBlock[];
  stopReason: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

const SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Marks the last block of the last user message for caching, without touching the caller's array. */
export function withCachedTail(messages: readonly MessageParam[]): MessageParam[] {
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const message = out[i];
    if (message?.role !== "user") continue;
    const blocks: UserBlockParam[] =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : [...message.content];
    const last = blocks[blocks.length - 1];
    if (!last) break;
    blocks[blocks.length - 1] = { ...last, cache_control: { type: "ephemeral" } };
    out[i] = { role: "user", content: blocks };
    break;
  }
  return out;
}

/**
 * Makes one model call with tools. Throws LlmError("cost_cap") before the call when the household
 * is over budget, LlmError("api") when the call fails, and LlmError("refusal") on a refusal. Every
 * call, failed or not, is logged once.
 */
export async function callWithTools(
  request: ToolTurnRequest,
  context: ToolTurnContext,
): Promise<ToolTurnResult> {
  const model = request.model ?? DEFAULT_MODEL;
  const now = context.now ?? (() => Date.now());
  await context.guard?.check(request.householdId, {
    kind: request.kind,
    model,
    promptVersion: request.promptVersion,
    userId: request.userId ?? null,
    estimatedCostUsd: context.guard
      ? estimateInputCostUsd(
          model,
          JSON.stringify([request.system, request.messages, request.tools]).length,
        )
      : 0,
  });

  const params: Record<string, unknown> = {
    model,
    max_tokens: request.maxTokens ?? 16_000,
    system: request.system,
    messages: withCachedTail(request.messages),
    tools: request.tools,
    tool_choice: { type: "auto" },
    output_config: { effort: request.effort ?? "low" },
  };
  const useFallback = context.serverFallback === true && context.client.beta !== undefined;
  if (useFallback) {
    params.betas = [SERVER_FALLBACK_BETA];
    params.fallbacks = "default";
  }

  const started = now();
  const log = async (usage: ApiUsage | null, ok: boolean, error: string | null) => {
    const used = {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    };
    const costUsd = estimateCostUsd(model, used);
    const record: AiRunRecord = {
      householdId: request.householdId,
      kind: request.kind,
      model,
      promptVersion: request.promptVersion,
      inputTokens: used.inputTokens,
      outputTokens: used.outputTokens,
      cacheReadTokens: used.cacheReadTokens,
      costUsd,
      latencyMs: Math.max(0, now() - started),
      ok,
      error,
      ...(request.userId !== undefined ? { userId: request.userId } : {}),
    };
    try {
      await context.log?.(record);
    } catch (err) {
      console.warn("ai_runs sink failed", err);
    }
    return { ...used, costUsd };
  };

  let response: ToolTurnResponse;
  try {
    response =
      useFallback && context.client.beta
        ? await context.client.beta.messages.create(params)
        : await context.client.messages.create(params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log(null, false, message);
    throw new LlmError("api", message, { cause: err });
  }

  if (response.stop_reason === "refusal") {
    await log(response.usage, false, "model refused the request");
    throw new LlmError("refusal", "the model declined to answer");
  }
  const used = await log(
    response.usage,
    response.stop_reason !== "max_tokens",
    response.stop_reason === "max_tokens" ? "response hit max_tokens" : null,
  );
  return {
    content: response.content,
    stopReason: response.stop_reason,
    model,
    ...used,
  };
}

/** Builds the real tool client from the SDK, loaded on first use. Throws without a key. */
export async function createAnthropicToolClient(options: {
  apiKey?: string;
  baseURL?: string;
}): Promise<ToolMessagesClient> {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) throw new LlmError("not_configured", "ANTHROPIC_API_KEY is not set");
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic({
    apiKey,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  }) as unknown as ToolMessagesClient;
}
