// Test harness only (WS06): a real Postgres for the suggest function's SQL, with no container.
//
// PGlite is Postgres compiled to WASM. With the pgvector and pg_trgm extensions it runs our
// migrations unchanged, so the hard-filter SQL is executed against the real recipes,
// recipe_ingredients, and ingredients tables rather than a hand-written copy. Two stand-ins
// matter:
//   * The version. PGlite 0.5 is Postgres 18; the hosted project and CI run Postgres 17. The SQL
//     used here is plain and stable across both.
//   * The platform. Supabase's auth and storage schemas and API roles are stubbed by
//     supabase-stubs.sql. Migrations that need Vault, pgmq, or pg_cron (WS07's retail migration,
//     the extensions migration) are not loaded.
// The planning tables (WS04: meal_plans, meal_plan_entries, recipe_feedback) and the catalog read
// policies are the repo's own migrations, loaded below like the rest. Nothing is copied.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { vector } from "@electric-sql/pglite-pgvector";
import type { SqlRunner } from "../candidates.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "..", "..", "migrations");

/** The migrations the harness applies, in order, by name (the timestamp prefix is ignored). */
export const HARNESS_MIGRATIONS = [
  "identity",
  "identity_functions",
  "ingredients",
  "proposals_household_fk",
  "recipes",
  "ai_runs",
  "planning",
  "ws06_preferences",
  "recipes_catalog_read",
] as const;

function migrationFile(name: string): string {
  const match = readdirSync(MIGRATIONS_DIR).find((file) =>
    new RegExp(`^\\d+_${name}\\.sql$`).test(file),
  );
  if (!match) throw new Error(`migration ${name} not found in ${MIGRATIONS_DIR}`);
  return join(MIGRATIONS_DIR, match);
}

export interface TestDb {
  db: PGlite;
  /** Runs one statement with parameters and returns its rows. Matches `SqlRunner`. */
  runner: SqlRunner;
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
  exec(text: string): Promise<void>;
  close(): Promise<void>;
}

export interface CreateTestDbOptions {
  /** Extra extensions, for example pgTAP when a script runs the pgTAP files. */
  extensions?: Record<string, unknown>;
}

export async function createTestDb(options: CreateTestDbOptions = {}): Promise<TestDb> {
  const db = new PGlite({
    extensions: { vector, pg_trgm, pgcrypto, ...(options.extensions ?? {}) } as never,
  });
  await db.exec(readFileSync(join(HERE, "supabase-stubs.sql"), "utf8"));
  await db.exec("create extension vector with schema extensions;");
  await db.exec("create extension pg_trgm with schema extensions;");
  await db.exec("create extension pgcrypto with schema extensions;");
  await db.exec('set search_path = "$user", public, extensions;');

  for (const name of HARNESS_MIGRATIONS) {
    await db.exec(readFileSync(migrationFile(name), "utf8"));
  }

  const query = async <T = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> => {
    const result = await db.query<T>(text, [...params]);
    return result.rows;
  };
  const wrap = (exec: {
    query<R>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  }): SqlRunner => ({
    query: async <R>(text: string, params: readonly unknown[]) =>
      (await exec.query<R>(text, [...params])).rows,
    transaction: async () => {
      throw new Error("nested transactions are not supported by the test runner");
    },
  });
  const runner: SqlRunner = {
    query: (text, params) => query(text, params),
    transaction: (fn) => db.transaction(async (tx) => fn(wrap(tx as never))),
  };
  return {
    db,
    runner,
    query,
    exec: async (text) => {
      await db.exec(text);
    },
    close: () => db.close(),
  };
}

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

export interface FixtureIngredient {
  name: string;
  category: string;
  plural?: string;
}

