// WS06 criterion 6: the filter builder and the SQL it builds. The unit tests need no database. The
// database tests run the real query on PGlite (see testing/db.ts for what that stands in for)
// against the shared corpus, and fail if any candidate breaks a household's rules.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALLERGENS, DIETS, ENFORCED_DIETS } from "../../../packages/core/src/index.ts";
import { fetchCandidates, MAX_CANDIDATES } from "./candidates.ts";
import {
  ALLERGEN_PATTERNS,
  buildCandidateQuery,
  buildFilterSpec,
  FilterError,
  filterInputFromPreferences,
  findViolations,
  NEVER_MATCHES,
  NON_DINNER_TAGS,
  neverFoodPattern,
  toJsPattern,
} from "./filters.ts";
import {
  FIXTURE_HOUSEHOLD,
  type LoadedCorpus,
  loadCorpus,
  readHouseholdFixtures,
} from "./testing/corpus.ts";
import { createTestDb, type TestDb } from "./testing/db.ts";
import { oracleViolations } from "./testing/oracle.ts";

describe("buildFilterSpec", () => {
  it("has a rule for every allergen and every enforced diet", () => {
    for (const allergen of ALLERGENS) {
      expect(ALLERGEN_PATTERNS[allergen].length, allergen).toBeGreaterThan(0);
    }
    for (const diet of ENFORCED_DIETS) {
      const spec = buildFilterSpec({ allergies: [], diets: [diet], dislikes: [] });
      expect(spec.textPattern, diet).not.toBe(NEVER_MATCHES);
    }
  });

  it("matches nothing for an unrestricted household, except non-dinner tags", () => {
    const spec = buildFilterSpec({ allergies: [], diets: [], dislikes: [] });
    expect(spec.textPattern).toBe(NEVER_MATCHES);
    expect(spec.neverPattern).toBe(NEVER_MATCHES);
    expect(spec.categoryRuleCategories).toEqual([]);
    expect(spec.excludedTags.sort()).toEqual([...NON_DINNER_TAGS].sort());
    expect(spec.maxMinutes).toBeNull();
  });

  it("keeps the diet tag conflicts but drops the not-a-dinner tags for another slot", () => {
    const plain = buildFilterSpec({ allergies: [], diets: [], dislikes: [], dinnerOnly: false });
    expect(plain.excludedTags).toEqual([]);
    const vegan = buildFilterSpec({
      allergies: [],
      diets: ["vegan"],
      dislikes: [],
      dinnerOnly: false,
    });
    expect(vegan.excludedTags).toContain("dairy");
    expect(vegan.excludedTags).not.toContain("dessert");
    // The default and an explicit true both leave dinner-only on.
    expect(
      buildFilterSpec({ allergies: [], diets: [], dislikes: [], dinnerOnly: true }).excludedTags,
    ).toContain("dessert");
  });

  it("fails closed on an allergen or diet it has no rule for", () => {
    expect(() => buildFilterSpec({ allergies: ["shellfsh"], diets: [], dislikes: [] })).toThrow(
      FilterError,
    );
    expect(() => buildFilterSpec({ allergies: ["gluten"], diets: [], dislikes: [] })).toThrow(
      /unknown allergen/,
    );
    expect(() => buildFilterSpec({ allergies: [], diets: ["carnivore"], dislikes: [] })).toThrow(
      /unknown diet/,
    );
  });

  it("treats the diets that only steer taste as no rule", () => {
    for (const diet of DIETS.filter((d) => !ENFORCED_DIETS.includes(d))) {
      const spec = buildFilterSpec({ allergies: [], diets: [diet], dislikes: [] });
      expect(spec.textPattern, diet).toBe(NEVER_MATCHES);
    }
  });

  it("unions allergies and diets across members and keeps the requester's tastes", () => {
    const input = filterInputFromPreferences(
      { allergies: ["milk"], diets: ["vegetarian"], dislikes: ["cilantro"], weeknight_minutes: 30 },
      [
        {
          allergies: ["peanut", "milk"],
          diets: ["halal"],
          dislikes: ["olives"],
          weeknight_minutes: 90,
        },
      ],
    );
    expect([...input.allergies].sort()).toEqual(["milk", "peanut"]);
    expect([...input.diets].sort()).toEqual(["halal", "vegetarian"]);
    expect(input.dislikes).toEqual(["cilantro"]);
    expect(input.weeknightMinutes).toBe(30);
  });

  it("ignores one letter never-foods and normalizes the rest", () => {
    const spec = buildFilterSpec({
      allergies: [],
      diets: [],
      dislikes: ["a", "  Blue   Cheese ", "blue cheese"],
    });
    expect(spec.neverTerms).toEqual(["blue cheese"]);
  });

  it("escapes a never-food so it cannot become pattern syntax", () => {
    expect(neverFoodPattern("a.b")).toContain("a\\.b");
    const spec = buildFilterSpec({ allergies: [], diets: [], dislikes: ["(x+)+$"] });
    expect(() => toJsPattern(spec.neverPattern)).not.toThrow();
    expect(toJsPattern(spec.neverPattern).test("xxxxxxxxxxxxxxx!")).toBe(false);
  });
});

