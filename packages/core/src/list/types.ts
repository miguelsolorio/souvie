// Grocery list schemas and the input and output types of `buildList` (WS05). Row shapes mirror
// supabase/migrations/*_lists.sql, so `GroceryList`, `GroceryListItem` and `PantryItem` use the
// database's snake_case column names. The draft that `buildList` returns is camelCase, like
// `Ingredient` and `ParsedIngredient`. docs/02-data-model.md §Lists and pantry and
// docs/03-ai-design.md §6 are the references.
//
// Pure: no I/O. Relative imports carry the .ts extension so Deno (Edge Functions) can load it.
import { z } from "zod";
import { INGREDIENT_CATEGORIES, IngredientCategorySchema } from "../ingredient.ts";
import { IsoDate, isWeekStart } from "../planning.ts";

/** Timestamps as PostgREST returns them, for example 2026-10-30T07:12:14.123456+00:00. */
const Timestamp = z.iso.datetime({ offset: true });

// ---------------------------------------------------------------------------------------
// Enums and limits
// ---------------------------------------------------------------------------------------

/** The store sections. They are the ingredient categories, so a category is its own section. */
export const SECTIONS = INGREDIENT_CATEGORIES;
export const Section = IngredientCategorySchema;
export type Section = z.infer<typeof Section>;

/** Postgres enum grocery_lists_status. */
export const GROCERY_LIST_STATUSES = ["draft", "active", "shopped"] as const;
export const GroceryListStatus = z.enum(GROCERY_LIST_STATUSES);
export type GroceryListStatus = z.infer<typeof GroceryListStatus>;

/** Postgres enum grocery_list_items_excluded_reason. */
export const EXCLUDED_REASONS = ["pantry", "manual"] as const;
export const ExcludedReason = z.enum(EXCLUDED_REASONS);
export type ExcludedReason = z.infer<typeof ExcludedReason>;

/** Postgres enum pantry_items_status. */
export const PANTRY_STATUSES = ["have", "low", "out"] as const;
export const PantryStatus = z.enum(PANTRY_STATUSES);
export type PantryStatus = z.infer<typeof PantryStatus>;

/** Limits the database also enforces (CHECK constraints in the lists migration). */
export const LIST_LIMITS = {
  name: 120,
  /** An unparsed line is named by its raw text, which can be as long as a recipe line. */
  displayName: 500,
  unit: 40,
  section: 40,
  qtyMax: 1_000_000,
  position: 1_000_000,
  qualifiers: 8,
  qualifierLength: 40,
} as const;

// ---------------------------------------------------------------------------------------
// What a list item remembers about how it was made (grocery_list_items.detail)
// ---------------------------------------------------------------------------------------

/** One recipe entry's share of an item, in the item's working unit (before rounding). */
export const Contribution = z.object({
  entryId: z.uuid(),
  recipeTitle: z.string(),
  /** The servings planned for the entry, which the recipe's quantities were scaled to. */
  servings: z.number(),
  /** The recipe's own servings when it states them. The scale factor is servings / recipeServings. */
  recipeServings: z.number().nullable().optional(),
  /** The converted quantity this entry adds, in `unit`. Null for "to taste" and unparsed lines. */
  qty: z.number().nullable(),
  unit: z.string().nullable(),
  /** The ingredient lines as the recipe wrote them. */
  rawTexts: z.array(z.string()),
  /** True when every line was marked optional in the recipe. */
  optional: z.boolean().optional(),
  /** Something the person should know about this share: a missing serving count, an unscaled line. */
  note: z.string().optional(),
});
export type Contribution = z.infer<typeof Contribution>;

/** The rounding step that took the summed quantity to something a person can buy. */
export const Rounding = z.object({
  from: z.number(),
  fromUnit: z.string(),
  to: z.number(),
  toUnit: z.string(),
  /** A short sentence for the "Why this amount" sheet: "round up to whole units". */
  rule: z.string(),
});
export type Rounding = z.infer<typeof Rounding>;

/** Why an item carries the needs-attention flag. */
export const ATTENTION_REASONS = ["unparsed", "mixed_units", "unknown_unit"] as const;
export const AttentionReason = z.enum(ATTENTION_REASONS);
export type AttentionReason = z.infer<typeof AttentionReason>;

/** grocery_list_items.detail: the "Why this amount" data, written only by `list-build`. */
export const ItemDetail = z.object({
  contributions: z.array(Contribution).default([]),
  rounding: Rounding.nullable().optional(),
  attention: AttentionReason.nullable().optional(),
});
export type ItemDetail = z.infer<typeof ItemDetail>;

// ---------------------------------------------------------------------------------------
// Database rows
// ---------------------------------------------------------------------------------------

