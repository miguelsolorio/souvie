// Starter catalog tests (WS16): the JSON files, the generated SQL and review sheet, and the
// deterministic checks. Acceptance criteria 1 and 2 of docs/workstreams/WS16-starter-catalog.md.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  instructionsToJson,
  isUnitCode,
  NormalizedRecipe,
  RECIPE_LIMITS,
  RecipeIngredient,
  RecipeInstructions,
} from "../../../packages/core/src/index.ts";
import { INGREDIENT_NAMESPACE, readSeed, uuidV5 } from "../load.ts";
import {
  CATALOG_SQL_PATH,
  catalogStats,
  REVIEW_SHEET_PATH,
  readCatalog,
  readDraftLog,
  renderCatalogSql,
  renderReviewSheet,
} from "./load.ts";
import {
  ALLERGENS,
  AUDIENCE_TAGS,
  analyzeLine,
  analyzeRecipe,
  BRAND_NAMES,
  CATALOG_NAMESPACE,
  type CatalogRecipe,
  COVERAGE,
  DESCRIPTION_CLAIM,
  DIET_TAGS,
  freshLineCount,
  METHOD_TAGS,
  NON_MEAT_PROTEIN_TAGS,
  PANTRY_MAX_FRESH_LINES,
  PERSON_AND_PUBLICATION_NAMES,
  PLAN,
  PROTEIN_TAGS,
  proteinOf,
  proteinPresent,
  RETAILER_NAMES,
  requiredQualifiers,
  SLUG_PATTERN,
  shapeProblems,
  slugWordsMissingFromTitle,
  strayFlesh,
  TAG_VOCABULARY,
  TITLE_CLAIM,
  textProblems,
} from "./spec.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const seed = readSeed();
const categories = new Map(seed.ingredients.map((i) => [i.name, i.category]));
const categoryOf = (name: string): string | undefined => categories.get(name);
const recipes = readCatalog();
const draftLog = readDraftLog();

const proteinCount = (tag: string): number => recipes.filter((r) => r.tags.includes(tag)).length;
const dietOf = (r: CatalogRecipe) =>
  r.tags.filter((t) => (DIET_TAGS as readonly string[]).includes(t));
const minutes = (r: CatalogRecipe): number => r.prepMin + r.cookMin;

// Every string a reader sees, for the text rules.
function textsOf(r: CatalogRecipe): { where: string; text: string }[] {
  return [
    { where: "title", text: r.title },
    { where: "description", text: r.description },
    { where: "cuisine", text: r.cuisine },
    ...r.ingredients.flatMap((l, i) => [
      { where: `ingredients[${i}].rawText`, text: l.rawText },
      ...(l.prepNote ? [{ where: `ingredients[${i}].prepNote`, text: l.prepNote }] : []),
      ...(l.groupName ? [{ where: `ingredients[${i}].groupName`, text: l.groupName }] : []),
    ]),
    ...r.instructions.map((text, i) => ({ where: `instructions[${i}]`, text })),
  ];
}

