// The suggest function against WS16's shipped starter catalog (supabase/seed/20_catalog.sql, 62
// recipes), loaded after the ontology the way `supabase db reset` loads it. The other tests build
// their own small corpus; this one makes sure the real rows work with backfill and the filters,
// and that nothing here counts recipes without knowing the catalog is there.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSIONS } from "../../../packages/llm/src/index.ts";
import { fetchCandidates } from "./candidates.ts";
import { buildFilterSpec, filterInputFromPreferences } from "./filters.ts";
import { embedMissingRecipes } from "./profile-embedding.ts";
import { FIXTURE_HOUSEHOLD, FIXTURE_USER, readHouseholdFixtures } from "./testing/corpus.ts";
import { createTestDb, insertHousehold, type TestDb } from "./testing/db.ts";

const SEED_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "seed");

let t: TestDb;
let catalogCount = 0;

beforeAll(async () => {
  t = await createTestDb();
  await t.exec(readFileSync(join(SEED_DIR, "10_ingredients.sql"), "utf8"));
  await t.exec(readFileSync(join(SEED_DIR, "20_catalog.sql"), "utf8"));
  await insertHousehold(t, { userId: FIXTURE_USER, householdId: FIXTURE_HOUSEHOLD });
  catalogCount = (
    await t.query<{ n: number }>(
      "select count(*)::int as n from public.recipes where visibility = 'catalog' and deleted_at is null",
    )
  )[0]?.n as number;
}, 60_000);

afterAll(async () => {
  await t.close();
});

describe("the starter catalog", () => {
  it("is loaded: about sixty recipes, none embedded yet", async () => {
    expect(catalogCount).toBeGreaterThanOrEqual(60);
    const embedded = await t.query<{ n: number }>(
      "select count(*)::int as n from public.recipes where visibility = 'catalog' and embedding is not null",
    );
    expect(embedded[0]?.n).toBe(0);
  });

  it("is embedded by a household's backfill, in batches, and a repeat changes nothing", async () => {
    const embed = async (texts: readonly string[]) =>
      texts.map(() => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0)));
    const first = await embedMissingRecipes(t.runner, {
      householdId: FIXTURE_HOUSEHOLD,
      limit: 50,
      embed,
    });
    expect(first.embedded).toBe(50);
    expect(first.remaining).toBe(catalogCount - 50);
    const second = await embedMissingRecipes(t.runner, {
      householdId: FIXTURE_HOUSEHOLD,
      limit: 50,
      embed,
    });
    expect(second.embedded).toBe(catalogCount - 50);
    expect(second.remaining).toBe(0);
    const third = await embedMissingRecipes(t.runner, {
      householdId: FIXTURE_HOUSEHOLD,
      limit: 50,
      embed,
    });
    expect(third).toEqual({ embedded: 0, remaining: 0 });
  });
});

describe("the filters on the starter catalog", () => {
  for (const fixture of readHouseholdFixtures()) {
    it(`${fixture.name}: both engines agree and every candidate lists ingredients`, async () => {
      const spec = buildFilterSpec(filterInputFromPreferences(fixture.preferences));
      const { candidates, dropped } = await fetchCandidates(t.runner, {
        householdId: FIXTURE_HOUSEHOLD,
        spec,
        tasteEmbedding: null,
        cuisines: fixture.preferences.cuisines ?? [],
        warn: () => {},
      });
      // The SQL and the TypeScript re-check agree on every recipe the SQL returned.
      expect(dropped).toEqual([]);
      expect(candidates.every((c) => c.visibility === "catalog")).toBe(true);
      // The catalog has plenty for every household except possibly the strictest.
      if (fixture.name !== "household-10-all-nine") {
        expect(candidates.length, fixture.name).toBeGreaterThan(0);
      }
      // A household with an allergy or a diet never gets a recipe with no ingredient lines.
      if (spec.requireIngredientLines && candidates.length > 0) {
        const lines = await t.query<{ n: number }>(
          `select count(*)::int as n from public.recipes r
            where r.id = any($1::uuid[])
              and not exists (select 1 from public.recipe_ingredients ri where ri.recipe_id = r.id)`,
          [candidates.map((c) => c.id)],
        );
        expect(lines[0]?.n).toBe(0);
      }
    });
  }
});