describe("buildCandidateQuery", () => {
  const spec = buildFilterSpec({
    allergies: ["shellfish"],
    diets: ["vegetarian"],
    dislikes: ["'; drop table recipes; --"],
    weeknightMinutes: 40,
  });
  const query = buildCandidateQuery({
    householdId: FIXTURE_HOUSEHOLD,
    spec,
    tasteEmbedding: null,
    limit: 200,
  });

  it("takes thirteen parameters and never writes a value into the SQL text", () => {
    expect(query.params).toHaveLength(13);
    expect(query.text).not.toContain("shrimp");
    expect(query.text).not.toContain("drop table");
    expect(query.text).not.toContain(FIXTURE_HOUSEHOLD);
    for (let i = 1; i <= 13; i++) expect(query.text).toContain(`$${i}`);
  });

  it("reads only the household's recipes and the catalog, and never deleted ones", () => {
    expect(query.text).toMatch(/r\.deleted_at is null/);
    expect(query.text).toMatch(/r\.household_id = \$1::uuid or r\.visibility = 'catalog'/);
  });

  it("scans the raw text of every line, so unparsed lines cannot slip through", () => {
    expect(query.text).toMatch(/ri\.raw_text ~\* \$5::text/);
    expect(query.text).toMatch(/left join public\.ingredients i/);
  });

  it("passes the time limit and the filters as parameters", () => {
    expect(query.params[0]).toBe(FIXTURE_HOUSEHOLD);
    expect(query.params[2]).toBe(40);
    expect(query.params[4]).toBe(spec.textPattern);
    expect(query.params[5]).toEqual(spec.neverTerms);
    expect(query.params[10]).toBe(200);
    // This household has an allergy and a diet, so recipes must list ingredients. No audit list.
    expect(query.params[11]).toBe(true);
    expect(query.params[12]).toBeNull();
  });
});

describe("findViolations", () => {
  const shellfish = buildFilterSpec({ allergies: ["shellfish"], diets: [], dislikes: [] });

  it("flags a shellfish word in the raw text of an unresolved line", () => {
    const reasons = findViolations(
      {
        tags: ["dinner"],
        totalMin: 20,
        lines: [{ rawText: "1 lb jumbo prawns", ingredientName: null, category: null }],
      },
      shellfish,
    );
    expect(reasons.join(" ")).toMatch(/prawns/);
  });

  it("flags a parsed ingredient name", () => {
    const reasons = findViolations(
      {
        tags: [],
        totalMin: null,
        lines: [{ rawText: "a pound of seafood", ingredientName: "shrimp", category: "seafood" }],
      },
      shellfish,
    );
    expect(reasons.length).toBeGreaterThan(0);
  });

  it("passes a recipe with nothing wrong", () => {
    const reasons = findViolations(
      {
        tags: ["dinner"],
        totalMin: 30,
        lines: [{ rawText: "2 cups cooked rice", ingredientName: "rice", category: "pantry" }],
      },
      shellfish,
    );
    expect(reasons).toEqual([]);
  });

  it("flags a recipe over the time limit and one with a dessert tag", () => {
    const spec = buildFilterSpec({ allergies: [], diets: [], dislikes: [], weeknightMinutes: 30 });
    expect(findViolations({ tags: [], totalMin: 45, lines: [] }, spec).join()).toMatch(/time/);
    expect(findViolations({ tags: ["Dessert"], totalMin: 10, lines: [] }, spec).join()).toMatch(
      /tag/,
    );
    expect(findViolations({ tags: [], totalMin: null, lines: [] }, spec)).toEqual([]);
  });
});

