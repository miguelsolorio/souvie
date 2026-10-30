// Supabase-backed implementations of the parser's ports (WS03).
// Tables: ingredients, ingredient_aliases, ingredient_parse_cache, ingredient_alias_proposals
// (this workstream), ai_runs (WS02), recipes and recipe_ingredients (WS02).
//
// Type-only import of supabase-js: the runtime import lives in client.ts so tests can mock it.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedIngredient } from "../../../packages/core/src/index.ts";
import type {
  AliasProposal,
  CachedParse,
  LlmUsage,
  OntologyMatch,
  OntologyStore,
  ParseCache,
  ProposalSink,
  SimilarMatch,
} from "../../../packages/ingredient-parser/src/index.ts";

const CHUNK = 60;

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

type EmbeddedIngredient = { name: string; category: string };

function oneIngredient(value: unknown): EmbeddedIngredient | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (v && typeof v === "object" && "name" in v && "category" in v) return v as EmbeddedIngredient;
  return null;
}

/** Ontology reads through the service role. Lookups are remembered for the life of the request. */
export class SupabaseOntologyStore implements OntologyStore {
  private readonly memo = new Map<string, OntologyMatch | null>();
  private readonly byId = new Map<string, EmbeddedIngredient>();

  constructor(private readonly db: SupabaseClient) {}

  async findExact(keys: readonly string[]): Promise<ReadonlyMap<string, OntologyMatch>> {
    const out = new Map<string, OntologyMatch>();
    const todo: string[] = [];
    for (const key of keys) {
      if (!this.memo.has(key)) todo.push(key);
      else {
        const hit = this.memo.get(key);
        if (hit) out.set(key, hit);
      }
    }
    for (const part of chunks([...new Set(todo)], CHUNK)) {
      const { data, error } = await this.db
        .from("ingredient_aliases")
        .select("alias, ingredient_id, ingredients(name, category)")
        .in("alias", part);
      if (error) throw new Error(`ingredient_aliases lookup failed: ${error.message}`);
      const found = new Set<string>();
      for (const row of data ?? []) {
        const ing = oneIngredient((row as { ingredients?: unknown }).ingredients);
        if (!ing) continue;
        const alias = String((row as { alias: string }).alias);
        const match: OntologyMatch = {
          ingredientId: String((row as { ingredient_id: string }).ingredient_id),
          name: ing.name,
          category: ing.category,
          alias,
        };
        found.add(alias);
        this.memo.set(alias, match);
        out.set(alias, match);
      }
      for (const key of part) if (!found.has(key)) this.memo.set(key, null);
    }
    return out;
  }

  async findSimilar(text: string, minSimilarity: number): Promise<SimilarMatch | null> {
    const { data, error } = await this.db.rpc("match_ingredient_alias", {
      query: text,
      min_similarity: minSimilarity,
      max_results: 1,
    });
    if (error) throw new Error(`match_ingredient_alias failed: ${error.message}`);
    const row = (
      data as { ingredient_id: string; alias: string; similarity: number }[] | null
    )?.[0];
    if (!row) return null;
    let ing = this.byId.get(row.ingredient_id);
    if (!ing) {
      const res = await this.db
        .from("ingredients")
        .select("name, category")
        .eq("id", row.ingredient_id)
        .maybeSingle();
      if (res.error) throw new Error(`ingredients lookup failed: ${res.error.message}`);
      const found = oneIngredient(res.data);
      if (!found) return null;
      ing = found;
      this.byId.set(row.ingredient_id, ing);
    }
    return {
      ingredientId: row.ingredient_id,
      name: ing.name,
      category: ing.category,
      alias: row.alias,
      similarity: Number(row.similarity),
    };
  }
}

function isCachedParse(value: unknown): value is { items: ParsedIngredient[] } {
  if (!value || typeof value !== "object") return false;
  const items = (value as { items?: unknown }).items;
  return (
    Array.isArray(items) &&
    items.every(
      (i) =>
        i &&
        typeof i === "object" &&
        typeof (i as { rawText?: unknown }).rawText === "string" &&
        typeof (i as { confidence?: unknown }).confidence === "number",
    )
  );
}

/** `ingredient_parse_cache` through the service role. `result` is `{ "items": ParsedIngredient[] }`. */
export class SupabaseParseCache implements ParseCache {
  constructor(private readonly db: SupabaseClient) {}

  async getMany(keys: readonly string[]): Promise<ReadonlyMap<string, CachedParse>> {
    const out = new Map<string, CachedParse>();
    for (const part of chunks([...new Set(keys)], CHUNK)) {
      const { data, error } = await this.db
        .from("ingredient_parse_cache")
        .select("normalized_text, result, source, model, prompt_version")
        .in("normalized_text", part);
      if (error) throw new Error(`ingredient_parse_cache read failed: ${error.message}`);
      for (const row of data ?? []) {
        if (!isCachedParse(row.result)) continue;
        out.set(String(row.normalized_text), {
          items: row.result.items,
          source: row.source === "grammar" ? "grammar" : "llm",
          model: (row.model as string | null) ?? null,
          promptVersion: (row.prompt_version as string | null) ?? null,
        });
      }
    }
    return out;
  }

