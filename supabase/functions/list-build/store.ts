// Database access for list-build (WS05), all through one SqlRunner.
//
// The function connects as the database owner (SUPABASE_DB_URL), which is more than it needs: it
// could create tables. So every transaction here starts with `set local role service_role`. That
// keeps the table privileges the function uses and bypasses Row Level Security like the service
// role does, and it loses the owner's ability to run DDL (a test proves a `create table` inside
// fails). Because RLS is bypassed, every statement names the household explicitly, the rule for
// service-role code in docs/02-data-model.md §RLS pattern: membership is checked once, before
// anything else, and the household id in every later query comes from that check.
//
// A build is one transaction. Devices read the list through Realtime and refetches, so they see
// the list before the build or after it, never an empty list in between.
//
// Tables owned by others: meal_plans, meal_plan_entries (WS04), recipes, recipe_ingredients (WS02),
// ingredients (WS03). Columns read are listed in README.md.
import {
  buildList,
  type ExistingListItem,
  type Ingredient,
  type ItemWrite,
  type ListBuildResponse,
  type ListEntry,
  type ListIngredientLine,
  type ListRecipe,
  type PantryEntry,
  planFingerprint,
  reconcileItems,
} from "../../../packages/core/src/index.ts";
import type { SqlRunner } from "./sql.ts";

/** The role every transaction drops to. See the file comment. */
export const SERVICE_ROLE_STATEMENT = "set local role service_role";

/** The week has no plan row, so there is nothing to build a list from. */
export class NoPlanError extends Error {
  constructor() {
    super("no_plan");
    this.name = "NoPlanError";
  }
}

export type Membership =
  | { kind: "member"; householdId: string }
  | { kind: "not_a_member" }
  | { kind: "no_household" };

export interface BuildInput {
  householdId: string;
  /** A Monday, YYYY-MM-DD. */
  weekStart: string;
  now: Date;
}

interface EntryRow {
  id: string;
  recipe_id: string;
  date: string;
  slot: ListEntry["slot"];
  servings: number;
  status: ListEntry["status"];
  position: number;
}

interface RecipeRow {
  id: string;
  title: string;
  servings: number | null;
  deleted: boolean;
}

interface LineRow {
  id: string;
  recipe_id: string;
  position: number;
  raw_text: string;
  qty: number | null;
  qty_max: number | null;
  unit: string | null;
  ingredient_id: string | null;
  prep_note: string | null;
  optional: boolean;
  container_count: number | null;
  container: string | null;
}

interface IngredientRow {
  id: string;
  name: string;
  plural: string | null;
  category: Ingredient["category"];
  default_unit: string;
  density_g_per_ml: number | null;
  typical_unit_weight_g: number | null;
  usda_fdc_id: number | null;
  is_staple_default: boolean;
}

interface ExistingItemRow {
  id: string;
  ingredient_id: string | null;
  display_name: string;
  qualifiers: string[] | null;
  qty: number | null;
  unit: string | null;
  section: string;
  excluded_reason: ExistingListItem["excluded_reason"];
  is_manual: boolean;
  edited: boolean;
  position: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Week of Nov 2" for 2026-11-02. */
export function listNameFor(weekStart: string): string {
  const [, month, day] = weekStart.split("-");
  const name = MONTHS[Number(month) - 1] ?? "";
  return `Week of ${name} ${Number(day)}`;
}

function toIngredient(row: IngredientRow): Ingredient {
  return {
    id: row.id,
    name: row.name,
    plural: row.plural,
    category: row.category,
    defaultUnit: row.default_unit,
    densityGPerMl: row.density_g_per_ml,
    typicalUnitWeightG: row.typical_unit_weight_g,
    usdaFdcId: row.usda_fdc_id,
    isStapleDefault: row.is_staple_default,
  };
}

const ITEM_COLUMNS = `ingredient_id uuid, display_name text, qty numeric, unit text,
  source_entry_ids uuid[], section text, excluded_reason text, needs_attention boolean,
  position integer, qualifiers text[], detail jsonb, edited boolean`;

export class SqlListStore {
  constructor(private readonly sql: SqlRunner) {}

  /** Runs `fn` in one transaction as service_role. Every method below goes through it. */
  private inServiceRole<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T> {
    return this.sql.transaction(async (tx) => {
      await tx.query(SERVICE_ROLE_STATEMENT, []);
      return fn(tx);
    });
  }

  /**
   * The household a request acts in. With an id, the caller must be a member of it. Without one,
   * it is the household they joined most recently. A soft-deleted household does not count.
   */
  async resolveHousehold(userId: string, requested?: string): Promise<Membership> {
    return this.inServiceRole(async (tx) => {
      if (requested) {
        const rows = await tx.query(
          `select 1 as ok
             from public.household_members hm
             join public.households h on h.id = hm.household_id and h.deleted_at is null
            where hm.household_id = $1::uuid and hm.user_id = $2::uuid`,
          [requested, userId],
        );
        return rows.length > 0
          ? ({ kind: "member", householdId: requested } as const)
          : ({ kind: "not_a_member" } as const);
      }
      const rows = await tx.query<{ household_id: string }>(
        `select hm.household_id
           from public.household_members hm
           join public.households h on h.id = hm.household_id and h.deleted_at is null
          where hm.user_id = $1::uuid
          order by hm.created_at desc, hm.household_id
          limit 1`,
        [userId],
      );
      const first = rows[0];
      return first
        ? ({ kind: "member", householdId: first.household_id } as const)
        : ({ kind: "no_household" } as const);
    });
  }

