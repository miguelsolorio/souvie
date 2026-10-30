// Ontology lookup stage (WS03): turn a noun phrase into an ingredient.
// Exact alias first (progressively dropping modifiers), then trigram similarity.

import { DROP_WORDS, NAME_FILLERS, PREP_ADVERBS, PREP_WORDS, TRAILING_FILLERS } from "./lexicon.ts";
import { singularizePhrase } from "./normalize.ts";

/** Trigram similarity at or above this counts as a match (docs/03-ai-design.md §5). */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.85;

export interface OntologyEntry {
  ingredientId: string;
  /** Canonical ingredient name. */
  name: string;
  category: string;
}

export interface OntologyMatch extends OntologyEntry {
  /** The alias text that matched. */
  alias: string;
}

export interface SimilarMatch extends OntologyMatch {
  similarity: number;
}

/**
 * Read access to the ontology. The Edge Function implements it over Postgres
 * (`ingredient_aliases`, `match_ingredient_alias`); evals and tests use `InMemoryOntology`.
 * Aliases include every ingredient's name and plural, all lowercase.
 */
export interface OntologyStore {
  findExact(keys: readonly string[]): Promise<ReadonlyMap<string, OntologyMatch>>;
  findSimilar(text: string, minSimilarity: number): Promise<SimilarMatch | null>;
}

export type MatchKind = "exact" | "stripped" | "singular" | "alternative" | "similar" | "none";

export interface Resolution {
  match: OntologyMatch | null;
  kind: MatchKind;
  similarity?: number;
  /** Words dropped from the front of the noun phrase to reach the match, in order. */
  strippedFront: string[];
  /** Name to show and propose when nothing matched: the noun phrase without modifiers. */
  name: string;
}

interface Candidate {
  text: string;
  front: string[];
  kind: "exact" | "stripped" | "singular";
}

export function isModifierWord(word: string): boolean {
  return DROP_WORDS.has(word) || PREP_WORDS.has(word) || PREP_ADVERBS.has(word);
}

function variants(text: string): string[] {
  const out = [text];
  const spaced = text.replace(/-/g, " ");
  if (spaced !== text) out.push(spaced);
  const bare = text.replace(/'/g, "");
  if (bare !== text) out.push(bare);
  return out;
}

/** Candidate spellings of a noun phrase, most specific first. */
export function candidatesFor(phrase: string): Candidate[] {
  const words = phrase.split(" ").filter(Boolean);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  const push = (text: string, front: string[], kind: Candidate["kind"]): void => {
    for (const v of variants(text.trim())) {
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push({ text: v, front, kind });
    }
  };

  let i = 0;
  while (words.length > 0) {
    const sub = words.slice(i);
    const front = words.slice(0, i);
    const base = i === 0 ? "exact" : "stripped";
    push(sub.join(" "), front, base);
    push(singularizePhrase(sub.join(" ")), front, "singular");
    let trimmed = sub;
    while (trimmed.length > 1 && TRAILING_FILLERS.has(trimmed[trimmed.length - 1] ?? "")) {
      trimmed = trimmed.slice(0, -1);
      push(trimmed.join(" "), front, "stripped");
      push(singularizePhrase(trimmed.join(" ")), front, "singular");
    }
    const lead = words[i];
    if (i < words.length - 1 && lead !== undefined && isModifierWord(lead)) i++;
    else break;
  }

  // Modifiers in the middle ("red bell large pepper"): drop them all as a last resort.
  const core = words.filter((w) => !isModifierWord(w));
  if (core.length > 0 && core.length < words.length) {
    const front = words.filter(isModifierWord);
    push(core.join(" "), front, "stripped");
    push(singularizePhrase(core.join(" ")), front, "singular");
  }
  return out;
}

/** The phrase with leading modifiers and trailing fillers removed: what an unknown is called. */
export function coreName(phrase: string): string {
  let words = phrase.split(" ").filter(Boolean);
  while (words.length > 1 && isModifierWord(words[0] ?? "")) words = words.slice(1);
  while (words.length > 1 && NAME_FILLERS.has(words[words.length - 1] ?? "")) {
    words = words.slice(0, -1);
  }
  return words.join(" ");
}

export interface ResolveOptions {
  similarityThreshold?: number;
}

/** Resolve a noun phrase against the ontology. */
export async function resolveNoun(
  noun: string,
  store: OntologyStore,
  options: ResolveOptions = {},
): Promise<Resolution> {
  const threshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const phrase = noun.trim();
  if (!phrase) return { match: null, kind: "none", strippedFront: [], name: "" };

  const alternatives = [phrase];
  if (/\sor\s/.test(phrase)) {
    const parts = phrase
      .split(/\s+or\s+/)
      .map((p) => p.trim())
      .filter(Boolean);
    // "chicken or vegetable broth": the first alternative borrows the shared noun.
    const first = parts[0];
    const second = parts[1];
    if (parts.length === 2 && first && second && !first.includes(" ") && second.includes(" ")) {
      const shared = second.split(" ").pop();
      if (shared) alternatives.push(`${first} ${shared}`);
    }
    alternatives.push(...parts);
  }
  const perAlt = alternatives.map((alt) => candidatesFor(alt));

  const keys = new Set<string>();
  for (const list of perAlt) for (const c of list) keys.add(c.text);
  const found = await store.findExact([...keys]);

  for (let a = 0; a < perAlt.length; a++) {
    for (const c of perAlt[a] ?? []) {
      const hit = found.get(c.text);
      if (hit) {
        const kind: MatchKind = a > 0 ? "alternative" : c.kind;
        return { match: hit, kind, strippedFront: c.front, name: hit.name };
      }
    }
  }

  // With "or" alternatives, similarity probes the first alternative, not the whole phrase.
  const first = alternatives.length > 1 ? (alternatives[1] ?? phrase) : phrase;
  const core = coreName(first);
  const probe = singularizePhrase(core);
  for (const text of probe === core ? [core] : [core, probe]) {
    const similar = await store.findSimilar(text, threshold);
    if (similar) {
      return {
        match: similar,
        kind: "similar",
        similarity: similar.similarity,
        strippedFront: [],
        name: similar.name,
      };
    }
  }
  return { match: null, kind: "none", strippedFront: [], name: core };
}