/** Inserts ingredients (and an alias for each name) and returns name -> id. */
export async function insertIngredients(
  t: TestDb,
  items: readonly FixtureIngredient[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const item of items) {
    const rows = await t.query<{ id: string }>(
      `insert into public.ingredients (name, plural, category, default_unit)
       values ($1, $2, $3, 'each') on conflict (name) do update set category = excluded.category
       returning id`,
      [item.name, item.plural ?? null, item.category],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error(`could not insert ingredient ${item.name}`);
    ids.set(item.name, id);
    await t.query(
      `insert into public.ingredient_aliases (ingredient_id, alias) values ($1, $2)
       on conflict (alias) do nothing`,
      [id, item.name],
    );
    if (item.plural) {
      await t.query(
        `insert into public.ingredient_aliases (ingredient_id, alias) values ($1, $2)
         on conflict (alias) do nothing`,
        [id, item.plural],
      );
    }
  }
  return ids;
}

export interface FixtureRecipe {
  id?: string;
  title: string;
  /** Null for a catalog recipe. */
  householdId: string | null;
  cuisine?: string | null;
  tags?: string[];
  prepMin?: number | null;
  cookMin?: number | null;
  servings?: number | null;
  embedding?: number[] | null;
  visibility?: "household" | "catalog";
  deletedAt?: string | null;
  /** Ingredient lines. `name` is the ontology name (null for a line the parser has not resolved). */
  lines: { rawText: string; name?: string | null; optional?: boolean }[];
}

/** Writes a vector as pgvector text, for example [0.1,0.2]. */
export function vectorLiteral(values: readonly number[]): string {
  return `[${values.join(",")}]`;
}

export async function insertRecipe(
  t: TestDb,
  recipe: FixtureRecipe,
  ingredientIds: ReadonlyMap<string, string>,
): Promise<string> {
  const visibility = recipe.visibility ?? (recipe.householdId ? "household" : "catalog");
  const rows = await t.query<{ id: string }>(
    `insert into public.recipes
       (id, household_id, title, source_type, servings, prep_min, cook_min, tags, cuisine,
        embedding, visibility, deleted_at)
     values (coalesce($1::uuid, gen_random_uuid()), $2, $3, 'manual', $4, $5, $6, $7::text[], $8,
        $9::extensions.vector, $10::public.recipes_visibility, $11)
     returning id`,
    [
      recipe.id ?? null,
      recipe.householdId,
      recipe.title,
      recipe.servings ?? 4,
      recipe.prepMin ?? null,
      recipe.cookMin ?? null,
      `{${(recipe.tags ?? []).map((tag) => `"${tag.replaceAll('"', '\\"')}"`).join(",")}}`,
      recipe.cuisine ?? null,
      recipe.embedding ? vectorLiteral(recipe.embedding) : null,
      visibility,
      recipe.deletedAt ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`could not insert recipe ${recipe.title}`);
  let position = 0;
  for (const line of recipe.lines) {
    const ingredientId = line.name ? (ingredientIds.get(line.name) ?? null) : null;
    if (line.name && !ingredientId) throw new Error(`unknown fixture ingredient ${line.name}`);
    await t.query(
      `insert into public.recipe_ingredients (recipe_id, position, raw_text, ingredient_id, optional)
       values ($1, $2, $3, $4, $5)`,
      [id, position, line.rawText, ingredientId, line.optional ?? false],
    );
    position += 1;
  }
  return id;
}

/** A user, a household, and the user as its owner. Returns their ids. */
export async function insertHousehold(
  t: TestDb,
  ids: { userId: string; householdId: string; name?: string; email?: string },
): Promise<void> {
  await t.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [
    ids.userId,
    ids.email ?? `${ids.userId}@example.test`,
  ]);
  await t.query(`insert into public.households (id, name, created_by) values ($1, $2, $3)`, [
    ids.householdId,
    ids.name ?? "Test House",
    ids.userId,
  ]);
  await t.query(
    `insert into public.household_members (household_id, user_id, role) values ($1, $2, 'owner')`,
    [ids.householdId, ids.userId],
  );
}