describe("term lists: the SQL engine and the TypeScript engine agree", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.close();
  });

  const MUST_MATCH: Record<string, string[]> = {
    peanut: ["1/2 cup peanut butter", "chopped peanuts", "mixed nuts", "satay sauce"],
    tree_nut: [
      "1 cup slivered almonds",
      "pine nuts",
      "pesto",
      "walnut halves",
      "cashew cream",
      "pecans",
    ],
    milk: [
      "1 cup whole milk",
      "2 tbsp butter",
      "heavy cream",
      "grated Parmesan",
      "plain yogurt",
      "ghee",
      "buttermilk",
      "ice cream",
      "cheddar cheese",
      "ricotta",
      "grated pecorino",
      "vanilla buttercream",
      "1/4 cup coffee creamer",
    ],
    egg: [
      "2 eggs",
      "2 egg yolks",
      "mayonnaise",
      "1/2 cup Caesar dressing",
      "egg whites",
      "meringue",
    ],
    wheat: [
      "2 cups all-purpose flour",
      "1 lb spaghetti",
      "breadcrumbs",
      "4 flour tortillas",
      "soy sauce",
      "egg noodles",
      "couscous",
      "pizza dough",
    ],
    soy: ["14 oz firm tofu", "2 tbsp soy sauce", "edamame", "miso paste", "tempeh", "tamari"],
    fish: [
      "4 salmon fillets",
      "2 tbsp fish sauce",
      "Worcestershire sauce",
      "anchovies",
      "canned tuna",
      "cod",
    ],
    shellfish: [
      "1 lb shrimp",
      "jumbo prawns",
      "lump crab meat",
      "lobster tails",
      "12 clams",
      "oysters",
      "sea scallops",
      "calamari",
    ],
    sesame: ["1 tbsp sesame seeds", "1/4 cup tahini", "sesame oil", "hummus", "za'atar"],
  };
  const MUST_NOT_MATCH: Record<string, string[]> = {
    peanut: ["1 cup coconut flakes", "nutmeg", "butternut squash", "doughnut"],
    tree_nut: ["coconut", "nutmeg", "butternut squash"],
    milk: [
      "1 can coconut milk",
      "1 cup almond milk",
      "oat milk",
      "peanut butter",
      "cream of tartar",
      "butter lettuce leaves",
      "cocoa butter",
      "coconut cream",
      "2 tbsp oat creamer",
      "non-dairy creamer",
      "1 lb creamer potatoes",
    ],
    egg: ["eggplant", "1 large eggplant, cubed"],
    wheat: [
      "1 cup rice flour",
      "almond flour",
      "corn tortillas",
      "rice noodles",
      "glass noodles",
      "coconut flour",
    ],
    soy: ["soybean-free oil is not here", "1 cup rice"],
    fish: ["1 lb chicken thighs", "swordfishing line"],
    shellfish: ["1 lb chicken thighs", "crabapple jelly"],
    sesame: ["1 cup rice", "sesame-free"],
  };

  for (const allergen of ALLERGENS) {
    it(`${allergen}: both engines flag what they must and agree on the rest`, async () => {
      const spec = buildFilterSpec({ allergies: [allergen], diets: [], dislikes: [] });
      const js = toJsPattern(spec.textPattern);
      const samples = [...(MUST_MATCH[allergen] ?? []), ...(MUST_NOT_MATCH[allergen] ?? [])];
      for (const text of samples) {
        const rows = await t.query<{ hit: boolean }>("select $1::text ~* $2::text as hit", [
          text,
          spec.textPattern,
        ]);
        const sqlHit = rows[0]?.hit === true;
        expect(js.test(text), `JS on "${text}"`).toBe(sqlHit);
      }
      for (const text of MUST_MATCH[allergen] ?? []) {
        expect(js.test(text), `${allergen} must flag "${text}"`).toBe(true);
      }
      for (const text of MUST_NOT_MATCH[allergen] ?? []) {
        // Samples whose only purpose is to check the engines agree are skipped above; these are
        // the real exceptions.
        if (text.includes("-free") || text.includes("fishing")) continue;
        expect(js.test(text), `${allergen} must not flag "${text}"`).toBe(false);
      }
    });
  }
});

