# @mp/ingredient-parser

Parses a line such as "2 cups diced yellow onion" into quantity, unit, ingredient, and preparation. A deterministic grammar and an ontology lookup run first. The model (Haiku) is a cached fallback for the lines they are unsure about.

```ts
import { parseLine, parseLines, parseLinesGrouped } from "@mp/ingredient-parser";

const p = await parseLine("2 cups diced yellow onion", { ontology });
// { rawText, qty: 2, unit: "cup", ingredientId: "…", ingredientName: "yellow onion",
//   prepNote: "diced", optional: false, confidence: 0.95, stage: "grammar" }
```

## Pipeline

1. **Grammar** (`grammar.ts`). Quantities (integers, decimals, ASCII and unicode fractions, mixed numbers, ranges like "2-3" and "1 to 2", number words, "a"). Units and their abbreviations (`@mp/core` `normalizeUnit`). Package sizes ("1 (14 oz) can", "two 15-ounce cans", "2 x 400g tins"). Sums ("1 tablespoon plus 1 teaspoon"). Preparation after a comma or in parentheses. Qualifiers: "to taste", "divided", "optional", "plus more for serving", "for garnish". "Juice of 1 lemon".
2. **Lookup** (`lookup.ts`). The noun phrase is tried against the ontology as written, then with leading modifiers dropped ("fresh", "large", "finely chopped"), then singularized, then by trigram similarity of 0.85 or more (`docs/03-ai-design.md` §5). "salt and pepper" with no amount splits into two ingredients when each part is known.
3. **Model fallback** (`llm-fallback.ts`). Lines under 0.8 confidence go to `claude-haiku-5-5` in batches of 20 with a strict zod schema. Results are cached by normalized text (`cache.ts`), so a line is never sent twice. The cache holds the model's answer; the ontology lookup of its ingredient name runs again on every hit. A line the model looked at and rejected is cached as an entry with no items, so it is not asked again. A line the model skipped is not cached.
4. **Unknowns.** A name the ontology lacks comes back with `ingredientId: null` and is reported to the `ProposalSink` (the Edge Function writes `ingredient_alias_proposals`).

Section headers ("For the sauce:") and blank lines are not ingredients. They come back with confidence 0 and never go to the model, so a caller can drop them.

The cache key is the lowercased, normalized line, except that a lone `T` (tablespoon) and `t` (teaspoon) keep their case. "1 T salt" and "1 t salt" are different lines.

If no model client is given, or a call fails, a line keeps its deterministic best guess. Nothing throws on a bad line. A side effect that fails after the model was paid for (cache read or write, proposal sink, run logging) is reported to `onWarning` (default `console.warn`) and the parse carries on. A quantity with a zero denominator ("1/0 cup") or too many numerals to be finite is read as no quantity, with low confidence.

## Result shape

`ParsedIngredient` lives in `@mp/core` (`ingredient.ts`).

| Field | Meaning |
|---|---|
| `qty`, `qtyMax` | Low end and high end of a range. `qty` is null when no amount is written. |
| `unit` | A code from `@mp/core` `units.ts`. A counted item with no unit word gets `each`. Null only when `qty` is null. Size words (`small`, `medium`, `large`) are units. |
| `ingredientId`, `ingredientName` | The ontology row, or null id and the cleaned name for an unknown. |
| `prepNote` | Preparation and qualifiers joined by ", ": "packed, divided". |
| `optional` | True only when the line says optional. |
| `confidence`, `stage` | See below. |
| `splitFrom` | Set when one line named several ingredients. The original line. |

Package sizes become the amount: "2 (14 oz) cans" is 28 oz. The can count is not kept. `ParsedIngredient` has no field for it; see the contract change request in the WS03 report.

### Confidence and stage

Exact name match 0.97. Match after dropping modifiers or singularizing 0.95. "A or B" alternative 0.85. Trigram match 0.80 to 0.90. Unknown 0.35. Then small penalties: no amount and no qualifier, a quantity left in the name, a very long name.

