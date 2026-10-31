// Test harness only (WS05): puts a buildList fixture (packages/core/src/list/fixtures) into the
// PGlite database as a real household, recipes, ingredient lines, a plan and its entries, so the
// store's SQL runs on the same data the pure tests use.
import {
  IdMap,
  inputOf,
  type ListFixture,
  ONTOLOGY,
} from "../../../../packages/core/src/list/fixtures/harness.ts";
import type { TestDb } from "./db.ts";

export const USER_ID = "a1111111-1111-4111-8111-111111111111";
export const HOUSEHOLD_ID = "0a000000-0000-4000-8000-00000000000a";
export const WEEK_START = "2026-11-02";

export interface Seeded {
  ids: IdMap;
  planId: string;
  householdId: string;
  userId: string;
  weekStart: string;
}

/** A user, a household, and the user as its owner. Safe to call twice. */
export async function insertHousehold(
  t: TestDb,
  ids: { userId: string; householdId: string; name?: string },
): Promise<void> {
  await t.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [
    ids.userId,
    `${ids.userId}@example.test`,
  ]);
  await t.query(
    `insert into public.households (id, name, created_by) values ($1, $2, $3)
     on conflict (id) do nothing`,
    [ids.householdId, ids.name ?? "Test House", ids.userId],
  );
  await t.query(
    `insert into public.household_members (household_id, user_id, role) values ($1, $2, 'owner')
     on conflict do nothing`,
    [ids.householdId, ids.userId],
  );
}

/** The ontology snapshot the fixtures use, with the seed's ids. */
export async function insertOntology(t: TestDb): Promise<void> {
  for (const ingredient of ONTOLOGY) {
    await t.query(
      `insert into public.ingredients
         (id, name, plural, category, default_unit, density_g_per_ml, typical_unit_weight_g,
          usda_fdc_id, is_staple_default)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (id) do nothing`,
      [
        ingredient.id,
        ingredient.name,
        ingredient.plural,
        ingredient.category,
        ingredient.defaultUnit,
        ingredient.densityGPerMl,
        ingredient.typicalUnitWeightG,
        ingredient.usdaFdcId,
        ingredient.isStapleDefault,
      ],
    );
  }
}

/**
 * Writes the fixture's recipes, plan, entries and pantry for the household. Entries whose recipe
 * is not in the fixture (a "ghost") are skipped, because the planner's trigger refuses them.
 */
export async function seedFixture(
  t: TestDb,
  fixture: ListFixture,
  who: { userId?: string; householdId?: string; weekStart?: string } = {},
): Promise<Seeded> {
  const userId = who.userId ?? USER_ID;
  const householdId = who.householdId ?? HOUSEHOLD_ID;
  const weekStart = who.weekStart ?? WEEK_START;
  const ids = new IdMap();
  const input = inputOf(fixture, ids);

  await insertHousehold(t, { userId, householdId });
  await insertOntology(t);

  for (const recipe of input.recipes) {
    await t.query(
      `insert into public.recipes (id, household_id, title, source_type, servings, deleted_at)
       values ($1, $2, $3, 'manual', $4, $5)`,
      [recipe.id, householdId, recipe.title, recipe.servings, recipe.deleted_at ?? null],
    );
    for (const line of recipe.ingredients) {
      await t.query(
        `insert into public.recipe_ingredients
           (id, recipe_id, position, raw_text, qty, qty_max, unit, ingredient_id, prep_note,
            optional, container_count, container)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          line.id,
          recipe.id,
          line.position,
          line.raw_text,
          line.qty,
          line.qty_max ?? null,
          line.unit,
          line.ingredient_id,
          line.prep_note,
          line.optional,
          line.container_count ?? null,
          line.container ?? null,
        ],
      );
    }
  }

  const planRows = await t.query<{ id: string }>(
    `insert into public.meal_plans (household_id, week_start) values ($1, $2) returning id`,
    [householdId, weekStart],
  );
  const planId = planRows[0]?.id;
  if (!planId) throw new Error("could not insert the plan");
  const known = new Set(input.recipes.map((recipe) => recipe.id));
  for (const entry of input.entries) {
    if (!known.has(entry.recipe_id)) continue;
    await t.query(
      `insert into public.meal_plan_entries
         (id, plan_id, household_id, date, slot, recipe_id, servings, status, position)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.id,
        planId,
        householdId,
        entry.date,
        entry.slot,
        entry.recipe_id,
        entry.servings,
        entry.status,
        entry.position,
      ],
    );
  }
  for (const row of input.pantry) {
    await t.query(
      `insert into public.pantry_items (household_id, ingredient_id, status) values ($1, $2, $3)`,
      [householdId, row.ingredient_id, row.status],
    );
  }
  return { ids, planId, householdId, userId, weekStart };
}