  async putMany(entries: ReadonlyMap<string, CachedParse>): Promise<void> {
    const rows = [...entries].map(([normalized_text, v]) => ({
      normalized_text,
      result: { items: v.items },
      source: v.source,
      model: v.model,
      prompt_version: v.promptVersion,
    }));
    for (const part of chunks(rows, 100)) {
      const { error } = await this.db
        .from("ingredient_parse_cache")
        .upsert(part, { onConflict: "normalized_text" });
      if (error) throw new Error(`ingredient_parse_cache write failed: ${error.message}`);
    }
  }
}

/** Unknown names go to `ingredient_alias_proposals` through `record_ingredient_alias_proposal`. */
export class SupabaseProposalSink implements ProposalSink {
  constructor(
    private readonly db: SupabaseClient,
    private readonly householdId: string | null,
  ) {}

  async record(p: AliasProposal): Promise<void> {
    const { error } = await this.db.rpc("record_ingredient_alias_proposal", {
      p_raw_text: p.rawText,
      p_proposed_name: p.proposedName,
      p_proposed_category: p.proposedCategory,
      p_household_id: this.householdId,
    });
    if (error) throw new Error(`record_ingredient_alias_proposal failed: ${error.message}`);
  }
}

/** One `ai_runs` row per model call (R3). The table arrives with WS02; until then this logs and moves on. */
export async function recordAiRun(
  db: SupabaseClient,
  usage: LlmUsage,
  costUsd: number,
  householdId: string | null,
): Promise<void> {
  const { error } = await db.from("ai_runs").insert({
    household_id: householdId,
    kind: "parse_ingredients",
    model: usage.model,
    prompt_version: usage.promptVersion,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cost_usd: costUsd,
    latency_ms: usage.latencyMs,
    ok: usage.ok,
    error: usage.error ?? null,
  });
  if (error) console.warn(`ai_runs insert skipped: ${error.message}`);
}

// ---------------------------------------------------------------------------
// recipe_ingredients (owned by WS02), written as the signed-in user so RLS applies
// ---------------------------------------------------------------------------

export interface RecipeIngredientRow {
  id: string;
  position: number;
  groupName: string | null;
  rawText: string;
}

export interface RowValues {
  /** The amount; the lower bound of a range. */
  qty: number | null;
  /** The upper bound of a range, else null. */
  qty_max: number | null;
  unit: string | null;
  ingredient_id: string | null;
  prep_note: string | null;
  optional: boolean;
  parse_confidence: number;
}

export interface RowUpdate extends RowValues {
  id: string;
}

export interface RowInsert extends RowValues {
  recipe_id: string;
  position: number;
  group_name: string | null;
  raw_text: string;
}

export interface RecipeStore {
  /** Unparsed rows of a recipe the caller can see, or null when the recipe is not visible. */
  load(
    authHeader: string,
    recipeId: string,
  ): Promise<{ householdId: string | null; rows: RecipeIngredientRow[] } | null>;
  save(
    authHeader: string,
    recipeId: string,
    updates: RowUpdate[],
    inserts: RowInsert[],
  ): Promise<void>;
}

export class SupabaseRecipeStore implements RecipeStore {
  constructor(private readonly userClient: (authHeader: string) => SupabaseClient) {}

  async load(authHeader: string, recipeId: string) {
    const db = this.userClient(authHeader);
    const recipe = await db
      .from("recipes")
      .select("id, household_id")
      .eq("id", recipeId)
      .maybeSingle();
    if (recipe.error) throw new Error(`recipes read failed: ${recipe.error.message}`);
    if (!recipe.data) return null;
    const rows = await db
      .from("recipe_ingredients")
      .select("id, position, group_name, raw_text")
      .eq("recipe_id", recipeId)
      .is("parse_confidence", null)
      .order("position", { ascending: true });
    if (rows.error) throw new Error(`recipe_ingredients read failed: ${rows.error.message}`);
    return {
      householdId: (recipe.data.household_id as string | null) ?? null,
      rows: (rows.data ?? []).map((r) => ({
        id: String(r.id),
        position: Number(r.position),
        groupName: (r.group_name as string | null) ?? null,
        rawText: String(r.raw_text),
      })),
    };
  }

  async save(
    authHeader: string,
    _recipeId: string,
    updates: RowUpdate[],
    inserts: RowInsert[],
  ): Promise<void> {
    const db = this.userClient(authHeader);
    for (const part of chunks(updates, 10)) {
      const results = await Promise.all(
        part.map(({ id, ...values }) => db.from("recipe_ingredients").update(values).eq("id", id)),
      );
      for (const r of results)
        if (r.error) throw new Error(`recipe_ingredients update failed: ${r.error.message}`);
    }
    if (inserts.length > 0) {
      const { error } = await db.from("recipe_ingredients").insert(inserts);
      if (error) throw new Error(`recipe_ingredients insert failed: ${error.message}`);
    }
  }
}
