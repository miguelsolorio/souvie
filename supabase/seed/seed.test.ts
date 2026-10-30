import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INGREDIENT_CATEGORIES } from "../../packages/core/src/ingredient.ts";
import { CONTAINER_WEIGHTS_G, isUnitCode, PACK_SIZES } from "../../packages/core/src/units.ts";
import { ingredientId, parseCsv, readSeed, renderSeedSql, SEED_SQL_PATH, uuidV5 } from "./load.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const seed = readSeed(HERE);

describe("ontology seed (WS03 acceptance 1 and 2)", () => {
  it("has at least 600 ingredients and 1,200 aliases", () => {
    expect(seed.ingredients.length).toBeGreaterThanOrEqual(600);
    expect(seed.aliases.length).toBeGreaterThanOrEqual(1200);
  });

  it("uses only the 16 store sections, and every one is in use", () => {
    const allowed = new Set<string>(INGREDIENT_CATEGORIES);
    const used = new Set<string>();
    for (const ing of seed.ingredients) {
      expect(allowed.has(ing.category), `${ing.name}: ${ing.category}`).toBe(true);
      used.add(ing.category);
    }
    expect([...used].sort()).toEqual([...allowed].sort());
  });

  it("gives every ingredient a default unit that units.ts knows", () => {
    for (const ing of seed.ingredients) {
      expect(isUnitCode(ing.defaultUnit), `${ing.name}: ${ing.defaultUnit}`).toBe(true);
    }
  });

  it("has at least 150 densities and 100 typical unit weights, all positive", () => {
    const withDensity = seed.ingredients.filter((i) => i.densityGPerMl !== null);
    const withWeight = seed.ingredients.filter((i) => i.typicalUnitWeightG !== null);
    expect(withDensity.length).toBeGreaterThanOrEqual(150);
    expect(withWeight.length).toBeGreaterThanOrEqual(100);
    for (const i of withDensity) expect(i.densityGPerMl, i.name).toBeGreaterThan(0);
    for (const i of withWeight) expect(i.typicalUnitWeightG, i.name).toBeGreaterThan(0);
    // A density above 2.5 g/ml (denser than rock salt) or below 0.05 is a typo.
    for (const i of withDensity) {
      expect(i.densityGPerMl as number, i.name).toBeLessThan(2.5);
      expect(i.densityGPerMl as number, i.name).toBeGreaterThan(0.05);
    }
  });

  it("keeps names unique, lowercase, and trimmed", () => {
    const names = new Set<string>();
    for (const ing of seed.ingredients) {
      expect(ing.name, ing.name).toBe(ing.name.toLowerCase().trim());
      expect(names.has(ing.name), `duplicate ingredient ${ing.name}`).toBe(false);
      names.add(ing.name);
    }
  });

  it("keeps aliases unique, lowercase, trimmed, and attached to a real ingredient", () => {
    const names = new Set(seed.ingredients.map((i) => i.name));
    const seen = new Set<string>();
    for (const a of seed.aliases) {
      expect(names.has(a.ingredientName), `${a.alias} -> ${a.ingredientName}`).toBe(true);
      expect(a.alias, a.alias).toBe(a.alias.toLowerCase().trim());
      expect(a.alias.includes(","), a.alias).toBe(false);
      expect(seen.has(a.alias), `duplicate alias ${a.alias}`).toBe(false);
      seen.add(a.alias);
    }
  });

  it("makes every ingredient name and plural resolvable as an alias of itself", () => {
    const owner = new Map(seed.aliases.map((a) => [a.alias, a.ingredientName]));
    for (const ing of seed.ingredients) {
      expect(owner.get(ing.name), `name ${ing.name}`).toBe(ing.name);
      if (ing.plural) expect(owner.get(ing.plural), `plural ${ing.plural}`).toBe(ing.name);
    }
  });

  it("names every ingredient that units.ts keeps a pack size or container weight for", () => {
    const names = new Set(seed.ingredients.map((i) => i.name));
    for (const name of [...Object.keys(PACK_SIZES), ...Object.keys(CONTAINER_WEIGHTS_G)]) {
      expect(names.has(name), `units.ts refers to unknown ingredient "${name}"`).toBe(true);
    }
  });

  it("does not seed gochugaru, which the parser acceptance test uses as an unknown", () => {
    expect(seed.ingredients.some((i) => i.name.includes("gochugaru"))).toBe(false);
    expect(seed.aliases.some((a) => a.alias.includes("gochugaru"))).toBe(false);
  });

  it("matches the committed SQL, so db reset loads exactly these CSVs", () => {
    expect(readFileSync(SEED_SQL_PATH, "utf8")).toBe(renderSeedSql(seed));
  });

  it("starts from the header in the brief", () => {
    const firstLine = readFileSync(join(HERE, "ingredients.csv"), "utf8").split("\n")[0];
    expect(firstLine).toBe(
      "name,plural,category,default_unit,density_g_per_ml,typical_unit_weight_g,usda_fdc_id,is_staple_default",
    );
  });
});

describe("ids and CSV", () => {
  it("derives ingredient ids as UUID v5 of the name, stable across machines", () => {
    // RFC 9562 test vector: uuid v5 of "www.example.com" in the DNS namespace.
    expect(uuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
    expect(ingredientId("yellow onion")).toBe(ingredientId("yellow onion"));
    expect(ingredientId("yellow onion")).not.toBe(ingredientId("red onion"));
    expect(ingredientId("yellow onion")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("parses quoted fields and doubled quotes", () => {
    expect(parseCsv('a,"b,c",d\n"he said ""hi""",,x\n')).toEqual([
      ["a", "b,c", "d"],
      ['he said "hi"', "", "x"],
    ]);
  });
});
