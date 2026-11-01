// Anthropic client wrapper (WS02). The rest of the repo talks to models through `extract`, which
// takes a `MessagesClient`; this file defines that slice of the SDK, the errors the package
// throws, and the factory for the real client. Tests pass a fake `MessagesClient`.
//
// Edge Functions (Deno) and Node both import this file, so there are no Node or Deno globals at
// import time and the SDK loads lazily.

/** The three model tiers (docs/03-ai-design.md §1). Exact ids, no date suffix. */
export const MODELS = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
} as const;
export type ModelId = (typeof MODELS)[keyof typeof MODELS];

/** Recipe extraction, caption-to-recipe, planning, and the shopping agent run on Sonnet. */
export const DEFAULT_MODEL: ModelId = MODELS.sonnet;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type LlmErrorCode =
  /** The model declined (stop_reason "refusal"). */
  | "refusal"
  /** The response hit max_tokens before the JSON was complete. */
  | "truncated"
  /** The response did not match the schema, even after one retry. */
  | "invalid"
  /** The API call failed (network, auth, rate limit, 5xx). */
  | "api"
  /** The household is over its daily model budget. */
  | "cost_cap"
  /** Today's spend could not be read, so the call was refused (the cap fails closed). Try again. */
  | "cost_unknown"
  /** No API key, so no model can be called. */
  | "not_configured";

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  constructor(code: LlmErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlmError";
    this.code = code;
  }
}

/** Token counts as the API reports them. Cache fields are absent when caching was not involved. */
export interface ApiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export interface ParsedResponse {
  /** Set by the SDK's `parse` helper when `output_config.format` was a parseable format. */
  parsed_output: unknown;
  stop_reason: string | null;
  usage: ApiUsage;
}

/**
 * The part of the Anthropic SDK this package uses: `messages.parse` (structured outputs), plus
 * `beta.messages.parse` for the optional server-side fallback. Pass a fake in tests.
 */
export interface MessagesClient {
  messages: {
    parse(params: Record<string, unknown>): Promise<ParsedResponse>;
  };
  beta?: {
    messages: {
      parse(params: Record<string, unknown>): Promise<ParsedResponse>;
    };
  };
}

export interface CreateClientOptions {
  /** Falls back to ANTHROPIC_API_KEY from the environment when the SDK reads it. */
  apiKey?: string;
  baseURL?: string;
}

/**
 * Builds the real client. The SDK is imported on first use, so importing `@mp/llm` is free and a
 * test that passes its own `MessagesClient` never loads it. Throws `not_configured` without a key.
 */
export async function createAnthropicClient(
  options: CreateClientOptions = {},
): Promise<MessagesClient> {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    throw new LlmError("not_configured", "ANTHROPIC_API_KEY is not set");
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic({
    apiKey,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  }) as unknown as MessagesClient;
}