describe("hard filters against the corpus (PGlite)", () => {
  let t: TestDb;
  let corpus: LoadedCorpus;
  const fixtures = readHouseholdFixtures();

  beforeAll(async () => {
    t = await createTestDb();
    corpus = await loadCorpus(t);
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  async function candidatesFor(prefs: (typeof fixtures)[number]["preferences"]) {
    const spec = buildFilterSpec(filterInputFromPreferences(prefs));
    return fetchCandidates(t.runner, {
      householdId: FIXTURE_HOUSEHOLD,
      spec,
      tasteEmbedding: null,
      cuisines: prefs.cuisines ?? [],
      warn: () => {},
    });
  }

  it("has ten fixtures", () => {
    expect(fixtures).toHaveLength(10);
  });

  it("returns zero shellfish recipes for the shellfish household (acceptance criterion 6)", async () => {
    const fixture = fixtures.find((f) => f.name === "household-01-shellfish");
    expect(fixture).toBeDefined();
    if (!fixture) return;
    const { candidates, dropped } = await candidatesFor(fixture.preferences);
    expect(candidates.length).toBeGreaterThanOrEqual(fixture.expect.minCandidates);
    expect(dropped).toEqual([]);
    const shellfish = candidates.filter((c) =>
      corpus.byId.get(c.id)?.labels.contains.includes("shellfish"),
    );
    expect(shellfish.map((c) => c.title)).toEqual([]);
    // The unparsed "prawns" recipe, the crab cakes, and the catalog shrimp tacos are all out.
    const titles = new Set(candidates.map((c) => c.title));
    expect(titles.has("Grilled prawn skewers")).toBe(false);
    expect(titles.has("Crab cakes")).toBe(false);
    expect(titles.has("Catalog: shrimp tacos")).toBe(false);
  });

  for (const fixture of fixtures) {
    it(`${fixture.name}: no violations, nothing over-excluded`, async () => {
      const { candidates, dropped } = await candidatesFor(fixture.preferences);
      expect(candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);
      // The SQL and the TypeScript re-check must agree: nothing the SQL returned is dropped.
      expect(dropped, "TypeScript refused a recipe the SQL returned").toEqual([]);

      const violations: string[] = [];
      for (const candidate of candidates) {
        const recipe = corpus.byId.get(candidate.id);
        if (!recipe) throw new Error(`unknown recipe ${candidate.id}`);
        for (const reason of oracleViolations(fixture.preferences, recipe)) {
          violations.push(`${recipe.key}: ${reason}`);
        }
      }
      expect(violations).toEqual([]);

      const keys = new Set(candidates.map((c) => corpus.byId.get(c.id)?.key));
      for (const key of fixture.expect.mustExclude) {
        expect(keys.has(key), `${key} must be excluded`).toBe(false);
      }
      for (const key of fixture.expect.mustInclude) {
        expect(keys.has(key), `${key} must be a candidate`).toBe(true);
      }
      expect(candidates.length).toBeGreaterThanOrEqual(fixture.expect.minCandidates);
    });
  }

  it("keeps recipes with no time, and drops ones over the limit", async () => {
    const { candidates } = await candidatesFor({ weeknight_minutes: 30, allergies: [] });
    const keys = new Set(candidates.map((c) => corpus.byId.get(c.id)?.key));
    expect(keys.has("jackfruit-no-times")).toBe(true);
    expect(keys.has("slow-braise-long")).toBe(false);
    expect(keys.has("lemon-chicken-sheet-pan")).toBe(false);
  });

  it("never returns another household's recipe or a deleted one", async () => {
    const { candidates } = await candidatesFor({ allergies: [] });
    const keys = new Set(candidates.map((c) => corpus.byId.get(c.id)?.key));
    expect(keys.has("other-household-peanut")).toBe(false);
    expect(keys.has("deleted-safe-dish")).toBe(false);
  });

  it("leaves out recipes excluded by id", async () => {
    const spec = buildFilterSpec({ allergies: [], diets: [], dislikes: [] });
    const gazpacho = corpus.ids.get("gazpacho");
    expect(gazpacho).toBeDefined();
    const result = await fetchCandidates(t.runner, {
      householdId: FIXTURE_HOUSEHOLD,
      spec,
      tasteEmbedding: null,
      cuisines: [],
      excludeIds: gazpacho ? [gazpacho] : [],
      warn: () => {},
    });
    expect(result.candidates.some((c) => c.id === gazpacho)).toBe(false);
  });

  it("resolves a never-food through the ontology, plural included", async () => {
    // "mushrooms" is the plural alias of the ingredient "mushroom".
    const { candidates } = await candidatesFor({ dislikes: ["mushrooms"], allergies: [] });
    expect(candidates.some((c) => c.title === "Mushroom risotto")).toBe(false);
  });
});
