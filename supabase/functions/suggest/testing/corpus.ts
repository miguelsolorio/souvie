// Test harness only (WS06): the shared recipe corpus (packages/llm/evals/suggest/fixtures/
// corpus.json) loaded into a TestDb, and the ten household fixtures. The unit tests and the
// `pnpm eval suggest` run use the same data.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProfilePreferences } from "../../../../packages/core/src/index.ts";
import { insertHousehold, insertIngredients, insertRecipe, type TestDb } from "./db.ts";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "packages",
  "llm",
  "evals",
  "suggest",
  "fixtures",
);

export interface CorpusRecipe {
  key: string;
  title: string;
  cuisine: string | null;
  tags: string[];
  prepMin: number | null;
  cookMin: number | null;
  owner: "household" | "other" | "catalog";
  deleted: boolean;
  /** [rawText, ontology name or null, truth for an unparsed line] */
  lines: [string, string | null, string?][];
  labels: { contains: string[]; breaks: string[] };
}

export interface Corpus {
  ingredients: { name: string; category: string; plural?: string }[];
  recipes: CorpusRecipe[];
}

export interface HouseholdFixture {
  name: string;
  description: string;
  preferences: ProfilePreferences;
  expect: { minCandidates: number; mustExclude: string[]; mustInclude: string[] };
}

export function readCorpus(): Corpus {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, "corpus.json"), "utf8")) as Corpus;
}

export function readHouseholdFixtures(): HouseholdFixture[] {
  return readdirSync(FIXTURES_DIR)
    .filter((file) => /^household-\d+-.*\.json$/.test(file))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8")) as HouseholdFixture);
}

export const FIXTURE_USER = "a1111111-1111-4111-8111-111111111111";
export const FIXTURE_HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
export const OTHER_USER = "b2222222-2222-4222-8222-222222222222";
export const OTHER_HOUSEHOLD = "0b000000-0000-4000-8000-00000000000b";

export interface LoadedCorpus {
  /** key -> recipe id */
  ids: Map<string, string>;
  /** recipe id -> corpus recipe */
  byId: Map<string, CorpusRecipe>;
  ingredientIds: Map<string, string>;
}

/** Creates the fixture household, another household, the ontology subset, and every recipe. */
export async function loadCorpus(
  t: TestDb,
  options: { embeddings?: (recipe: CorpusRecipe) => number[] | null } = {},
): Promise<LoadedCorpus> {
  const corpus = readCorpus();
  await insertHousehold(t, {
    userId: FIXTURE_USER,
    householdId: FIXTURE_HOUSEHOLD,
    name: "Fixture House",
  });
  await insertHousehold(t, {
    userId: OTHER_USER,
    householdId: OTHER_HOUSEHOLD,
    name: "Other House",
  });
  const ingredientIds = await insertIngredients(t, corpus.ingredients);

  const ids = new Map<string, string>();
  const byId = new Map<string, CorpusRecipe>();
  for (const recipe of corpus.recipes) {
    const householdId =
      recipe.owner === "household"
        ? FIXTURE_HOUSEHOLD
        : recipe.owner === "other"
          ? OTHER_HOUSEHOLD
          : null;
    const id = await insertRecipe(
      t,
      {
        title: recipe.title,
        householdId,
        cuisine: recipe.cuisine,
        tags: recipe.tags,
        prepMin: recipe.prepMin,
        cookMin: recipe.cookMin,
        embedding: options.embeddings?.(recipe) ?? null,
        deletedAt: recipe.deleted ? new Date().toISOString() : null,
        lines: recipe.lines.map(([rawText, name]) => ({ rawText, name })),
      },
      ingredientIds,
    );
    ids.set(recipe.key, id);
    byId.set(id, recipe);
  }
  return { ids, byId, ingredientIds };
}