  /**
   * Builds the week's list and writes it, or refreshes the list the plan already has. Checked
   * state, manual items and edits survive (reconcileItems). Throws NoPlanError when the week has no
   * plan row.
   */
  async build(input: BuildInput): Promise<ListBuildResponse> {
    const { householdId, weekStart } = input;
    return this.inServiceRole(async (tx) => {
      // Two phones tapping "Generate list" at once build one list, one after the other.
      await tx.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [
        `list-build:${householdId}:${weekStart}`,
      ]);

      const plans = await tx.query<{ id: string }>(
        `select id from public.meal_plans where household_id = $1::uuid and week_start = $2::date`,
        [householdId, weekStart],
      );
      const plan = plans[0];
      if (!plan) throw new NoPlanError();

      const entries = await tx.query<EntryRow>(
        `select id, recipe_id, date::text as date, slot::text as slot,
                servings::float8 as servings, status::text as status, position
           from public.meal_plan_entries
          where plan_id = $1::uuid and household_id = $2::uuid`,
        [plan.id, householdId],
      );
      const recipeIds = [...new Set(entries.map((entry) => entry.recipe_id))];

      // The household's own recipes and the starter catalog, which every member can plan.
      const recipeRows = recipeIds.length
        ? await tx.query<RecipeRow>(
            `select id, title, servings::float8 as servings, deleted_at is not null as deleted
               from public.recipes
              where id = any($1::uuid[])
                and (household_id = $2::uuid or visibility = 'catalog')`,
            [recipeIds, householdId],
          )
        : [];
      const lineRows = recipeRows.length
        ? await tx.query<LineRow>(
            `select id, recipe_id, position, raw_text, qty::float8 as qty, qty_max::float8 as qty_max,
                    unit, ingredient_id, prep_note, optional, container_count, container
               from public.recipe_ingredients
              where recipe_id = any($1::uuid[])
              order by recipe_id, position`,
            [recipeRows.map((recipe) => recipe.id)],
          )
        : [];
      const ingredientIds = [
        ...new Set(lineRows.flatMap((line) => (line.ingredient_id ? [line.ingredient_id] : []))),
      ];
      const ingredientRows = ingredientIds.length
        ? await tx.query<IngredientRow>(
            `select id, name, plural, category, default_unit,
                    density_g_per_ml::float8 as density_g_per_ml,
                    typical_unit_weight_g::float8 as typical_unit_weight_g,
                    usda_fdc_id, is_staple_default
               from public.ingredients
              where id = any($1::uuid[])`,
            [ingredientIds],
          )
        : [];
      const pantry = await tx.query<PantryEntry>(
        `select ingredient_id, status::text as status
           from public.pantry_items where household_id = $1::uuid`,
        [householdId],
      );

      const existingLists = await tx.query<{
        id: string;
        plan_version: number;
        section_order: string[] | null;
      }>(
        `select id, plan_version, section_order
           from public.grocery_lists
          where plan_id = $1::uuid and household_id = $2::uuid and deleted_at is null
          for update`,
        [plan.id, householdId],
      );
      const existing = existingLists[0];

      let sectionOrder = existing?.section_order ?? null;
      if (!existing) {
        // A new list starts from the aisle order the household last chose.
        const previous = await tx.query<{ section_order: string[] }>(
          `select section_order from public.grocery_lists
            where household_id = $1::uuid and section_order is not null and deleted_at is null
            order by created_at desc limit 1`,
          [householdId],
        );
        sectionOrder = previous[0]?.section_order ?? null;
      }

      const linesByRecipe = new Map<string, ListIngredientLine[]>();
      for (const line of lineRows) {
        const list = linesByRecipe.get(line.recipe_id) ?? [];
        list.push({
          id: line.id,
          position: line.position,
          raw_text: line.raw_text,
          qty: line.qty,
          qty_max: line.qty_max,
          unit: line.unit,
          ingredient_id: line.ingredient_id,
          prep_note: line.prep_note,
          optional: line.optional,
          container_count: line.container_count,
          container: line.container,
        });
        linesByRecipe.set(line.recipe_id, list);
      }
      const recipes: ListRecipe[] = recipeRows.map((recipe) => ({
        id: recipe.id,
        title: recipe.title,
        servings: recipe.servings,
        deleted_at: recipe.deleted ? input.now.toISOString() : null,
        ingredients: linesByRecipe.get(recipe.id) ?? [],
      }));

      const draft = buildList({
        entries,
        recipes,
        ingredients: new Map(ingredientRows.map((row) => [row.id, toIngredient(row)])),
        pantry,
        options: sectionOrder ? { sectionOrder } : {},
      });
      const fingerprint = planFingerprint(entries);

      const nowIso = input.now.toISOString();
      let listId: string;
      let planVersion: number;
      if (existing) {
        listId = existing.id;
        planVersion = existing.plan_version + 1;
        await tx.query(
          `update public.grocery_lists
              set built_at = $2::timestamptz, plan_version = $3::int, plan_fingerprint = $4::text,
                  status = 'active'
            where id = $1::uuid and household_id = $5::uuid`,
          [listId, nowIso, planVersion, fingerprint, householdId],
        );
      } else {
        planVersion = 1;
        const created = await tx.query<{ id: string }>(
          `insert into public.grocery_lists
             (household_id, plan_id, name, status, built_at, plan_version, plan_fingerprint,
              section_order)
           values ($1::uuid, $2::uuid, $3::text, 'active', $4::timestamptz, 1, $5::text,
                   $6::text[])
           returning id`,
          [householdId, plan.id, listNameFor(weekStart), nowIso, fingerprint, sectionOrder],
        );
        const row = created[0];
        if (!row) throw new Error("grocery_lists insert returned no row");
        listId = row.id;
      }

      const itemRows = existing
        ? await tx.query<ExistingItemRow>(
            `select id, ingredient_id, display_name, qualifiers, qty::float8 as qty, unit, section,
                    excluded_reason::text as excluded_reason, is_manual, edited, position
               from public.grocery_list_items
              where list_id = $1::uuid and household_id = $2::uuid`,
            [listId, householdId],
          )
        : [];
      const changes = reconcileItems(
        itemRows.map((row) => ({ ...row, qualifiers: row.qualifiers ?? [] })),
        draft.items,
      );

      if (changes.deletes.length > 0) {
        await tx.query(
          `delete from public.grocery_list_items
            where id = any($1::uuid[]) and list_id = $2::uuid and household_id = $3::uuid
              and not is_manual`,
          [changes.deletes, listId, householdId],
        );
      }
      if (changes.updates.length > 0) {
        await tx.query(
          `update public.grocery_list_items i
              set ingredient_id = x.ingredient_id, display_name = x.display_name, qty = x.qty,
                  unit = x.unit, source_entry_ids = x.source_entry_ids, section = x.section,
                  excluded_reason = x.excluded_reason::public.grocery_list_items_excluded_reason,
                  needs_attention = x.needs_attention, position = x.position,
                  qualifiers = x.qualifiers, detail = x.detail, edited = x.edited
             from jsonb_to_recordset($1::jsonb) as x(id uuid, ${ITEM_COLUMNS})
            where i.id = x.id and i.list_id = $2::uuid and i.household_id = $3::uuid
              and (i.ingredient_id, i.display_name, i.qty, i.unit, i.source_entry_ids, i.section,
                   i.excluded_reason, i.needs_attention, i.position, i.qualifiers, i.detail,
                   i.edited)
                  is distinct from
                  (x.ingredient_id, x.display_name, x.qty, x.unit, x.source_entry_ids, x.section,
                   x.excluded_reason::public.grocery_list_items_excluded_reason,
                   x.needs_attention, x.position, x.qualifiers, x.detail, x.edited)`,
          [
            JSON.stringify(changes.updates.map((update) => ({ id: update.id, ...update.write }))),
            listId,
            householdId,
          ],
        );
      }
      if (changes.inserts.length > 0) {
        await tx.query(
          `insert into public.grocery_list_items
             (list_id, household_id, ingredient_id, display_name, qty, unit, source_entry_ids,
              section, excluded_reason, needs_attention, position, qualifiers, detail, edited)
           select $2::uuid, $3::uuid, x.ingredient_id, x.display_name, x.qty, x.unit,
                  x.source_entry_ids, x.section,
                  x.excluded_reason::public.grocery_list_items_excluded_reason,
                  x.needs_attention, x.position, x.qualifiers, x.detail, x.edited
             from jsonb_to_recordset($1::jsonb) as x(${ITEM_COLUMNS})`,
          [JSON.stringify(changes.inserts satisfies ItemWrite[]), listId, householdId],
        );
      }

      const counts = await tx.query<{ items: number; attention: number; have: number }>(
        `select count(*) filter (where excluded_reason is null)::int as items,
                count(*) filter (where excluded_reason is null and needs_attention)::int
                  as attention,
                count(*) filter (where excluded_reason = 'pantry')::int as have
           from public.grocery_list_items
          where list_id = $1::uuid and household_id = $2::uuid`,
        [listId, householdId],
      );
      const total = counts[0] ?? { items: 0, attention: 0, have: 0 };
      return {
        ok: true,
        listId,
        itemCount: total.items,
        needsAttentionCount: total.attention,
        alreadyHaveCount: total.have,
        planVersion,
        skippedEntryCount: draft.skippedEntries.length,
        rebuilt: existing !== undefined,
      };
    });
  }
}
