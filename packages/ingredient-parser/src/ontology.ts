// In-memory ontology (WS03). Used by tests and the golden-set eval, and handy for a client that
// wants to parse offline. Trigram similarity matches PostgreSQL pg_trgm, so a result here is the
// result `match_ingredient_alias` gives in the database.

import type { OntologyEntry, OntologyMatch, OntologyStore, SimilarMatch } from "./lookup.ts";
import { setSimilarity, trigramSet } from "./normalize.ts";

export interface OntologySeed {
  ingredients: readonly (OntologyEntry & { plural?: string | null })[];
  /** `ingredientName` is the canonical `ingredients.name`. */
  aliases: readonly { ingredientName: string; alias: string }[];
}

interface AliasRecord {
  match: OntologyMatch;
  trigrams: Set<string>;
}

export class InMemoryOntology implements OntologyStore {
  private readonly byAlias = new Map<string, AliasRecord>();
  private readonly index = new Map<string, string[]>();

  constructor(seed: OntologySeed) {
    const byName = new Map<string, OntologyEntry>();
    for (const ing of seed.ingredients) byName.set(ing.name, ing);
    const add = (entry: OntologyEntry, alias: string): void => {
      if (this.byAlias.has(alias)) return;
      const trigrams = trigramSet(alias);
      this.byAlias.set(alias, {
        match: {
          ingredientId: entry.ingredientId,
          name: entry.name,
          category: entry.category,
          alias,
        },
        trigrams,
      });
      for (const t of trigrams) {
        const list = this.index.get(t);
        if (list) list.push(alias);
        else this.index.set(t, [alias]);
      }
    };
    for (const ing of seed.ingredients) {
      add(ing, ing.name);
      if (ing.plural) add(ing, ing.plural);
    }
    for (const row of seed.aliases) {
      const entry = byName.get(row.ingredientName);
      if (entry) add(entry, row.alias);
    }
  }

  get size(): number {
    return this.byAlias.size;
  }

  async findExact(keys: readonly string[]): Promise<ReadonlyMap<string, OntologyMatch>> {
    const out = new Map<string, OntologyMatch>();
    for (const key of keys) {
      const hit = this.byAlias.get(key);
      if (hit) out.set(key, hit.match);
    }
    return out;
  }

  async findSimilar(text: string, minSimilarity: number): Promise<SimilarMatch | null> {
    const query = trigramSet(text);
    if (query.size === 0) return null;
    const touched = new Set<string>();
    for (const t of query) for (const alias of this.index.get(t) ?? []) touched.add(alias);
    let best: SimilarMatch | null = null;
    for (const alias of touched) {
      const record = this.byAlias.get(alias);
      if (!record) continue;
      const similarity = setSimilarity(query, record.trigrams);
      if (similarity < minSimilarity) continue;
      if (
        !best ||
        similarity > best.similarity ||
        (similarity === best.similarity && alias < best.alias)
      ) {
        best = { ...record.match, similarity };
      }
    }
    return best;
  }
}
