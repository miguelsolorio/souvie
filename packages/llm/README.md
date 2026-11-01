# @mp/llm

The Anthropic client wrapper, the versioned prompt registry, structured-output helpers, and `ai_runs` cost logging. Model tiers are in `docs/03-ai-design.md`.

## Status

WS02 created the package: `extract`, the prompt registry, `logAiRun`, and the daily cost cap. `recipe-extract.v1` is the first prompt; `ingredient-parse.v1` (WS03's) moved in unchanged. WS06 added `embed` and the `suggest-compose.v1` and `suggest-taste-summary.v1` prompts (readable copies in `prompts/suggest/`, kept identical to the modules by a test). WS09 adds its own.

## `extract`

```ts
import { extract, RECIPE_EXTRACT_V1, RecipeExtractOutput, createAnthropicClient, logAiRun } from "@mp/llm";

const client = await createAnthropicClient({ apiKey: process.env.ANTHROPIC_API_KEY });
const { value } = await extract(
  RecipeExtractOutput,
  {
    system: RECIPE_EXTRACT_V1.system(),
    user: RECIPE_EXTRACT_V1.user({ source: "pasted_text", text }),
    kind: RECIPE_EXTRACT_V1.kind,         // ai_runs.kind
    promptVersion: RECIPE_EXTRACT_V1.id,  // "recipe-extract.v1"
    householdId,
  },
  { client, log: (run) => logAiRun(serviceDb.from("ai_runs"), run) },
);
```

What it does on every call:

- Sends `claude-sonnet-5-5` unless `model` says otherwise, with `output_config.format` built from the zod schema and `output_config.effort` (default `low`; extraction is not reasoning). It sends no `thinking` and no sampling parameters: Sonnet 5.5 runs adaptive thinking when `thinking` is omitted, and rejects `{type: "disabled"}` and non-default `temperature`.
- Puts `system` in a cacheable block and the untrusted content in the user message.
- Checks the cost guard first, if one is given.
- Validates the answer with the schema and the optional `check` callback. A failure retries once with the problem described. A second failure throws `LlmError("invalid")`.
- Calls `log` once per model call, retries and failures included, with tokens, estimated cost, latency, `kind`, and `promptVersion`.

`LlmError.code` is one of `refusal`, `truncated`, `invalid`, `api`, `cost_cap`, `not_configured`.

Pass `images` (base64 JPEG, PNG, WebP, or GIF) for vision. Pass `client` to use a fake in tests; the SDK loads lazily.

`serverFallback: true` adds `betas: ["server-side-fallback-2026-07-01"]` and `fallbacks: "default"` through `client.beta.messages.parse`, so a policy refusal is retried on a substitute model inside the same call. It is off by default: it is a beta path that has not been exercised against a live key here, and recipe text rarely trips a safeguard.

## Prompts

`src/prompts/<name>.v<n>.ts` defines a prompt with `definePrompt({ name, version, kind, model, system, user })`. The registry rejects a duplicate id. The id (`recipe-extract.v1`) goes in `ai_runs.prompt_version`. To change a shipped prompt, add `v2` beside it; never edit `v1` in place. A prompt change comes with eval results (docs/03 §10).

## Cost and the daily cap

`estimateCostUsd(model, usage)` prices a call from the table in `log.ts` (Haiku $0.10/$0.50, Sonnet $2/$10, Opus $4/$20 per million tokens; cache reads at a fraction of input, cache writes at 1.25x). `createDailyCapGuard(options)` returns the guard to pass as `context.guard` (`extract`, `callWithTools`, `embed`) before any request goes out.

- `capUsd` is the fallback cap (`AI_DAILY_CAP_USD`, default 2). `capFor(householdId)` reads the household's own, `households.ai_daily_cap_usd` (WS15); a null or a failing lookup falls back to `capUsd`.
- `spentTodayUsd(householdId)` is today's UTC spend (`household_ai_spend_since`). `userSpentTodayUsd(userId)` is the same for a user's household-less calls (`user_ai_spend_since`); a call with no household and a `userId` is capped per user.
- `check(householdId, call)` refuses when spend plus the call's `estimatedCostUsd` (its input at the model's price) reaches the cap. A refusal writes an `ai_runs` row through `sink` (`ok` false, `error` `cost_cap`, cost 0) and throws `CostCapError`, an `LlmError` with code `cost_cap`, `scope`, `capUsd` and `spentUsd`. A failing spend lookup lets the call through with a warning; a call with no household and no user is never capped.
- The callers: `suggest`, `recipe-import`, `llm-proxy` and the worker's `models.ts` pass their `ai_runs` sink as `sink` and their store's cap lookup as `capFor`; `parse-ingredients` wraps the parser's model client in `cost-guard.ts`.

## Scripts

```bash
pnpm --filter @mp/llm typecheck
pnpm --filter @mp/llm lint
pnpm --filter @mp/llm test
```

## `embed`

```ts
import { embed, formatVector } from "@mp/llm";

const [vector] = await embed(["Sheet pan lemon chicken | cuisine: mediterranean"], {
  inputType: "document", // "query" for a taste profile used to search recipes
  kind: "suggest.embed",
  householdId,
  log: (run) => logAiRun(serviceDb.from("ai_runs"), run),
});
// formatVector(vector) is pgvector text, for `update recipes set embedding = $1::vector`
```

Voyage AI `voyage-3`, 1024 dimensions, the size of `recipes.embedding` and `profiles.taste_embedding`. The key is `VOYAGE_API_KEY` (read from `options.apiKey`, else the environment); without it `embed` throws `LlmError("not_configured")`, the same error the Anthropic path throws, and callers fall back to ranking by popularity and cuisine. One `ai_runs` row per request, failures included, at $0.06 per million tokens. Batches of 64, one retry on a 429 or 5xx, and a wrong vector size is `invalid`. The key never appears in an error or a log.

## Evals

`evals/suggest/` holds the `pnpm eval suggest` eval for WS06: ten household fixtures run against a shared recipe corpus, judged by hand-written labels. It prints `hard-filter violations: 0`. See the header of `evals/suggest/run.ts`.
