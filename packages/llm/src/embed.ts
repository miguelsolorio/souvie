// embed(texts): Voyage AI embeddings for recipes and taste profiles (WS06, decided 2026-10-30).
// docs/03-ai-design.md §1: `voyage-3` produces the 1024 dimensions that `recipes.embedding` and
// `profiles.taste_embedding` hold.
//
//   const vectors = await embed(["Sheet pan lemon chicken | mediterranean | chicken, lemon"], {
//     inputType: "document",
//     kind: "suggest.embed",
//     householdId,
//     log: (run) => logAiRun(serviceDb.from("ai_runs"), run),
//   });
//
// Without VOYAGE_API_KEY it throws LlmError("not_configured"), the same error the Anthropic path
// throws, and callers fall back to ranking by popularity and cuisine. One `ai_runs` row is written
// per HTTP request, failures included. The key is read from `options.apiKey`, else from
// VOYAGE_API_KEY in the environment (Deno or Node). It is never logged and never part of an error.
import { LlmError } from "./client.ts";
import type { AiRunSink, CostGuard } from "./log.ts";

export const EMBEDDING_MODEL = "voyage-3";
export const EMBEDDING_DIMENSIONS = 1024;
/** USD per million tokens for voyage-3. */
export const EMBEDDING_PRICE_PER_MTOK = 0.06;
const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
/** Inputs per request. Voyage allows 128; a smaller batch keeps one request well under its token cap. */
const BATCH_SIZE = 64;
const MAX_RETRY_WAIT_MS = 10_000;

export type EmbedInputType = "document" | "query";

export interface EmbedOptions {
  /** Defaults to VOYAGE_API_KEY from the environment. */
  apiKey?: string | undefined;
  /** "document" for recipes, "query" for a taste profile used to search them. Default "document". */
  inputType?: EmbedInputType;
  /** ai_runs.kind. Default "embed". */
  kind?: string;
  /** ai_runs.household_id, and the household the cost guard checks. */
  householdId?: string | null;
  /** Receives one record per request. */
  log?: AiRunSink;
  guard?: CostGuard;
  /** For tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  baseURL?: string;
}

interface VoyageResponse {
  data?: { embedding?: unknown; index?: unknown }[];
  usage?: { total_tokens?: unknown };
}

type EnvLike = {
  env?: { get?: (name: string) => string | undefined } | Record<string, string | undefined>;
};

function readEnv(name: string): string | undefined {
  const g = globalThis as { Deno?: EnvLike; process?: EnvLike };
  const deno = g.Deno?.env;
  if (deno && typeof (deno as { get?: unknown }).get === "function") {
    return (deno as { get: (n: string) => string | undefined }).get(name);
  }
  const node = g.process?.env as Record<string, string | undefined> | undefined;
  return node?.[name];
}

/** True when a Voyage key is available, so callers can skip work that needs vectors. */
export function isEmbeddingConfigured(apiKey?: string): boolean {
  return Boolean((apiKey ?? readEnv("VOYAGE_API_KEY"))?.trim());
}

/** pgvector's text form, for example [0.1,0.2]. PostgREST and SQL casts accept it. */
export function formatVector(values: readonly number[]): string {
  return `[${values.join(",")}]`;
}

export function estimateEmbeddingCostUsd(tokens: number): number {
  return Math.round(((tokens * EMBEDDING_PRICE_PER_MTOK) / 1_000_000) * 1e8) / 1e8;
}

/**
 * Embeds each text and returns the vectors in the same order. Throws `not_configured` without a
 * key, `cost_cap` when the household is over its budget, `api` when Voyage refuses or is
 * unreachable, and `invalid` when the answer has the wrong shape.
 */
export async function embed(
  texts: readonly string[],
  options: EmbedOptions = {},
): Promise<number[][]> {
  const apiKey = (options.apiKey ?? readEnv("VOYAGE_API_KEY"))?.trim();
  if (!apiKey) throw new LlmError("not_configured", "VOYAGE_API_KEY is not set");
  if (texts.length === 0) return [];
  if (texts.some((text) => text.trim().length === 0)) {
    throw new LlmError("invalid", "cannot embed an empty text");
  }

  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const householdId = options.householdId ?? null;
  const kind = options.kind ?? "embed";
  const out: number[][] = [];

  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE);
    await options.guard?.check(householdId);

    let attempt = 0;
    for (;;) {
      attempt += 1;
      const started = now();
      let tokens = 0;
      const record = async (ok: boolean, error: string | null) => {
        try {
          await options.log?.({
            householdId,
            kind,
            model: EMBEDDING_MODEL,
            promptVersion: null,
            inputTokens: tokens,
            outputTokens: 0,
            cacheReadTokens: 0,
            costUsd: estimateEmbeddingCostUsd(tokens),
            latencyMs: Math.max(0, now() - started),
            ok,
            error,
          });
        } catch (err) {
          console.warn("ai_runs sink failed", err);
        }
      };

      let response: Response;
      try {
        response = await doFetch(options.baseURL ?? VOYAGE_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            input: batch,
            model: EMBEDDING_MODEL,
            input_type: options.inputType ?? "document",
            truncation: true,
          }),
        });
      } catch (err) {
        await record(false, "network error");
        throw new LlmError("api", "could not reach the embedding service", { cause: err });
      }

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        await record(false, `voyage returned ${response.status}`);
        if (retryable && attempt === 1) {
          const wait = Number(response.headers.get("retry-after")) * 1000;
          await sleep(Math.min(Number.isFinite(wait) && wait > 0 ? wait : 2000, MAX_RETRY_WAIT_MS));
          continue;
        }
        // The body is not read: an error page can echo the request.
        throw new LlmError("api", `the embedding service returned ${response.status}`);
      }

      let body: VoyageResponse;
      try {
        body = (await response.json()) as VoyageResponse;
      } catch (err) {
        await record(false, "unreadable response");
        throw new LlmError("invalid", "the embedding service sent an unreadable answer", {
          cause: err,
        });
      }
      tokens = Number(body.usage?.total_tokens) || 0;

      const rows = body.data ?? [];
      const vectors: number[][] = [];
      for (const row of [...rows].sort((a, b) => Number(a.index) - Number(b.index))) {
        const vector = row.embedding;
        if (
          !Array.isArray(vector) ||
          vector.length !== EMBEDDING_DIMENSIONS ||
          !vector.every((n) => typeof n === "number" && Number.isFinite(n))
        ) {
          await record(false, "wrong vector shape");
          throw new LlmError(
            "invalid",
            `expected ${EMBEDDING_DIMENSIONS} dimensions per vector from ${EMBEDDING_MODEL}`,
          );
        }
        vectors.push(vector as number[]);
      }
      if (vectors.length !== batch.length) {
        await record(false, "wrong vector count");
        throw new LlmError("invalid", "the embedding service returned the wrong number of vectors");
      }
      await record(true, null);
      out.push(...vectors);
      break;
    }
  }
  return out;
}