export const GroceryList = z.object({
  id: z.uuid(),
  household_id: z.uuid(),
  /** Null for an ad-hoc list. A plan has at most one live list. */
  plan_id: z.uuid().nullable(),
  name: z.string().min(1).max(LIST_LIMITS.name),
  status: GroceryListStatus,
  /** When the items were last aggregated. */
  built_at: Timestamp.nullable(),
  /** Build counter: 1 for the first build, +1 on every rebuild. */
  plan_version: z.number().int().min(0),
  /** SHA-256 of the plan's entries at build time (`planFingerprint`). Null for an ad-hoc list. */
  plan_fingerprint: z.string().nullable(),
  /** The household's own aisle order for this list. Null means the default order. */
  section_order: z.array(z.string()).nullable(),
  created_at: Timestamp,
  updated_at: Timestamp,
  deleted_at: Timestamp.nullable(),
});
export type GroceryList = z.infer<typeof GroceryList>;

export const GroceryListItem = z.object({
  id: z.uuid(),
  list_id: z.uuid(),
  household_id: z.uuid(),
  /** Null for a free-text item (a manual add, or a recipe line the parser could not match). */
  ingredient_id: z.uuid().nullable(),
  display_name: z.string().min(1).max(LIST_LIMITS.displayName),
  qty: z.number().nullable(),
  unit: z.string().nullable(),
  source_entry_ids: z.array(z.uuid()),
  section: z.string(),
  checked: z.boolean(),
  checked_by: z.uuid().nullable(),
  checked_at: Timestamp.nullable(),
  excluded_reason: ExcludedReason.nullable(),
  needs_attention: z.boolean(),
  is_manual: z.boolean(),
  position: z.number().int(),
  /** "gluten-free", "unsalted": what the recipe line asked for beyond the ingredient. */
  qualifiers: z.array(z.string()),
  /** True once a person changed the quantity, unit or section; a rebuild keeps those. */
  edited: z.boolean(),
  detail: ItemDetail,
  created_at: Timestamp,
  updated_at: Timestamp,
});
export type GroceryListItem = z.infer<typeof GroceryListItem>;

export const PantryItem = z.object({
  household_id: z.uuid(),
  ingredient_id: z.uuid(),
  status: PantryStatus,
  updated_at: Timestamp,
});
export type PantryItem = z.infer<typeof PantryItem>;

/** What `buildList` reads of a pantry row. */
export type PantryEntry = Pick<PantryItem, "ingredient_id" | "status">;

/** What a client may write when it adds a free-text item to a list. */
export const ManualItemInput = z.object({
  display_name: z.string().trim().min(1).max(LIST_LIMITS.displayName),
  qty: z.number().positive().max(LIST_LIMITS.qtyMax).nullable().default(null),
  unit: z.string().trim().min(1).max(LIST_LIMITS.unit).nullable().default(null),
  section: z.string().trim().min(1).max(LIST_LIMITS.section).default("other"),
});
export type ManualItemInput = z.input<typeof ManualItemInput>;

/** The columns a person may change on an item that exists. */
export const ItemPatch = z
  .object({
    qty: z.number().positive().max(LIST_LIMITS.qtyMax).nullable(),
    unit: z.string().trim().min(1).max(LIST_LIMITS.unit).nullable(),
    section: z.string().trim().min(1).max(LIST_LIMITS.section),
    display_name: z.string().trim().min(1).max(LIST_LIMITS.displayName),
    excluded_reason: ExcludedReason.nullable(),
  })
  .partial();
export type ItemPatch = z.infer<typeof ItemPatch>;

// ---------------------------------------------------------------------------------------
// buildList: input
// ---------------------------------------------------------------------------------------

/**
 * One ingredient line of a recipe, as `buildList` reads it. `RecipeIngredient` satisfies it; the
 * two container columns are what CCR5 added to `recipe_ingredients` (null or absent when the line
 * names no container).
 */
export interface ListIngredientLine {
  id: string;
  position: number;
  raw_text: string;
  /** Lower bound when the line gives a range. */
  qty: number | null;
  /** Upper bound of a range. When present the list uses it, so it never comes up short. */
  qty_max?: number | null;
  unit: string | null;
  ingredient_id: string | null;
  /** Preparation and qualifiers: "diced", "gluten-free". */
  prep_note: string | null;
  optional: boolean;
  /** Containers the line names ("2 (14 oz) cans" is 2); qty and unit stay the total contents. */
  container_count?: number | null;
  container?: string | null;
}

