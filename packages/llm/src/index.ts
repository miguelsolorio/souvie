// @mp/llm: Anthropic client wrapper, prompt registry, structured-output helpers, cost logging.
//
//   extract(schema, request, context)   one validated structured-output call (extract.ts)
//   logAiRun / createDailyCapGuard       ai_runs rows and the per-household daily cap (log.ts)
//   definePrompt / RECIPE_EXTRACT_V1 / INGREDIENT_PARSE_V1   the versioned prompt registry (prompts/)
//
// Relative imports carry the .ts extension so Supabase Edge Functions (Deno) can load this
// package by path. See README.md.
export const packageName = "@mp/llm";

export * from "./client.ts";
export * from "./extract.ts";
export * from "./log.ts";
export * from "./prompts/ingredient-parse.v1.ts";
export * from "./prompts/recipe-extract.v1.ts";
export * from "./prompts/registry.ts";
