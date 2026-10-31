// Fixture harness for buildList (WS05). A fixture is a small JSON file: recipes, the plan entries
// that use them, the pantry, and what the list must look like. Every bug a person reports about an
// amount becomes one more fixture here, without a line of test code.
//
// Fixtures name things instead of carrying uuids: an ingredient by its ontology name, a recipe or
// entry by a short key. The harness maps them to ids. `ontology.json` is a frozen snapshot of the
// seed rows the fixtures use (supabase/seed/ingredients.csv, with the same v5 ids), so a later
// ontology edit cannot silently change what these tests mean.
import { type Ingredient, IngredientSchema } from "../../ingredient.ts";
import { type BuildListInput, buildList } from "../aggregate.ts";
import type {
  BuildListOptions,
  GroceryListDraft,
  ListEntry,
  ListIngredientLine,
  ListRecipe,
  PantryEntry,
} from "../types.ts";
import ontologyRows from "./ontology.json";

export interface FixtureLine {
  text: string;
  qty: number | null;
  qtyMax?: number | null;
  unit: string | null;
  /** Ontology name, or null for a line the parser could not place. */
  ingredient: string | null;
  prep?: string | null;
  optional?: boolean;
  containerCount?: number | null;
  container?: string | null;
}

export interface FixtureRecipe {
  id: string;
  title: string;
  servings: number | null;
  deleted?: boolean;
  lines: FixtureLine[];
}

export interface FixtureEntry {
  id: string;
  recipe: string;
  servings: number;
  status?: "planned" | "cooked" | "skipped";
  date?: string;
  slot?: ListEntry["slot"];
}

export interface FixtureContribution {
  entry: string;
  qty: number | null;
  unit?: string | null;
  servings?: number;
}

export interface FixtureItem {
  name: string;
  qty?: number | null;
  unit?: string | null;
  section?: string;
  /** "pantry" when the pantry covers the item; null or absent means it is on the list. */
  excluded?: "pantry" | null;
  attention?: boolean;
  qualifiers?: string[];
  /** Fixture entry keys that contributed, in plan order. */
  entries?: string[];
  contributions?: FixtureContribution[];
  /** The rounding step, or null when none was applied. */
  rounding?: { from?: number; fromUnit?: string; to: number; toUnit: string } | null;
}

export interface ListFixture {
  description: string;
  recipes: FixtureRecipe[];
  entries: FixtureEntry[];
  pantry?: Array<{ ingredient: string; status: PantryEntry["status"] }>;
  options?: BuildListOptions;
  expect: {
    /** Exactly these items, in this order. Leave it out to check only the other expectations. */
    items?: FixtureItem[];
    needsAttentionCount?: number;
    skipped?: Array<{ entry: string; reason: string }>;
  };
}

export const ONTOLOGY: Ingredient[] = (ontologyRows as unknown[]).map((row) =>
  IngredientSchema.parse(row),
);
const BY_NAME = new Map(ONTOLOGY.map((ingredient) => [ingredient.name, ingredient]));
export const ONTOLOGY_BY_ID = new Map(ONTOLOGY.map((ingredient) => [ingredient.id, ingredient]));

export function ingredientNamed(name: string): Ingredient {
  const found = BY_NAME.get(name);
  if (!found) throw new Error(`fixture names an ingredient that is not in ontology.json: ${name}`);
  return found;
}

/** Maps readable keys to valid, stable uuids within one fixture run. */
export class IdMap {
  private readonly ids = new Map<string, string>();
  private readonly keys = new Map<string, string>();

  of(key: string): string {
    let id = this.ids.get(key);
    if (!id) {
      id = `00000000-0000-4000-8000-${(this.ids.size + 1).toString(16).padStart(12, "0")}`;
      this.ids.set(key, id);
      this.keys.set(id, key);
    }
    return id;
  }

  /** The fixture key behind an id, or the id itself when it was not made here. */
  keyOf(id: string): string {
    return this.keys.get(id) ?? id;
  }
}

export interface FixtureRun {
  input: BuildListInput;
  draft: GroceryListDraft;
  ids: IdMap;
}

function lineOf(recipe: FixtureRecipe, line: FixtureLine, position: number, ids: IdMap) {
  const row: ListIngredientLine = {
    id: ids.of(`line:${recipe.id}:${position}`),
    position,
    raw_text: line.text,
    qty: line.qty,
    qty_max: line.qtyMax ?? null,
    unit: line.unit,
    ingredient_id: line.ingredient ? ingredientNamed(line.ingredient).id : null,
    prep_note: line.prep ?? null,
    optional: line.optional ?? false,
    container_count: line.containerCount ?? null,
    container: line.container ?? null,
  };
  return row;
}

export function inputOf(fixture: ListFixture, ids = new IdMap()): BuildListInput {
  const recipes: ListRecipe[] = fixture.recipes.map((recipe) => ({
    id: ids.of(`recipe:${recipe.id}`),
    title: recipe.title,
    servings: recipe.servings,
    deleted_at: recipe.deleted ? "2026-10-30T00:00:00.000Z" : null,
    ingredients: recipe.lines.map((line, position) => lineOf(recipe, line, position, ids)),
  }));
  const entries: ListEntry[] = fixture.entries.map((entry, index) => ({
    id: ids.of(`entry:${entry.id}`),
    recipe_id: ids.of(`recipe:${entry.recipe}`),
    servings: entry.servings,
    status: entry.status ?? "planned",
    date: entry.date ?? `2026-11-${String(2 + index).padStart(2, "0")}`,
    slot: entry.slot ?? "dinner",
    position: 0,
  }));
  const pantry: PantryEntry[] = (fixture.pantry ?? []).map((row) => ({
    ingredient_id: ingredientNamed(row.ingredient).id,
    status: row.status,
  }));
  return {
    entries,
    recipes,
    ingredients: ONTOLOGY_BY_ID,
    pantry,
    ...(fixture.options ? { options: fixture.options } : {}),
  };
}

export function runFixture(fixture: ListFixture): FixtureRun {
  const ids = new IdMap();
  const input = inputOf(fixture, ids);
  return { input, draft: buildList(input), ids };
}
