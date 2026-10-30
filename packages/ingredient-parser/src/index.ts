// @mp/ingredient-parser: parses an ingredient line into quantity, unit, ingredient, and prep.
//
//   grammar  ->  lookup  ->  model fallback (cached)
//
// parseLine / parseLines run all three. Everything the pipeline touches (ontology, cache, model,
// proposal sink) arrives through `ParserDeps`, so the same code runs in Vitest, the golden-set eval,
// and a Supabase Edge Function. See README.md.

import type { IngredientCategory, ParsedIngredient } from "@mp/core";
import { type CachedParse, cacheKey, isCurrentPromptVersion, type ParseCache } from "./cache.ts";
import { type GrammarParse, parseGrammar } from "./grammar.ts";
import { PREP_ADVERBS, PREP_WORDS } from "./lexicon.ts";
import {
  LLM_BATCH_SIZE,
  type LlmBatchResult,
  type LlmItem,
  type LlmParseClient,
  type LlmUsage,
  sanitizeItem,
} from "./llm-fallback.ts";
import {
  DEFAULT_SIMILARITY_THRESHOLD,
  type MatchKind,
  type OntologyStore,
  type Resolution,
  resolveNoun,
} from "./lookup.ts";
import { cleanPhrase } from "./normalize.ts";

export * from "./cache.ts";
export * from "./grammar.ts";
export * from "./llm-fallback.ts";
export * from "./lookup.ts";
export * from "./normalize.ts";
export * from "./ontology.ts";

/** Lines below this confidence go to the model (docs/03-ai-design.md §5). */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;

export interface AliasProposal {
  rawText: string;
  proposedName: string;
  proposedCategory: IngredientCategory | null;
}

/** Receives names the ontology lacks. The Edge Function writes them to ingredient_alias_proposals. */
export interface ProposalSink {
  record(proposal: AliasProposal): Promise<void>;
}

export interface ParserDeps {
  ontology: OntologyStore;
  /** Without a cache, every model call is paid for. */
  cache?: ParseCache;
  /** Without a model, low-confidence lines keep their deterministic best guess. */
  llm?: LlmParseClient;
  proposals?: ProposalSink;
  /** Called once per model call, for `ai_runs`. */
  onLlmRun?: (usage: LlmUsage) => void | Promise<void>;
  /** Called when a model call fails; the affected lines keep their deterministic guess. */
  onLlmError?: (error: unknown, lines: readonly string[]) => void;
  /**
   * Called when a side effect fails after the parse has already been paid for (cache read or
   * write, proposal sink, run logging). The parse carries on. Defaults to console.warn.
   */
  onWarning?: (message: string, error: unknown) => void;
  confidenceThreshold?: number;
  similarityThreshold?: number;
  batchSize?: number;
  /** Lines resolved at once. Matters for a database-backed ontology; default 8. */
  concurrency?: number;
}

// ---------------------------------------------------------------------------
// Deterministic path: grammar + lookup
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Run a side effect that must not abort the parse: log the failure and move on. */
async function safely(deps: ParserDeps, what: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (deps.onWarning) deps.onWarning(what, err);
    else console.warn(`ingredient-parser: ${what}`, err);
  }
}

const isPrepWord = (w: string): boolean => PREP_WORDS.has(w) || PREP_ADVERBS.has(w);

/** Preparation words dropped from the front of the noun phrase, e.g. "peeled and deveined". */
function leadingPrep(front: readonly string[]): string[] {
  const kept: string[] = [];
  front.forEach((w, i) => {
    if (isPrepWord(w)) kept.push(w);
    else if ((w === "and" || w === "&") && kept.length > 0 && isPrepWord(front[i + 1] ?? ""))
      kept.push(w);
  });
  // Drop dangling adverbs ("freshly") that lost their verb.
  while (
    kept.length > 0 &&
    PREP_ADVERBS.has(kept[kept.length - 1] ?? "") &&
    !PREP_WORDS.has(kept[kept.length - 1] ?? "")
  ) {
    kept.pop();
  }
  return kept.length > 0 ? [kept.join(" ")] : [];
}

