// Two filter rules that need a database and the real ontology (WS06 fix rounds):
//   * a recipe with no ingredient lines is excluded whenever the household has an allergy or a diet,
//     because both engines look for a violating line and would otherwise pass it;
//   * a never-food is judged by the canonical ingredient when the line is parsed, so "olive" does
//     not exclude olive oil and "pepper" does not exclude black pepper.
// Each case runs the real SQL on PGlite and the TypeScript engine on the same lines. The ontology is
// the shipped seed (supabase/seed/10_ingredients.sql, loaded the way `supabase db reset` loads it),
// not a hand-made fixture: the seed aliases "pepper" to black pepper, and a fixture without that
// alias hid a bug.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchCandidates } from "./candidates.ts";
import { buildCandidateQuery, buildFilterSpec, findViolations } from "./filters.ts";
import { FIXTURE_HOUSEHOLD, FIXTURE_USER } from "./testing/corpus.ts";
import { createTestDb, insertHousehold, insertRecipe, type TestDb } from "./testing/db.ts";

const SEED = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "seed",
  "10_ingredients.sql",
);

let t: TestDb;
/** Names of the ontology's pantry staples, read from the seed that was loaded. */
let staples = new Set<string>();

// [raw text, canonical ingredient or null for a line the parser did not resolve]
const RECIPES: Record<string, [string, string | null][]> = {
  "Mystery stew": [],
  "Plain rice bowl": [["2 cups cooked rice", "white rice"]],
  "Olive tapenade pasta": [["1 cup green olives", "green olives"]],
  "Garlic noodles": [["3 tbsp olive oil", "olive oil"]],
  "Bell pepper stir fry": [["2 bell peppers", "bell pepper"]],
  "Pepper steak": [["1 tsp black pepper", "black pepper"]],
  "Mystery olive salad": [["1 jar mixed olives", null]],
  "Chicken skillet": [["1 lb chicken breast", "chicken breast"]],
  "Mystery pepper dip": [["1 jar roasted peppers", null]],
};

interface Household {
  allergies?: string[];
  diets?: string[];
  dislikes?: string[];
}

beforeAll(async () => {
  t = await createTestDb();
  await insertHousehold(t, { userId: FIXTURE_USER, householdId: FIXTURE_HOUSEHOLD });
  await t.exec(readFileSync(SEED, "utf8"));
  const names = new Set<string>();
  for (const lines of Object.values(RECIPES)) {
    for (const [, name] of lines) if (name) names.add(name);
  }
  const ids = new Map(
    (
      await t.query<{ id: string; name: string }>(
        "select id, name from public.ingredients where name = any($1::text[])",
        [[...names]],
      )
    ).map((row) => [row.name, row.id]),
  );
  staples = new Set(
    (
      await t.query<{ name: string }>("select name from public.ingredients where is_staple_default")
    ).map((row) => row.name),
  );
  for (const [title, lines] of Object.entries(RECIPES)) {
    await insertRecipe(
      t,
      {
        title,
        householdId: FIXTURE_HOUSEHOLD,
        lines: lines.map(([rawText, name]) => ({ rawText, name })),
      },
      ids,
    );
  }
}, 60_000);

afterAll(async () => {
  await t.close();
});

function specFor(input: Household) {
  return buildFilterSpec({
    allergies: input.allergies ?? [],
    diets: input.diets ?? [],
    dislikes: input.dislikes ?? [],
  });
}

/** What the SQL engine returns (after the TypeScript re-check) and how many it had to drop. */
async function kept(input: Household): Promise<{ titles: Set<string>; dropped: number }> {
  const { candidates, dropped } = await fetchCandidates(t.runner, {
    householdId: FIXTURE_HOUSEHOLD,
    spec: specFor(input),
    tasteEmbedding: null,
    cuisines: [],
    warn: () => {},
  });
  return { titles: new Set(candidates.map((c) => c.title)), dropped: dropped.length };
}

/** What the SQL query alone returns, before the TypeScript re-check can drop anything. */
async function sqlOnly(input: Household): Promise<Set<string>> {
  const query = buildCandidateQuery({
    householdId: FIXTURE_HOUSEHOLD,
    spec: specFor(input),
    tasteEmbedding: null,
    limit: 200,
  });
  const rows = await t.query<{ title: string }>(query.text, query.params);
  return new Set(rows.map((row) => row.title));
}

/** The recipes the TypeScript engine alone flags, from the same lines. */
function flagged(input: Household): string[] {
  const spec = specFor(input);
  const titles: string[] = [];
  for (const [title, lines] of Object.entries(RECIPES)) {
    const reasons = findViolations(
      {
        tags: [],
        totalMin: null,
        lines: lines.map(([rawText, name]) => ({
          rawText,
          ingredientName: name,
          ingredientId: name ? `id-${name}` : null,
          category: null,
          staple: name ? staples.has(name) : false,
        })),
      },
      spec,
    );
    if (reasons.length > 0) titles.push(title);
  }
  return titles.sort();
}