/** A recipe with its lines. `RecipeWithIngredients` satisfies it. */
export interface ListRecipe {
  id: string;
  title: string;
  /** What the recipe makes. Null or zero means quantities are used as written. */
  servings: number | null;
  /** Set when the recipe was deleted after it was planned. */
  deleted_at?: string | null;
  ingredients: readonly ListIngredientLine[];
}

/** The slice of a plan entry `buildList` reads. `MealPlanEntry` satisfies it. */
export interface ListEntry {
  id: string;
  recipe_id: string;
  servings: number;
  status: "planned" | "cooked" | "skipped";
  date: string;
  slot: "breakfast" | "lunch" | "dinner" | "snack";
  position: number;
}

export interface BuildListOptions {
  /** The household's section order. Sections it leaves out follow in the default order. */
  sectionOrder?: readonly string[];
  /** Round to purchasable quantities. On unless set to false. */
  roundUp?: boolean;
}

// ---------------------------------------------------------------------------------------
// buildList: output
// ---------------------------------------------------------------------------------------

export interface DraftItem {
  ingredientId: string | null;
  displayName: string;
  qty: number | null;
  unit: string | null;
  sourceEntryIds: string[];
  section: string;
  /** What the recipe lines asked for beyond the ingredient ("gluten-free"). Sorted. */
  qualifiers: string[];
  contributions: Contribution[];
  rounding?: Rounding;
  /** Set when the pantry covers the item. It stays in the draft so the list can show it. */
  excludedReason?: "pantry";
  needsAttention: boolean;
  attention?: AttentionReason;
  /** Order in the whole list: section order, then name. */
  position: number;
}

export type SkippedReason = "recipe_missing" | "recipe_deleted";

export interface GroceryListDraft {
  /** Every item, excluded ones included, in section order then name order. */
  items: DraftItem[];
  /** The section order the items follow. */
  sectionOrder: string[];
  /** Items that need a person's eye and are not covered by the pantry. */
  needsAttentionCount: number;
  /** Entries that contributed nothing because their recipe is gone. Skipped entries are not listed. */
  skippedEntries: { entryId: string; reason: SkippedReason }[];
}

/** The `grocery_list_items.detail` value for a draft item. */
export function itemDetailOf(item: DraftItem): ItemDetail {
  return {
    contributions: item.contributions,
    rounding: item.rounding ?? null,
    attention: item.attention ?? null,
  };
}

// ---------------------------------------------------------------------------------------
// The list-build Edge Function contract (supabase/functions/list-build/README.md)
// ---------------------------------------------------------------------------------------

export const ListBuildRequest = z.object({
  /** The Monday of the plan's week. */
  weekStart: IsoDate.refine(isWeekStart, "must be a Monday"),
  /** Defaults to the caller's most recently joined household. The caller must be a member. */
  householdId: z.uuid().optional(),
});
export type ListBuildRequest = z.infer<typeof ListBuildRequest>;

export const LIST_BUILD_ERROR_CODES = [
  "unauthorized",
  "invalid_request",
  "not_a_member",
  "no_household",
  "no_plan",
  "internal_error",
] as const;
export const ListBuildErrorCode = z.enum(LIST_BUILD_ERROR_CODES);
export type ListBuildErrorCode = z.infer<typeof ListBuildErrorCode>;

export const LIST_BUILD_ERROR_MESSAGES: Record<ListBuildErrorCode, string> = {
  unauthorized: "Sign in to build a list.",
  invalid_request: "That request is not valid. Send a weekStart that is a Monday.",
  not_a_member: "You are not a member of that household.",
  no_household: "Join or create a household first.",
  no_plan: "Nothing is planned for that week yet.",
  internal_error: "Something went wrong building the list. Try again.",
};

export const ListBuildResponse = z.object({
  ok: z.literal(true),
  listId: z.uuid(),
  /** Items to buy: everything the pantry does not cover. */
  itemCount: z.number().int().min(0),
  /** Items to buy that need a person's eye: unparsed lines and amounts that could not be added. */
  needsAttentionCount: z.number().int().min(0),
  /** Items the pantry covers, shown under "Already have". */
  alreadyHaveCount: z.number().int().min(0),
  /** The build counter after this build: 1 for the first, +1 on every rebuild. */
  planVersion: z.number().int().min(1),
  /** Entries whose recipe is gone and so added nothing. */
  skippedEntryCount: z.number().int().min(0),
  /** True when the plan already had a list and this build refreshed it. */
  rebuilt: z.boolean(),
});
export type ListBuildResponse = z.infer<typeof ListBuildResponse>;

export const ListBuildFailure = z.object({
  ok: z.literal(false),
  error: ListBuildErrorCode,
  message: z.string(),
});
export type ListBuildFailure = z.infer<typeof ListBuildFailure>;
