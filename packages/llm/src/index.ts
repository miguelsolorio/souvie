// @mp/llm: Anthropic client wrapper, prompt registry, structured-output helpers, cost logging.
//
//   extract(schema, request, context)   one validated structured-output call (extract.ts)
//   logAiRun / createDailyCapGuard       ai_runs rows and the per-household daily cap (log.ts)
//   embed                                Voyage embeddings for recipes and taste profiles (embed.ts)
//   definePrompt / RECIPE_EXTRACT_V1 / INGREDIENT_PARSE_V1 / SUGGEST_COMPOSE_V1 / SUGGEST_TASTE_SUMMARY_V1
//                                        the versioned prompt registry (prompts/)
//
// Relative imports carry the .ts extension so Supabase Edge Functions (Deno) can load this
// package by path. See README.md.
export const packageName = "@mp/llm";

export * from "./client.ts";
export * from "./embed.ts";
export * from "./extract.ts";
export * from "./log.ts";
export * from "./prompts/ingredient-parse.v1.ts";
export * from "./prompts/recipe-extract.v1.ts";
export * from "./prompts/registry.ts";
export * from "./prompts/suggest-compose.v1.ts";
export * from "./prompts/suggest-taste-summary.v1.ts";