describe("a recipe with no ingredient lines", () => {
  it("is excluded when the household has an allergy, in SQL and in TypeScript", async () => {
    const household = { allergies: ["shellfish"] };
    const { titles } = await kept(household);
    expect(titles.has("Mystery stew")).toBe(false);
    expect(titles.has("Plain rice bowl")).toBe(true);
    expect(flagged(household)).toEqual(["Mystery stew"]);
    // The SQL excludes it by itself: the re-check is not what dropped it.
    const fromSql = await sqlOnly(household);
    expect(fromSql.has("Mystery stew")).toBe(false);
    expect(fromSql.has("Plain rice bowl")).toBe(true);
  });

  it("is excluded when the household has a diet that filters ingredients", async () => {
    for (const diet of ["vegetarian", "vegan", "gluten_free", "halal"]) {
      const household = { diets: [diet] };
      expect((await kept(household)).titles.has("Mystery stew"), diet).toBe(false);
      expect((await sqlOnly(household)).has("Mystery stew"), `${diet} (SQL alone)`).toBe(false);
      expect(flagged(household), diet).toContain("Mystery stew");
    }
  });

  it("stays for a diet that filters nothing (keto, paleo, low carb, omnivore)", async () => {
    for (const diet of ["keto", "paleo", "low_carb", "omnivore"]) {
      const household = { diets: [diet] };
      expect(specFor(household).requireIngredientLines, diet).toBe(false);
      expect((await kept(household)).titles.has("Mystery stew"), diet).toBe(true);
      expect((await sqlOnly(household)).has("Mystery stew"), `${diet} (SQL alone)`).toBe(true);
      expect(flagged(household), diet).not.toContain("Mystery stew");
    }
    // One diet with a rule next to one without is enough.
    expect(specFor({ diets: ["keto", "vegetarian"] }).requireIngredientLines).toBe(true);
  });

  it("stays when the household has neither, and the reason names the missing lines", async () => {
    expect((await kept({})).titles.has("Mystery stew")).toBe(true);
    expect((await sqlOnly({})).has("Mystery stew")).toBe(true);
    expect(flagged({})).toEqual([]);
    expect(specFor({}).requireIngredientLines).toBe(false);
    const spec = specFor({ allergies: ["egg"] });
    expect(spec.requireIngredientLines).toBe(true);
    expect(findViolations({ tags: [], totalMin: null, lines: [] }, spec).join()).toMatch(
      /no ingredient lines/,
    );
  });
});

describe("never-foods are judged by the canonical ingredient when the line is parsed", () => {
  it('"olive" excludes olives and an unparsed olive line, not olive oil', async () => {
    const household = { dislikes: ["olive"] };
    const { titles, dropped } = await kept(household);
    expect(dropped).toBe(0);
    expect(titles.has("Olive tapenade pasta")).toBe(false);
    expect(titles.has("Mystery olive salad")).toBe(false);
    expect(titles.has("Garlic noodles")).toBe(true);
    expect(flagged(household)).toEqual(["Mystery olive salad", "Olive tapenade pasta"]);
    const fromSql = await sqlOnly(household);
    expect(fromSql.has("Olive tapenade pasta")).toBe(false);
    expect(fromSql.has("Mystery olive salad")).toBe(false);
    expect(fromSql.has("Garlic noodles")).toBe(true);
  });

  it('"pepper" excludes bell peppers and an unparsed pepper line, not black pepper', async () => {
    const household = { dislikes: ["pepper"] };
    const { titles, dropped } = await kept(household);
    expect(dropped).toBe(0);
    expect(titles.has("Bell pepper stir fry")).toBe(false);
    expect(titles.has("Mystery pepper dip")).toBe(false);
    expect(titles.has("Pepper steak")).toBe(true);
    expect(flagged(household)).toEqual(["Bell pepper stir fry", "Mystery pepper dip"]);
    const fromSql = await sqlOnly(household);
    expect(fromSql.has("Bell pepper stir fry")).toBe(false);
    expect(fromSql.has("Mystery pepper dip")).toBe(false);
    expect(fromSql.has("Pepper steak")).toBe(true);
  });

  it("with the real seed, an alias of a staple does not exclude it (pepper is an alias of black pepper)", async () => {
    const alias = await t.query<{ name: string; is_staple_default: boolean }>(
      `select i.name, i.is_staple_default
         from public.ingredient_aliases a join public.ingredients i on i.id = a.ingredient_id
        where a.alias = 'pepper'`,
    );
    // The data the bug depended on: the seed maps the word to a staple.
    expect(alias).toEqual([{ name: "black pepper", is_staple_default: true }]);
    const household = { dislikes: ["pepper"] };
    const all = Object.keys(RECIPES);
    const expected = all.filter(
      (title) => !["Bell pepper stir fry", "Mystery pepper dip"].includes(title),
    );
    // Nothing else goes: the word no longer removes every recipe that has black pepper in it.
    expect([...(await kept(household)).titles].sort()).toEqual(expected.sort());
    expect([...(await sqlOnly(household))].sort()).toEqual(expected.sort());
  });

  it("an alias of an ingredient that is not a staple still excludes it", async () => {
    // The seed aliases "olives" to green olives.
    const household = { dislikes: ["olives"] };
    const { titles } = await kept(household);
    expect(titles.has("Olive tapenade pasta")).toBe(false);
    expect(titles.has("Garlic noodles")).toBe(true);
    expect((await sqlOnly(household)).has("Olive tapenade pasta")).toBe(false);
  });

  it("naming the staple itself excludes it", async () => {
    for (const [dislike, title] of [
      ["olive oil", "Garlic noodles"],
      ["black pepper", "Pepper steak"],
    ] as const) {
      const household = { dislikes: [dislike] };
      expect((await kept(household)).titles.has(title), dislike).toBe(false);
      expect(flagged(household), dislike).toContain(title);
    }
  });

  it("still excludes a kind of the food: chicken for chicken breast", async () => {
    const household = { dislikes: ["chicken"] };
    expect((await kept(household)).titles.has("Chicken skillet")).toBe(false);
    expect(flagged(household)).toContain("Chicken skillet");
  });
});