describe("catalog files", () => {
  it("holds at least 60 recipes, one file each, named by slug", () => {
    expect(recipes.length).toBeGreaterThanOrEqual(COVERAGE.minRecipes);
    const files = readdirSync(join(HERE, "recipes")).filter((f) => f.endsWith(".json"));
    expect(files.sort()).toEqual(recipes.map((r) => `${r.slug}.json`).sort());
    for (const r of recipes) expect(r.slug, r.slug).toMatch(SLUG_PATTERN);
    expect(new Set(recipes.map((r) => r.slug)).size).toBe(recipes.length);
  });

  it("matches the JSON file shape for every recipe", () => {
    for (const r of recipes) expect(shapeProblems(r), r.slug).toEqual([]);
  });

  it("is a valid NormalizedRecipe with valid RecipeInstructions inside RECIPE_LIMITS", () => {
    for (const r of recipes) {
      const normalized = NormalizedRecipe.safeParse({
        title: r.title,
        description: r.description,
        servings: r.servings,
        prepMin: r.prepMin,
        cookMin: r.cookMin,
        ingredients: r.ingredients.map((l) => ({
          rawText: l.rawText,
          ...(l.groupName ? { groupName: l.groupName } : {}),
        })),
        instructions: r.instructions,
        tags: r.tags,
        cuisine: r.cuisine,
      });
      expect(normalized.success, `${r.slug}: ${JSON.stringify(normalized.error?.issues)}`).toBe(
        true,
      );
      expect(RecipeInstructions.safeParse(instructionsToJson(r.instructions)).success, r.slug).toBe(
        true,
      );

      expect(r.title.length, r.slug).toBeLessThanOrEqual(RECIPE_LIMITS.title);
      expect(r.description.length, r.slug).toBeLessThanOrEqual(RECIPE_LIMITS.description);
      expect(r.cuisine.length, r.slug).toBeLessThanOrEqual(RECIPE_LIMITS.cuisine);
      expect(r.tags.length, r.slug).toBeLessThanOrEqual(RECIPE_LIMITS.tags);
      expect(r.ingredients.length, r.slug).toBeLessThanOrEqual(RECIPE_LIMITS.ingredients);
      expect(r.instructions.length, r.slug).toBeLessThanOrEqual(RECIPE_LIMITS.instructions);
      for (const tag of r.tags) {
        expect(tag, r.slug).toBe(tag.toLowerCase());
        expect(tag.length, r.slug).toBeLessThanOrEqual(RECIPE_LIMITS.tagLength);
      }
      for (const l of r.ingredients) {
        expect(l.rawText.length, r.slug).toBeLessThanOrEqual(RECIPE_LIMITS.ingredientText);
      }
      for (const step of r.instructions) {
        expect(step.length, r.slug).toBeLessThanOrEqual(RECIPE_LIMITS.instructionText);
      }
    }
  });

  it("writes ingredient lines that fit the recipe_ingredients row schema", () => {
    for (const r of recipes) {
      for (const l of r.ingredients) {
        const row = RecipeIngredient.safeParse({
          id: uuidV5(`${r.slug}#${l.position}`, CATALOG_NAMESPACE),
          recipe_id: r.id,
          position: l.position,
          group_name: l.groupName,
          raw_text: l.rawText,
          qty: l.qty,
          qty_max: l.qtyMax,
          unit: l.unit,
          ingredient_id: l.ingredientId,
          prep_note: l.prepNote,
          optional: l.optional,
          parse_confidence: l.parseConfidence,
        });
        expect(row.success, `${r.slug}#${l.position}`).toBe(true);
        if (l.unit !== null)
          expect(isUnitCode(l.unit), `${r.slug}#${l.position}: ${l.unit}`).toBe(true);
      }
    }
  });

  it("derives every id from the slug and the ingredient name, recomputed here", () => {
    const ids = new Set<string>();
    for (const r of recipes) {
      expect(r.id, r.slug).toBe(uuidV5(r.slug, CATALOG_NAMESPACE));
      ids.add(r.id);
      r.ingredients.forEach((l, i) => {
        expect(l.position, r.slug).toBe(i);
        ids.add(uuidV5(`${r.slug}#${l.position}`, CATALOG_NAMESPACE));
      });
    }
    expect(ids.size).toBe(recipes.length + recipes.reduce((n, r) => n + r.ingredients.length, 0));
  });

  it("points every ingredientId at a real ontology row, with the id the ontology derives", () => {
    const byId = new Map(seed.ingredients.map((i) => [i.id, i]));
    for (const r of recipes) {
      for (const l of r.ingredients) {
        if (l.ingredientId === null) continue;
        const ing = byId.get(l.ingredientId);
        expect(ing, `${r.slug}#${l.position} ${l.rawText}`).toBeDefined();
        expect(l.ingredientName, `${r.slug}#${l.position}`).toBe(ing?.name);
        expect(l.ingredientId).toBe(uuidV5(l.ingredientName as string, INGREDIENT_NAMESPACE));
        expect(l.parseConfidence ?? 0, `${r.slug}#${l.position}`).toBeGreaterThanOrEqual(
          COVERAGE.resolvedConfidence,
        );
      }
    }
  });

  it("uses only tags from the vocabulary, with dinner and exactly one protein on each recipe", () => {
    for (const r of recipes) {
      for (const tag of r.tags) expect(TAG_VOCABULARY, `${r.slug}: ${tag}`).toContain(tag);
      expect(r.tags, r.slug).toContain("dinner");
      expect(new Set(r.tags).size, r.slug).toBe(r.tags.length);
      expect(
        r.tags.filter((t) => (PROTEIN_TAGS as readonly string[]).includes(t)),
        r.slug,
      ).toHaveLength(1);
      // WS06 never treats these as dinner candidates.
      for (const tag of ["dessert", "drink", "breakfast", "snack"])
        expect(r.tags).not.toContain(tag);
    }
  });

  it("gives diet tags only when the deterministic check agrees, and every tag it supports", () => {
    for (const r of recipes) {
      const facts = analyzeRecipe(r.ingredients, categoryOf);
      expect(dietOf(r).sort(), r.slug).toEqual([...facts.diets].sort());
    }
  });

  it("tags the protein honestly", () => {
    for (const r of recipes) {
      const protein = proteinOf(r.tags);
      expect(protein, r.slug).not.toBeNull();
      if (!protein) continue;
      const facts = analyzeRecipe(r.ingredients, categoryOf);
      expect(proteinPresent(protein, r.ingredients, facts), `${r.slug} holds no ${protein}`).toBe(
        true,
      );
      expect(strayFlesh(protein, facts), `${r.slug} holds other meat or fish`).toEqual([]);
      if ((NON_MEAT_PROTEIN_TAGS as readonly string[]).includes(protein)) {
        expect(r.tags, `${r.slug} has a non-meat protein but is not vegetarian`).toContain(
          "vegetarian",
        );
      }
    }
  });

  it("names hidden allergen carriers on their own line, never only in a step", () => {
    const carriers = [
      "soy sauce",
      "tamari",
      "fish sauce",
      "oyster sauce",
      "worcestershire",
      "miso",
      "sesame oil",
      "tahini",
      "peanut butter",
      "almond butter",
      "cashew butter",
      "pesto",
      "hoisin",
    ];
    for (const r of recipes) {
      const lines = r.ingredients.map((l) => l.rawText.toLowerCase()).join("\n");
      for (const [i, step] of r.instructions.entries()) {
        for (const carrier of carriers) {
          if (step.toLowerCase().includes(carrier)) {
            expect(lines, `${r.slug} step ${i + 1} uses ${carrier}`).toContain(carrier);
          }
        }
      }
    }
  });

  it("keeps pantry recipes mostly shelf-stable", () => {
    for (const r of recipes.filter((x) => x.tags.includes("pantry"))) {
      expect(freshLineCount(r.ingredients, categoryOf), r.slug).toBeLessThanOrEqual(
        PANTRY_MAX_FRESH_LINES,
      );
    }
  });

  it("keeps a stated qualifier in prepNote when the ingredient id alone would lose it", () => {
    // "gluten-free tamari" resolves to the plain soy sauce id; "vegetarian Parmesan" to parmesan.
    let qualified = 0;
    for (const r of recipes) {
      for (const l of r.ingredients) {
        if (l.ingredientId === null) continue;
        for (const q of requiredQualifiers(l, categoryOf)) {
          qualified++;
          expect(
            (l.prepNote ?? "").toLowerCase(),
            `${r.slug}#${l.position}: ${l.rawText}`,
          ).toContain(q);
        }
      }
    }
    // The rule bites on real lines: spaghetti, tamari, tempeh, and Parmesan carry one.
    expect(qualified).toBeGreaterThanOrEqual(8);
  });

  it("names every recipe by a slug whose words its title uses", () => {
    for (const r of recipes) {
      expect(slugWordsMissingFromTitle(r.slug, r.title), `${r.slug} vs "${r.title}"`).toEqual([]);
    }
  });

  it("makes no diet or allergen claim in a title or description", () => {
    for (const r of recipes) {
      expect(r.title, r.slug).not.toMatch(TITLE_CLAIM);
      expect(r.description, r.slug).not.toMatch(DESCRIPTION_CLAIM);
    }
  });

  it("has no em dash, retailer, brand, URL, banned word, chef or publication in any text", () => {
    for (const r of recipes) {
      for (const { where, text } of textsOf(r)) {
        expect(text, `${r.slug} ${where}`).not.toContain("—");
        expect(textProblems(text), `${r.slug} ${where}`).toEqual([]);
        expect(text, `${r.slug} ${where}`).not.toMatch(/https?:\/\/|www\./i);
        expect(text, `${r.slug} ${where}`).not.toMatch(/\b(?:copycat|famous)\b/i);
      }
    }
  });

  it("never repeats a title, case aside", () => {
    const titles = recipes.map((r) => r.title.toLowerCase());
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe("coverage spec (WS16 interfaces)", () => {
  const allergenFree = recipes.filter((r) => analyzeRecipe(r.ingredients, categoryOf).allergenFree);
  const lines = recipes.flatMap((r) => r.ingredients);

  it("has at least 60 recipes, every one a dinner main", () => {
    expect(recipes.length).toBeGreaterThanOrEqual(COVERAGE.minRecipes);
    for (const r of recipes) expect(r.tags).toContain("dinner");
  });

  it("covers at least 10 cuisines with none above 12 recipes", () => {
    const byCuisine = new Map<string, number>();
    for (const r of recipes) byCuisine.set(r.cuisine, (byCuisine.get(r.cuisine) ?? 0) + 1);
    expect(byCuisine.size).toBeGreaterThanOrEqual(COVERAGE.minCuisines);
    for (const [cuisine, n] of byCuisine) {
      expect(n, cuisine).toBeLessThanOrEqual(COVERAGE.maxPerCuisine);
    }
  });

  it("respects the protein caps and holds at least 20 non-meat proteins", () => {
    for (const [tag, cap] of Object.entries(COVERAGE.proteinCaps)) {
      expect(proteinCount(tag), tag).toBeLessThanOrEqual(cap);
    }
    const nonMeat = NON_MEAT_PROTEIN_TAGS.reduce((n, tag) => n + proteinCount(tag), 0);
    expect(nonMeat).toBeGreaterThanOrEqual(COVERAGE.minNonMeatProtein);
  });

  it("meets the diet minimums", () => {
    expect(proteinCount("vegetarian")).toBeGreaterThanOrEqual(COVERAGE.minVegetarian);
    expect(proteinCount("vegan")).toBeGreaterThanOrEqual(COVERAGE.minVegan);
    expect(proteinCount("gluten_free")).toBeGreaterThanOrEqual(COVERAGE.minGlutenFree);
    expect(proteinCount("dairy_free")).toBeGreaterThanOrEqual(COVERAGE.minDairyFree);
    // Vegan implies vegetarian, gluten-free and dairy-free are separate claims.
    for (const r of recipes.filter((x) => x.tags.includes("vegan"))) {
      expect(r.tags, r.slug).toContain("vegetarian");
      expect(r.tags, r.slug).toContain("dairy_free");
    }
  });

  it("has at least 30 recipes with none of the nine allergens", () => {
    expect(ALLERGENS).toHaveLength(9);
    expect(allergenFree.length).toBeGreaterThanOrEqual(COVERAGE.minAllergenFree);
  });

  it("has at least 40 recipes at 35 minutes or less, none above 120", () => {
    expect(
      recipes.filter((r) => minutes(r) <= COVERAGE.quickMinutes).length,
    ).toBeGreaterThanOrEqual(COVERAGE.minQuick);
    for (const r of recipes) expect(minutes(r), r.slug).toBeLessThanOrEqual(COVERAGE.maxMinutes);
  });

  it("serves 4 everywhere, with 5 to 16 lines and 4 to 12 steps", () => {
    for (const r of recipes) {
      expect(r.servings, r.slug).toBe(4);
      expect(r.ingredients.length, r.slug).toBeGreaterThanOrEqual(COVERAGE.minIngredientLines);
      expect(r.ingredients.length, r.slug).toBeLessThanOrEqual(COVERAGE.maxIngredientLines);
      expect(r.instructions.length, r.slug).toBeGreaterThanOrEqual(COVERAGE.minSteps);
      expect(r.instructions.length, r.slug).toBeLessThanOrEqual(COVERAGE.maxSteps);
    }
  });

  it("resolves at least 90 percent of ingredient lines with confidence 0.8 or more", () => {
    expect(lines.length).toBeGreaterThanOrEqual(COVERAGE.minTotalIngredientLines);
    const resolved = lines.filter(
      (l) => l.ingredientId !== null && (l.parseConfidence ?? 0) >= COVERAGE.resolvedConfidence,
    );
    expect(resolved.length / lines.length).toBeGreaterThanOrEqual(COVERAGE.minResolvedShare);
  });

  it("has at least 15 kid friendly and 10 pantry recipes", () => {
    expect(proteinCount("kid_friendly")).toBeGreaterThanOrEqual(COVERAGE.minKidFriendly);
    expect(proteinCount("pantry")).toBeGreaterThanOrEqual(COVERAGE.minPantry);
  });
});

describe("generated files", () => {
  const sql = readFileSync(CATALOG_SQL_PATH, "utf8");

  it("keeps 20_catalog.sql and the review sheet in step with the JSON, byte for byte", () => {
    expect(sql).toBe(renderCatalogSql(recipes));
    expect(readFileSync(REVIEW_SHEET_PATH, "utf8")).toBe(
      renderReviewSheet(recipes, seed, draftLog),
    );
  });

  it("passes `node supabase/seed/catalog/load.ts --check`", () => {
    const result = spawnSync(process.execPath, [join(HERE, "load.ts"), "--check"], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("upserts by id, deletes only stale ingredient lines, and leaves the embedding to WS06", () => {
    expect(sql).not.toMatch(/\b(?:drop\s|truncate|alter\s)/i);
    // The one delete: lines of the recipes this file upserts that the JSON no longer has.
    expect(sql.match(/^delete from [^\n]+/gm)).toEqual(["delete from public.recipe_ingredients"]);
    expect(sql).not.toMatch(/delete\s+from\s+public\.recipes\b/i);
    const inserts = sql.match(/^insert into [^\n]+/gm) ?? [];
    expect(inserts.length).toBeGreaterThanOrEqual(2);
    for (const insert of inserts) {
      expect(insert).toMatch(/^insert into public\.(?:recipes|recipe_ingredients) \(id,/);
      expect(insert).not.toContain("embedding");
    }
    const conflicts = sql.match(/^on conflict \(id\) do update set/gm) ?? [];
    expect(conflicts).toHaveLength(inserts.length);
    // Only an edit to the text the embedding is built from may clear it.
    expect(sql).toContain(
      "is distinct from (excluded.title, excluded.description, excluded.tags, excluded.cuisine)",
    );
  });

  it("removes the ingredient lines the JSON dropped, for the recipes it upserts and no others", () => {
    const match =
      /where recipe_id = any \(array\[([^\]]*)\]::uuid\[\]\)\n {2}and id <> all \(array\[([^\]]*)\]::uuid\[\]\);/.exec(
        sql,
      );
    expect(match).not.toBeNull();
    const ids = (text: string | undefined): string[] =>
      text?.match(/[0-9a-f]{8}-[0-9a-f-]{27}/g) ?? [];
    const recipeIds = ids(match?.[1]);
    const keepIds = ids(match?.[2]);
    expect(new Set(recipeIds)).toEqual(new Set(recipes.map((r) => r.id)));
    expect(new Set(keepIds)).toEqual(
      new Set(
        recipes.flatMap((r) =>
          r.ingredients.map((l) => uuidV5(`${r.slug}#${l.position}`, CATALOG_NAMESPACE)),
        ),
      ),
    );
    expect(new Set(keepIds).size).toBe(keepIds.length);

    // What that statement does to a database that has an old copy of the catalog.
    type Row = { id: string; recipeId: string };
    const stale: Row = {
      id: "00000000-0000-5000-8000-000000000001",
      recipeId: recipeIds[0] as string,
    };
    const household: Row = {
      id: "00000000-0000-5000-8000-000000000002",
      recipeId: "aa000000-0000-4000-8000-000000000001",
    };
    const kept: Row[] = keepIds.map((id, i) => ({
      id,
      recipeId: recipeIds[i % recipeIds.length] as string,
    }));
    const run = (rows: Row[]): Row[] =>
      rows.filter((row) => !(recipeIds.includes(row.recipeId) && !keepIds.includes(row.id)));
    const once = run([...kept, stale, household]);
    expect(once).toEqual([...kept, household]);
    expect(run(once)).toEqual(once);
  });

  it("writes one row per recipe and one per line, with the catalog columns fixed", () => {
    const recipeRows = sql.split("\n").filter((l) => /^ {2}\('[0-9a-f-]{36}', null, '/.test(l));
    expect(recipeRows).toHaveLength(recipes.length);
    for (const row of recipeRows) {
      expect(row).toMatch(
        /, null, 'ai', null, 4, \d+, \d+, '.*'::jsonb, null, array\[.*\]::text\[\], '.*', 'catalog', null\)[,]?$/,
      );
    }
    const lineRows = sql
      .split("\n")
      .filter((l) => /^ {2}\('[0-9a-f-]{36}', '[0-9a-f-]{36}', \d+, /.test(l));
    expect(lineRows).toHaveLength(recipes.reduce((n, r) => n + r.ingredients.length, 0));
    for (const r of recipes) {
      expect(sql).toContain(`'${r.id}'`);
      for (const l of r.ingredients) {
        expect(sql).toContain(`'${uuidV5(`${r.slug}#${l.position}`, CATALOG_NAMESPACE)}'`);
      }
    }
  });

  it("renders the same text twice and escapes quotes", () => {
    expect(renderCatalogSql(recipes)).toBe(renderCatalogSql(recipes));
    const first = recipes[0] as CatalogRecipe;
    const tricky: CatalogRecipe = {
      ...first,
      title: "Cook's Pan",
      description: "It's 'quoted'.",
      instructions: ['Say "hi" and don\'t stop.'],
    };
    const out = renderCatalogSql([tricky]);
    expect(out).toContain("'Cook''s Pan'");
    expect(out).toContain("'It''s ''quoted''.'");
    expect(out).toContain('[{"step":1,"text":"Say \\"hi\\" and don\'\'t stop."}]');
  });

  it("lists every recipe and every unresolved line in the review sheet", () => {
    const sheet = readFileSync(REVIEW_SHEET_PATH, "utf8");
    for (const r of recipes) {
      expect(sheet).toContain(`recipes/${r.slug}.json`);
    }
    for (const heading of [
      "| Recipe | Cuisine | Protein | Minutes | Diet | Allergens |",
      "## Ingredient lines that did not resolve",
    ]) {
      expect(sheet).toContain(heading);
    }
    for (const r of recipes) {
      for (const l of r.ingredients.filter((x) => x.ingredientId === null)) {
        expect(sheet, `${r.slug}: ${l.rawText}`).toContain(l.rawText.replace(/\|/g, "\\|"));
      }
    }
    expect(sheet).not.toContain("—");
    const stats = catalogStats(recipes, seed);
    expect(sheet).toContain(`| Recipes | ${stats.recipes} |`);
  });

  it("does not read the drafting run log as a recipe, even inside the recipes directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "catalog-log-"));
    try {
      const first = recipes[0] as CatalogRecipe;
      writeFileSync(join(dir, `${first.slug}.json`), JSON.stringify(first));
      writeFileSync(join(dir, "draft-log.json"), JSON.stringify({ runs: [] }));
      expect(readCatalog(dir).map((r) => r.slug)).toEqual([first.slug]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a file that is not a valid recipe", () => {
    const dir = mkdtempSync(join(tmpdir(), "catalog-bad-"));
    try {
      writeFileSync(join(dir, "bad.json"), JSON.stringify({ slug: "bad" }));
      expect(() => readCatalog(dir)).toThrow(/invalid catalog files/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the plan", () => {
  const count = (pick: (s: (typeof PLAN)[number]) => boolean): number => PLAN.filter(pick).length;

  it("has unique kebab-case slugs and valid tags", () => {
    expect(new Set(PLAN.map((s) => s.slug)).size).toBe(PLAN.length);
    for (const s of PLAN) {
      expect(s.slug).toMatch(SLUG_PATTERN);
      expect(PROTEIN_TAGS).toContain(s.protein);
      for (const m of s.methods) expect(METHOD_TAGS).toContain(m);
      for (const a of s.audience) expect(AUDIENCE_TAGS).toContain(a);
      expect(s.maxMinutes).toBeLessThanOrEqual(COVERAGE.maxMinutes);
      expect(textProblems(s.dish), s.slug).toEqual([]);
    }
  });

  it("stays inside every cap even if every slot is accepted", () => {
    for (const [tag, cap] of Object.entries(COVERAGE.proteinCaps)) {
      expect(
        count((s) => s.protein === tag),
        tag,
      ).toBeLessThanOrEqual(cap);
    }
    const cuisines = new Map<string, number>();
    for (const s of PLAN) cuisines.set(s.cuisine, (cuisines.get(s.cuisine) ?? 0) + 1);
    for (const [cuisine, n] of cuisines)
      expect(n, cuisine).toBeLessThanOrEqual(COVERAGE.maxPerCuisine);
    expect(cuisines.size).toBeGreaterThanOrEqual(COVERAGE.minCuisines);
  });

  it("asks for more than each minimum, so some rejected drafts cost nothing", () => {
    expect(PLAN.length).toBeGreaterThanOrEqual(COVERAGE.minRecipes + 5);
    expect(count((s) => s.maxMinutes <= COVERAGE.quickMinutes)).toBeGreaterThanOrEqual(
      COVERAGE.minQuick + 8,
    );
    expect(count((s) => s.allergenFree === true)).toBeGreaterThanOrEqual(
      COVERAGE.minAllergenFree + 5,
    );
    expect(count((s) => s.diets.includes("vegan"))).toBeGreaterThanOrEqual(COVERAGE.minVegan + 4);
    expect(count((s) => s.diets.includes("gluten_free"))).toBeGreaterThanOrEqual(
      COVERAGE.minGlutenFree + 5,
    );
    expect(count((s) => s.diets.includes("dairy_free"))).toBeGreaterThanOrEqual(
      COVERAGE.minDairyFree + 5,
    );
    expect(count((s) => s.audience.includes("kid_friendly"))).toBeGreaterThanOrEqual(
      COVERAGE.minKidFriendly + 5,
    );
    expect(count((s) => s.audience.includes("pantry"))).toBeGreaterThanOrEqual(
      COVERAGE.minPantry + 3,
    );
    expect(
      count((s) => (NON_MEAT_PROTEIN_TAGS as readonly string[]).includes(s.protein)),
    ).toBeGreaterThanOrEqual(COVERAGE.minNonMeatProtein + 4);
  });

  it("gives the first 60 slots enough to meet every minimum on their own", () => {
    const first = PLAN.slice(0, COVERAGE.minRecipes);
    const n = (pick: (s: (typeof PLAN)[number]) => boolean): number => first.filter(pick).length;
    expect(new Set(first.map((s) => s.cuisine)).size).toBeGreaterThanOrEqual(COVERAGE.minCuisines);
    expect(n((s) => s.maxMinutes <= COVERAGE.quickMinutes)).toBeGreaterThanOrEqual(
      COVERAGE.minQuick,
    );
    expect(n((s) => s.allergenFree === true)).toBeGreaterThanOrEqual(COVERAGE.minAllergenFree);
    expect(n((s) => s.diets.includes("vegan"))).toBeGreaterThanOrEqual(COVERAGE.minVegan);
    expect(
      n((s) => (NON_MEAT_PROTEIN_TAGS as readonly string[]).includes(s.protein)),
    ).toBeGreaterThanOrEqual(COVERAGE.minNonMeatProtein);
  });
});

describe("banned text", () => {
  it("flags dashes, exclamation marks, URLs, and handles", () => {
    expect(textProblems("Heat the oil — then add the onion.")).toContain("contains an em dash");
    expect(textProblems("Bake 10–15 minutes.")).toContain("contains an en dash");
    expect(textProblems("Serve now!")).toContain("contains an exclamation mark");
    expect(textProblems("See https://example.com/recipe")).toContain("contains a URL or handle");
    expect(textProblems("From example.com")).toContain("contains a URL or handle");
    expect(textProblems("Follow @somechef")).toContain("contains a URL or handle");
  });

  it("flags every retailer, brand, chef and publication on the lists", () => {
    for (const name of [...RETAILER_NAMES, ...BRAND_NAMES, ...PERSON_AND_PUBLICATION_NAMES]) {
      expect(textProblems(`Use the ${name} kind.`).length, name).toBeGreaterThan(0);
    }
    expect(textProblems("Trader Joe’s sauce").length).toBeGreaterThan(0);
    expect(textProblems("KROGER brand").length).toBeGreaterThan(0);
  });

  it("flags copycat, famous and restaurant style", () => {
    expect(textProblems("A copycat dinner").length).toBeGreaterThan(0);
    expect(textProblems("The famous sauce").length).toBeGreaterThan(0);
    expect(textProblems("Restaurant-style pasta").length).toBeGreaterThan(0);
  });

  it("leaves ordinary cooking text alone", () => {
    expect(textProblems("Heat 2 tbsp olive oil in a 12-inch skillet over medium heat.")).toEqual(
      [],
    );
    expect(textProblems("Cook until the chicken reaches 165 F, about 20 minutes.")).toEqual([]);
    expect(textProblems("Serve with cabbage slaw and sliced avocado.")).toEqual([]);
    expect(textProblems("1 can (15 oz) black beans, drained and rinsed")).toEqual([]);
  });
});

describe("claims in prose", () => {
  it("catches 'no <allergen>' phrasing for all nine allergens", () => {
    const phrases = [
      "No peanuts.",
      "Made without tree nuts.",
      "No nuts at all.",
      "Contains no milk.",
      "It has no dairy.",
      "Free of eggs.",
      "No wheat.",
      "No gluten.",
      "Without soy.",
      "No fish.",
      "No shellfish.",
      "No sesame.",
      "No added dairy.",
    ];
    for (const phrase of phrases) {
      expect(DESCRIPTION_CLAIM.test(`A plain dish. ${phrase}`), phrase).toBe(true);
    }
    expect(DESCRIPTION_CLAIM.test("Mild and savory with no heat.")).toBe(false);
    expect(DESCRIPTION_CLAIM.test("Spaghetti tossed in a gluten-free tomato sauce.")).toBe(false);
  });

  it("refuses a description that claims one, in the shared shape check", () => {
    const first = recipes[0] as CatalogRecipe;
    const problems = shapeProblems({
      ...first,
      description: "Ground beef over rice. No heat and no sesame.",
    });
    expect(problems.join(" ")).toContain("description makes a diet or allergen claim");
  });

  it("refuses a slug that promises what the title lacks", () => {
    expect(slugWordsMissingFromTitle("shakshuka", "Spiced Tomato Pepper Poached Eggs")).toEqual([
      "shakshuka",
    ]);
    expect(
      slugWordsMissingFromTitle(
        "sheet-pan-salmon-and-broccoli",
        "Sheet Pan Salmon with Lemon Broccoli",
      ),
    ).toEqual([]);
    expect(
      slugWordsMissingFromTitle(
        "lamb-kofta-with-yogurt-sauce",
        "Grilled Lamb Kofta with Lemon Herb Sauce",
      ),
    ).toEqual(["yogurt"]);
    const first = recipes[0] as CatalogRecipe;
    expect(shapeProblems({ ...first, title: "Something Else Entirely" }).join(" ")).toContain(
      "slug names",
    );
  });
});

describe("deterministic diet and allergen checks", () => {
  const line = (rawText: string, ingredientName: string | null = null, resolved = true) => ({
    rawText,
    ingredientName,
    ingredientId: resolved ? "00000000-0000-5000-8000-000000000000" : null,
  });
  const facts = (rawText: string, ingredientName: string | null = null, resolved = true) =>
    analyzeLine(line(rawText, ingredientName, resolved), categoryOf);

  it("catches hidden allergen carriers by name", () => {
    expect(facts("2 tbsp soy sauce", "soy sauce").allergens).toEqual(
      expect.arrayContaining(["soy", "wheat"]),
    );
    expect(facts("1 tbsp tamari", "soy sauce").allergens).toEqual(
      expect.arrayContaining(["soy", "wheat"]),
    );
    expect(facts("1 tbsp fish sauce", "fish sauce").allergens).toContain("fish");
    expect(facts("1 tbsp oyster sauce", "oyster sauce").allergens).toEqual(
      expect.arrayContaining(["shellfish", "soy", "wheat"]),
    );
    expect(facts("1 tbsp worcestershire sauce", "worcestershire sauce").allergens).toContain(
      "fish",
    );
    expect(facts("1 tbsp miso paste", "miso paste").allergens).toContain("soy");
    expect(facts("1 tsp sesame oil", "sesame oil").allergens).toContain("sesame");
    expect(facts("2 tbsp tahini", "tahini").allergens).toContain("sesame");
    expect(facts("2 tbsp peanut butter", "peanut butter").allergens).toContain("peanut");
    expect(facts("2 tbsp almond butter", "almond butter").allergens).toContain("tree_nut");
    expect(facts("1/4 cup basil pesto", "pesto").allergens).toEqual(
      expect.arrayContaining(["tree_nut", "milk"]),
    );
    expect(facts("1 tbsp red curry paste", "red curry paste").allergens).toContain("shellfish");
  });

  it("does not confuse look-alikes", () => {
    expect(facts("1 can (14 oz) coconut milk", "coconut milk").allergens).toEqual([]);
    expect(facts("1 cup almond milk", "almond milk").allergens).toEqual(["tree_nut"]);
    expect(facts("1 cup soy milk", "soy milk").allergens).toEqual(["soy"]);
    expect(facts("1 butternut squash", "butternut squash").allergens).toEqual([]);
    expect(facts("1 tsp cream of tartar", "cream of tartar").allergens).toEqual([]);
    expect(facts("1 can (8 oz) water chestnuts, drained", "water chestnuts").allergens).toEqual([]);
    expect(facts("1 medium eggplant, cubed", "eggplant").allergens).toEqual([]);
    expect(facts("8 oz oyster mushrooms", "oyster mushroom").allergens).toEqual([]);
    expect(facts("8 oz rice noodles", "rice noodles").allergens).toEqual([]);
    expect(facts("8 corn tortillas", "corn tortilla").allergens).toEqual([]);
    expect(facts("1 can (15 oz) butter beans", "lima beans").allergens).toEqual([]);
    expect(facts("1 cup cooked brown rice", "brown rice").allergens).toEqual([]);
  });

  it("finds the common allergens in plain words", () => {
    expect(facts("2 tbsp butter", "butter").allergens).toContain("milk");
    expect(facts("1/2 cup shredded cheddar", "cheddar").allergens).toContain("milk");
    expect(facts("4 eggs", "egg").allergens).toContain("egg");
    expect(facts("8 oz spaghetti", "pasta").allergens).toContain("wheat");
    expect(facts("1 cup all-purpose flour", "all-purpose flour").allergens).toContain("wheat");
    expect(facts("1 lb salmon fillet", "salmon fillet").allergens).toContain("fish");
    expect(facts("1 lb large shrimp", "shrimp").allergens).toContain("shellfish");
    expect(facts("1/4 cup chopped walnuts", "walnuts").allergens).toContain("tree_nut");
    expect(facts("1 block (14 oz) extra-firm tofu", "tofu").allergens).toContain("soy");
  });

  it("honors the qualifiers a line states for itself", () => {
    expect(facts("1 tbsp gluten-free tamari", "soy sauce").gluten).toBe(false);
    expect(facts("1 tbsp gluten-free tamari", "soy sauce").allergens).toEqual(["soy"]);
    expect(facts("2 cups gluten-free chicken broth", "chicken broth").gluten).toBe(false);
    expect(facts("2 cups chicken broth", "chicken broth").gluten).toBe(true);
    expect(facts("2 tbsp vegan butter", "butter").dairy).toBe(false);
    expect(facts("8 oz gluten-free spaghetti", "pasta").allergens).toEqual([]);
  });

  it("sorts meat, fish and animal products", () => {
    expect(facts("1 lb boneless chicken thighs", "chicken thigh").flesh).toEqual(["chicken"]);
    expect(facts("1 lb ground turkey", "ground turkey").flesh).toEqual(["turkey"]);
    expect(facts("1 lb ground beef", "ground beef").flesh).toEqual(["beef"]);
    expect(facts("4 slices bacon", "bacon").flesh).toEqual(["pork"]);
    expect(facts("4 slices turkey bacon", "turkey bacon").flesh).toEqual(["turkey"]);
    expect(facts("1 lb Italian sausage", "italian sausage").flesh).toEqual(["pork"]);
    expect(facts("1 lb ground lamb", "ground lamb").flesh).toEqual(["lamb"]);
    expect(facts("1 lb cod fillets", "cod fillet").flesh).toEqual(["fish"]);
    expect(facts("1 lb shrimp", "shrimp").flesh).toEqual(["shellfish"]);
    expect(facts("1 large head cauliflower, cut into steaks", "cauliflower").flesh).toEqual([]);
    expect(facts("2 cups chicken broth", "chicken broth").flesh).toEqual(["chicken"]);
    expect(facts("2 cups vegetable broth", "vegetable broth").animal).toBe(false);
    expect(facts("2 cups broth", "chicken broth").animal).toBe(true);
    expect(facts("1 tbsp fish sauce", "fish sauce")).toMatchObject({ animal: true, flesh: [] });
    expect(facts("2 tbsp honey", "honey").honey).toBe(true);
  });

  it("treats a line the ontology could not resolve as doubt, unless it is a plain seasoning", () => {
    expect(facts("1 tbsp zhoug", "zhoug", false).unknown).toBe(true);
    expect(facts("1 tsp sumac", "sumac", false).unknown).toBe(false);
    expect(facts("1 tsp zhoug", "zhoug", true).unknown).toBe(false);
    const withDoubt = analyzeRecipe(
      [line("1 cup rice", "rice"), line("2 tbsp zhoug", "zhoug", false)],
      categoryOf,
    );
    expect(withDoubt.diets).toEqual([]);
    expect(withDoubt.allergenFree).toBe(false);
    expect(withDoubt.unknownLines).toEqual(["2 tbsp zhoug"]);
  });

  it("gives diet tags conservatively", () => {
    const vegan = analyzeRecipe(
      [
        line("1 cup brown rice", "brown rice"),
        line("1 can (15 oz) black beans", "black beans"),
        line("2 tbsp olive oil", "olive oil"),
      ],
      categoryOf,
    );
    expect(vegan.diets).toEqual(["vegetarian", "vegan", "gluten_free", "dairy_free"]);
    expect(vegan.allergenFree).toBe(true);

    const veg = analyzeRecipe(
      [line("1 cup brown rice", "brown rice"), line("1/2 cup shredded cheddar", "cheddar")],
      categoryOf,
    );
    expect(veg.diets).toEqual(["vegetarian", "gluten_free"]);
    expect(veg.allergens).toEqual(["milk"]);

    const broth = analyzeRecipe(
      [line("1 cup rice", "rice"), line("2 cups chicken broth", "chicken broth")],
      categoryOf,
    );
    expect(broth.diets).toEqual(["dairy_free"]);

    const tortilla = analyzeRecipe(
      [line("4 flour tortillas", "flour tortilla"), line("1 can black beans", "black beans")],
      categoryOf,
    );
    expect(tortilla.diets).toEqual(["vegetarian", "dairy_free"]);
  });

  it("treats tempeh like miso: gluten doubt unless the line says gluten-free", () => {
    expect(facts("16 oz tempeh, sliced", "tempeh")).toMatchObject({
      gluten: true,
      allergens: ["soy"],
    });
    expect(facts("16 oz gluten-free tempeh, sliced", "tempeh")).toMatchObject({
      gluten: false,
      allergens: ["soy"],
    });
    const plain = analyzeRecipe(
      [line("16 oz tempeh", "tempeh"), line("1 cup rice", "white rice")],
      categoryOf,
    );
    expect(plain.diets).not.toContain("gluten_free");
    const qualified = analyzeRecipe(
      [line("16 oz gluten-free tempeh", "tempeh"), line("1 cup rice", "white rice")],
      categoryOf,
    );
    expect(qualified.diets).toContain("gluten_free");
  });

  it("treats Parmesan, Pecorino and Grana Padano as vegetarian doubt unless the line says vegetarian", () => {
    for (const text of [
      "1/2 cup grated Parmesan cheese",
      "1/4 cup grated Pecorino Romano",
      "1/4 cup grated Grana Padano",
      "2 tbsp Parmigiano Reggiano",
    ]) {
      const f = facts(text, null);
      expect(f.animal, text).toBe(true);
      expect(f.allergens, text).toContain("milk");
      expect(analyzeRecipe([line(text, null)], categoryOf).diets, text).not.toContain("vegetarian");
    }
    const ok = facts("1/2 cup grated vegetarian Parmesan cheese", "parmesan");
    expect(ok.animal).toBe(false);
    expect(ok.allergens).toContain("milk");
    expect(
      analyzeRecipe([line("1/2 cup grated vegetarian Parmesan cheese", "parmesan")], categoryOf)
        .diets,
    ).toContain("vegetarian");
    expect(facts("1 cup shredded cheddar", "cheddar").animal).toBe(false);
  });

  it("names the qualifier a resolved line must keep", () => {
    expect(requiredQualifiers(line("12 oz gluten-free spaghetti", "pasta"), categoryOf)).toEqual([
      "gluten-free",
    ]);
    expect(requiredQualifiers(line("2 tbsp gluten-free tamari", "soy sauce"), categoryOf)).toEqual([
      "gluten-free",
    ]);
    expect(
      requiredQualifiers(line("1/2 cup grated vegetarian Parmesan cheese", "parmesan"), categoryOf),
    ).toEqual(["vegetarian"]);
    expect(
      requiredQualifiers(line("1 cup gluten-free long-grain rice", "white rice"), categoryOf),
    ).toEqual([]);
    expect(requiredQualifiers(line("1 cup brown rice", "brown rice"), categoryOf)).toEqual([]);
  });

  it("reports stray flesh against the protein tag", () => {
    const f = analyzeRecipe(
      [line("1 lb chicken thighs", "chicken thigh"), line("4 slices bacon", "bacon")],
      categoryOf,
    );
    expect(strayFlesh("chicken", f)).toEqual(["pork"]);
    expect(strayFlesh("pork", f)).toEqual(["chicken"]);
  });
});
