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
