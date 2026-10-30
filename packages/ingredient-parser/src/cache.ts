// Parse cache (WS03): results keyed by normalized raw text, so a line is never sent to the model
// twice. The Postgres table is `ingredient_parse_cache`; this file holds the interface and an
// in-memory implementation. Only model results are cached: the grammar is cheaper than a lookup.

import type { ParsedIngredient } from "@mp/core";
import { cacheKey } from "./normalize.ts";

export { cacheKey };

export interface CachedParse {
  /** One entry per ingredient the line named. */
  items: ParsedIngredient[];
  source: "grammar" | "llm";
  model: string | null;
  promptVersion: string | null;
}

/** "ingredient-parse.v2" -> { name: "ingredient-parse", version: 2 }. Null when it has no version. */
function splitPromptVersion(
  id: string | null | undefined,
): { name: string; version: number } | null {
  const match = /^(.+)\.v(\d+)$/.exec(id ?? "");
  return match?.[1] && match[2] ? { name: match[1], version: Number(match[2]) } : null;
}

/**
 * True when a cached answer may be used under the current prompt: the same prompt at the same or
 * a newer version. An older version, a different prompt, or no recorded version is stale, so a
 * prompt change stops old answers (including "this line is not an ingredient") from living on.
 */
export function isCurrentPromptVersion(
  cached: string | null | undefined,
  current: string | null | undefined,
): boolean {
  if (cached === current) return true;
  const entry = splitPromptVersion(cached);
  const now = splitPromptVersion(current);
  return entry !== null && now !== null && entry.name === now.name && entry.version >= now.version;
}

export interface ParseCache {
  getMany(keys: readonly string[]): Promise<ReadonlyMap<string, CachedParse>>;
  putMany(entries: ReadonlyMap<string, CachedParse>): Promise<void>;
}

export class InMemoryParseCache implements ParseCache {
  private readonly store = new Map<string, CachedParse>();
  hits = 0;
  misses = 0;

  get size(): number {
    return this.store.size;
  }

  async getMany(keys: readonly string[]): Promise<ReadonlyMap<string, CachedParse>> {
    const out = new Map<string, CachedParse>();
    for (const key of keys) {
      const hit = this.store.get(key);
      if (hit) {
        this.hits++;
        out.set(key, hit);
      } else {
        this.misses++;
      }
    }
    return out;
  }

  async putMany(entries: ReadonlyMap<string, CachedParse>): Promise<void> {
    for (const [key, value] of entries) this.store.set(key, value);
  }

  /** For persisting between runs (the eval writes this to disk). */
  entries(): [string, CachedParse][] {
    return [...this.store.entries()];
  }

  load(entries: Iterable<[string, CachedParse]>): void {
    for (const [key, value] of entries) this.store.set(key, value);
  }
}