/** Prep words inside the matched alias that the canonical name lacks ("packed brown sugar"). */
function aliasPrep(res: Resolution): string[] {
  const match = res.match;
  if (!match || match.alias === match.name) return [];
  const nameWords = new Set(match.name.split(" "));
  const words = match.alias.replace(/-/g, " ").split(" ");
  const extra = words.filter((w) => isPrepWord(w) && !nameWords.has(w));
  // "ground" on a spice is just its form, not a preparation step.
  const useful = match.category === "spices" ? extra.filter((w) => w !== "ground") : extra;
  while (
    useful.length > 0 &&
    PREP_ADVERBS.has(useful[useful.length - 1] ?? "") &&
    !PREP_WORDS.has(useful[useful.length - 1] ?? "")
  ) {
    useful.pop();
  }
  return useful.length > 0 ? [useful.join(" ")] : [];
}

function joinPrep(parts: readonly string[]): string | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out.length > 0 ? out.join(", ") : null;
}

function matchConfidence(
  kind: MatchKind,
  similarity: number | undefined,
  threshold: number,
): number {
  switch (kind) {
    case "exact":
      return 0.97;
    case "stripped":
    case "singular":
      return 0.95;
    case "alternative":
      return 0.85;
    case "similar": {
      const span = Math.max(1 - threshold, 0.01);
      return 0.8 + (((similarity ?? threshold) - threshold) / span) * 0.1;
    }
    default:
      return 0.35;
  }
}

function stageFor(kind: MatchKind): ParsedIngredient["stage"] {
  return kind === "exact" || kind === "stripped" || kind === "singular" || kind === "none"
    ? "grammar"
    : "lookup";
}

function buildItem(
  g: GrammarParse,
  res: Resolution,
  threshold: number,
  extra: { splitFrom?: string; cap?: number } = {},
): ParsedIngredient {
  let confidence = matchConfidence(res.kind, res.similarity, threshold);
  if (g.qty == null && g.prep.length === 0 && !g.optional && extra.splitFrom === undefined)
    confidence -= 0.03;
  if (g.strayQuantity) confidence -= 0.3;
  if (g.noun.split(" ").length > 6) confidence -= 0.1;
  if (res.strippedFront.length > 3) confidence -= 0.05;
  if (extra.cap !== undefined) confidence = Math.min(confidence, extra.cap);

  const item: ParsedIngredient = {
    rawText: g.rawText,
    qty: g.qty,
    qtyMax: g.qtyMax,
    unit: g.unit,
    ingredientId: res.match?.ingredientId ?? null,
    ingredientName: res.match?.name ?? (res.name || null),
    prepNote: joinPrep([...leadingPrep(res.strippedFront), ...aliasPrep(res), ...g.prep]),
    optional: g.optional,
    confidence: round2(clamp01(confidence)),
    stage: stageFor(res.kind),
  };
  if (extra.splitFrom !== undefined) item.splitFrom = extra.splitFrom;
  return item;
}

const EXACTISH: ReadonlySet<MatchKind> = new Set<MatchKind>(["exact", "stripped", "singular"]);
/** Store sections that already mean "from a can" or are sold that way. */
const CANNED_OK: ReadonlySet<string> = new Set([
  "canned",
  "pantry",
  "beverages",
  "frozen",
  "seafood",
  "international",
]);