`stage` is the last stage that mattered: `grammar` for an exact path, `lookup` for a trigram match, an "or" alternative, or a split, and `llm` for a model answer.

### Split lines

`parseLine` returns the first ingredient of a split line. `parseLines` returns every ingredient, flat. `parseLinesGrouped` returns one list per input line, which is what a caller that writes rows wants. Every result from a split line carries the original text in both `rawText` and `splitFrom`.

## Wiring

Everything outside the package arrives through `ParserDeps`:

| Port | Production | Tests and evals |
|---|---|---|
| `ontology: OntologyStore` | `supabase/functions/parse-ingredients/store.ts` (`ingredient_aliases`, `match_ingredient_alias`) | `InMemoryOntology` built from the seed CSVs |
| `cache: ParseCache` | `ingredient_parse_cache` | `InMemoryParseCache` |
| `llm: LlmParseClient` | `createAnthropicParseClient()` | a scripted fake |
| `proposals: ProposalSink` | `record_ingredient_alias_proposal` | an array |

`InMemoryOntology` uses the same trigram arithmetic as pg_trgm. A script run during the build compared it with the SQL function on 816 lookups and found no difference.

The package has no Node APIs in `src/`, so Supabase Edge Functions (Deno) import it directly. Relative imports carry the `.ts` extension for that reason.

### The model client

`createAnthropicParseClient()` calls the Messages API through `@anthropic-ai/sdk` with `claude-haiku-5-5`, `output_config.effort: "low"`, a JSON schema from `zodOutputFormat`, and a cached system prompt. It sends no sampling parameters, which Haiku 5.5 rejects. `@mp/llm` does not have `extract` yet (WS02). When it lands, write an adapter that implements `LlmParseClient` over it and drop this file's factory. The prompt is in `prompt.ts` and moves to `packages/llm/src/prompts/ingredient-parse.v1.ts` with the registry.

`estimateCostUsd` prices a call at Haiku 5.5 list rates for the `ai_runs` row.

## Evals

`evals/lines.json` holds 500 labeled lines. `pnpm --filter @mp/ingredient-parser eval` runs `evals/parse.eval.ts`:

1. The deterministic path on all 500 lines: qty and unit exact at least 95%, ingredient id right at least 90%, confidence 0.8 or more on at least 80% of lines, and at most 5 lines that are wrong yet confident.
2. A cache proof with a stand-in model: the second pass makes zero calls.
3. With `ANTHROPIC_API_KEY` set, the real pipeline against the same thresholds, with a disk cache in `evals/.cache/` so a rerun costs nothing.

### How honest the numbers are

The labels were written by the builder agent (Claude Sonnet 5.5) from scratch. No person has spot-checked them, and Opus did not label them. The parser was tuned against the set, so the scores on it are in-sample and reach 100% on qty, unit, and ingredient.

Two tranches were written blind, with labels fixed before the parser saw them. Their first runs, before any fix, are the nearest thing to an out-of-sample score:

| Tranche | Lines | qty and unit | ingredient | wrong yet confident |
|---|---|---|---|---|
| Messy real-world style | 128 | 89.8% | 88.3% | 2 |
| Second round, after the first fixes | 51 | 90.2% | 80.4% | 2 |
| Held out, not in the repo | 40 | 100% | 95.0% | 0 |

The fixes were general: sums with "plus", "each", package sizes, hedges like "about", more aliases. Expect the deterministic path to land near 90% on lines it has not seen, with the model catching most of the rest. The live number has not been measured because no Anthropic key was available while building. Someone should run the eval with a key and label 100 fresh lines by hand.

## Scripts

```bash
pnpm --filter @mp/ingredient-parser typecheck
pnpm --filter @mp/ingredient-parser lint
pnpm --filter @mp/ingredient-parser test
pnpm --filter @mp/ingredient-parser eval
```