/** "salt and pepper": split only when no amount is given and every part is a known ingredient. */
function splitConjunction(noun: string): string[] {
  return noun
    .split(/\s+(?:and|&|\+)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

interface Deterministic {
  items: ParsedIngredient[];
  /** Headers and blank lines are not ingredients, so the model never sees them. */
  skipModel: boolean;
}

async function parseDeterministic(rawText: string, deps: ParserDeps): Promise<Deterministic> {
  const similarityThreshold = deps.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const g = parseGrammar(rawText);
  if (g.header || !g.noun) {
    return {
      skipModel: g.header || g.text === "",
      items: [
        {
          rawText,
          qty: g.qty,
          qtyMax: g.qtyMax,
          unit: g.unit,
          ingredientId: null,
          ingredientName: null,
          prepNote: joinPrep(g.prep),
          optional: g.optional,
          confidence: 0,
          stage: "grammar",
        },
      ],
    };
  }

  let whole = await resolveNoun(g.noun, deps.ontology, { similarityThreshold });
  // "1 (14 oz) can chopped tomatoes": a can means the canned version of a fresh ingredient.
  if (g.container === "can" && whole.match && !CANNED_OK.has(whole.match.category)) {
    const canned = await resolveNoun(`canned ${g.noun}`, deps.ontology, { similarityThreshold });
    if (canned.match && canned.match.category === "canned" && EXACTISH.has(canned.kind))
      whole = canned;
  }
  if (!EXACTISH.has(whole.kind) && (g.qty == null || g.distribute)) {
    const parts = splitConjunction(g.noun);
    if (parts.length >= 2) {
      const resolved = await Promise.all(
        parts.map((p) => resolveNoun(p, deps.ontology, { similarityThreshold })),
      );
      if (resolved.every((r) => r.match !== null && EXACTISH.has(r.kind))) {
        return {
          skipModel: false,
          items: resolved.map((r) =>
            buildItem(g, { ...r, kind: "alternative" }, similarityThreshold, {
              splitFrom: rawText,
              cap: 0.85,
            }),
          ),
        };
      }
    }
  }
  return { skipModel: false, items: [buildItem(g, whole, similarityThreshold)] };
}

// ---------------------------------------------------------------------------
// Model path
// ---------------------------------------------------------------------------

async function itemsFromLlm(
  rawText: string,
  items: readonly LlmItem[],
  deps: ParserDeps,
  categories: Map<string, IngredientCategory>,
): Promise<ParsedIngredient[]> {
  const similarityThreshold = deps.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const out: ParsedIngredient[] = [];
  // A replacement LlmParseClient need not sanitize; do it here so no client is trusted.
  const usable = items.map(sanitizeItem).filter((i) => i.ingredient);
  for (const item of usable) {
    const name = cleanPhrase(item.ingredient ?? "");
    if (!name) continue;
    const res = await resolveNoun(name, deps.ontology, { similarityThreshold });
    const matched = res.match !== null;
    if (!matched && item.category) categories.set(name, item.category);
    const p: ParsedIngredient = {
      rawText,
      qty: item.qty,
      qtyMax: item.qty_max,
      unit: item.unit,
      ingredientId: res.match?.ingredientId ?? null,
      ingredientName: res.match?.name ?? name,
      prepNote: item.prep,
      optional: item.optional,
      confidence: round2(
        matched ? Math.min(item.confidence, 0.95) : Math.min(item.confidence, 0.6),
      ),
      stage: "llm",
    };
    if (usable.length > 1) p.splitFrom = rawText;
    out.push(p);
  }
  return out;
}

/** A cached result may predate an ontology addition: look the name up again. */
async function refreshCached(
  rawText: string,
  cached: CachedParse,
  deps: ParserDeps,
): Promise<ParsedIngredient[]> {
  const similarityThreshold = deps.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const out: ParsedIngredient[] = [];
  for (const item of cached.items) {
    let { ingredientId, ingredientName, confidence } = item;
    if (ingredientId === null && ingredientName) {
      const res = await resolveNoun(ingredientName, deps.ontology, { similarityThreshold });
      if (res.match) {
        ingredientId = res.match.ingredientId;
        ingredientName = res.match.name;
        confidence = Math.max(confidence, 0.8);
      }
    }
    const next: ParsedIngredient = { ...item, rawText, ingredientId, ingredientName, confidence };
    if (cached.items.length > 1) next.splitFrom = rawText;
    else delete next.splitFrom;
    out.push(next);
  }
  return out;
}

/** Map with at most `limit` calls in flight; results keep input order. */
async function mapLimit<T, R>(
  list: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(list.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, worker));
  return out;
}

function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function applyLlm(
  rawTexts: readonly string[],
  results: ParsedIngredient[][],
  needs: readonly number[],
  deps: ParserDeps,
  categories: Map<string, IngredientCategory>,
): Promise<void> {
  const llm = deps.llm;
  if (!llm || needs.length === 0) return;
  const batchSize = deps.batchSize ?? LLM_BATCH_SIZE;

  // One entry per distinct normalized line.
  const keyOf = new Map<number, string>();
  const firstRaw = new Map<string, string>();
  for (const i of needs) {
    const raw = rawTexts[i] ?? "";
    const key = cacheKey(raw);
    keyOf.set(i, key);
    if (!firstRaw.has(key)) firstRaw.set(key, raw);
  }
  const keys = [...firstRaw.keys()];

  let cached: ReadonlyMap<string, CachedParse> = new Map();
  if (deps.cache) {
    const cache = deps.cache;
    await safely(deps, "parse cache read failed; treating every line as a miss", async () => {
      const rows = await cache.getMany(keys);
      // An answer written under an older prompt, an empty one included, is a miss: the prompt
      // that produced it has been replaced, and the line gets asked again.
      cached = new Map(
        [...rows].filter(([, row]) => isCurrentPromptVersion(row.promptVersion, llm.promptVersion)),
      );
    });
  }
  // An entry with no items means the model looked at the line and found no ingredient.
  const fresh = new Map<string, LlmItem[]>();
  const misses = keys.filter((k) => !cached.has(k));

  for (const batch of chunk(misses, batchSize)) {
    const lines = batch.map((k) => firstRaw.get(k) ?? k);
    let response: LlmBatchResult;
    try {
      response = await llm.parseBatch(lines);
    } catch (err) {
      const usage = (err as { usage?: LlmUsage }).usage;
      if (usage) await safely(deps, "onLlmRun failed", () => deps.onLlmRun?.(usage));
      await safely(deps, "onLlmError failed", () => deps.onLlmError?.(err, lines));
      continue;
    }
    const usage = response.usage;
    await safely(deps, "onLlmRun failed", () => deps.onLlmRun?.(usage));
    batch.forEach((key, idx) => {
      const items = response.byIndex.get(idx);
      // A missing index means the model skipped the line: not an answer, so not cached.
      if (items) fresh.set(key, [...items]);
    });
  }

  const toCache = new Map<string, CachedParse>();
  const parsedByKey = new Map<string, ParsedIngredient[]>();
  for (const key of keys) {
    const raw = firstRaw.get(key) ?? key;
    const hit = cached.get(key);
    if (hit) {
      parsedByKey.set(key, await refreshCached(raw, hit, deps));
      continue;
    }
    const items = fresh.get(key);
    if (!items) continue;
    const parsed = await itemsFromLlm(raw, items, deps, categories);
    parsedByKey.set(key, parsed);
    // An empty result is cached too, so a line the model rejects is not sent again.
    toCache.set(key, {
      items: parsed,
      source: "llm",
      model: llm.model,
      promptVersion: llm.promptVersion,
    });
  }
  if (toCache.size > 0 && deps.cache) {
    const cache = deps.cache;
    await safely(deps, "parse cache write failed", () => cache.putMany(toCache));
  }

  for (const i of needs) {
    const key = keyOf.get(i);
    const parsed = key ? parsedByKey.get(key) : undefined;
    if (!parsed || parsed.length === 0) continue;
    const raw = rawTexts[i] ?? "";
    results[i] = parsed.map((p) => {
      const next: ParsedIngredient = { ...p, rawText: raw };
      if (parsed.length > 1) next.splitFrom = raw;
      return next;
    });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse lines, keeping one result list per input line. A line that names several ingredients
 * ("salt and pepper") has several entries, each with `splitFrom` set to the original line.
 */
export async function parseLinesGrouped(
  rawTexts: readonly string[],
  deps: ParserDeps,
): Promise<ParsedIngredient[][]> {
  const threshold = deps.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const deterministic = await mapLimit(rawTexts, deps.concurrency ?? 8, (raw) =>
    parseDeterministic(raw, deps),
  );
  const results = deterministic.map((d) => d.items);

  const needs: number[] = [];
  deterministic.forEach((d, i) => {
    if (!d.skipModel && d.items.some((item) => item.confidence < threshold)) needs.push(i);
  });
  const categories = new Map<string, IngredientCategory>();
  await applyLlm(rawTexts, results, needs, deps, categories);

  if (deps.proposals) {
    const proposed = new Set<string>();
    for (let i = 0; i < results.length; i++) {
      for (const item of results[i] ?? []) {
        if (item.ingredientId !== null || !item.ingredientName || item.confidence === 0) continue;
        const key = item.ingredientName;
        if (proposed.has(key)) continue;
        proposed.add(key);
        const sink = deps.proposals;
        const proposal = {
          rawText: rawTexts[i] ?? item.rawText,
          proposedName: item.ingredientName,
          proposedCategory: categories.get(item.ingredientName) ?? null,
        };
        await safely(deps, `recording alias proposal "${item.ingredientName}" failed`, () =>
          sink.record(proposal),
        );
      }
    }
  }
  return results;
}

/** Parse lines into a flat list: one entry per ingredient, so a split line contributes several. */
export async function parseLines(
  rawTexts: readonly string[],
  deps: ParserDeps,
): Promise<ParsedIngredient[]> {
  return (await parseLinesGrouped(rawTexts, deps)).flat();
}

/** Parse one line. If it names several ingredients this returns the first (all carry `splitFrom`). */
export async function parseLine(rawText: string, deps: ParserDeps): Promise<ParsedIngredient> {
  const [items] = await parseLinesGrouped([rawText], deps);
  const first = items?.[0];
  if (first) return first;
  return {
    rawText,
    qty: null,
    unit: null,
    ingredientId: null,
    ingredientName: null,
    optional: false,
    confidence: 0,
    stage: "grammar",
  };
}
