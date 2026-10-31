// Ingredient ontology and parser result types (WS03). docs/02-data-model.md §Recipes,
// docs/03-ai-design.md §5. Zod is the source of truth; the DB columns are snake_case and the
// mapping lives in the data layer.

import { z } from "zod";

/** The 16 store sections. Also the order of the CHECK constraint in the ingredients migration. */
export const INGREDIENT_CATEGORIES = [
  "produce",
  "meat",
  "seafood",
  "dairy",
  "eggs",
  "bakery",
  "pantry",
  "spices",
  "canned",
  "frozen",
  "beverages",
  "snacks",
  "baking",
  "international",
  "household",
  "other",
] as const;

export const IngredientCategorySchema = z.enum(INGREDIENT_CATEGORIES);
export type IngredientCategory = z.infer<typeof IngredientCategorySchema>;

export const IngredientSchema = z.object({
  id: z.uuid(),
  /** Singular, lowercase, unique. */
  name: z.string().min(1),
  plural: z.string().nullable(),
  category: IngredientCategorySchema,
  /** Canonical unit code (see units.ts) recipes usually use for this ingredient. */
  defaultUnit: z.string().min(1),
  densityGPerMl: z.number().positive().nullable(),
  typicalUnitWeightG: z.number().positive().nullable(),
  usdaFdcId: z.number().int().nullable(),
  isStapleDefault: z.boolean(),
});
export type Ingredient = z.infer<typeof IngredientSchema>;

export const ALIAS_SOURCES = ["seed", "llm", "user"] as const;
export const AliasSourceSchema = z.enum(ALIAS_SOURCES);
export type AliasSource = z.infer<typeof AliasSourceSchema>;

export const PARSE_STAGES = ["grammar", "lookup", "llm"] as const;
export const ParseStageSchema = z.enum(PARSE_STAGES);
export type ParseStage = z.infer<typeof ParseStageSchema>;

/**
 * One parsed ingredient line.
 *
 * - `qty` is the lower bound of a range ("2-3" gives qty 2, qtyMax 3). Null when the line has
 *   no amount ("salt to taste").
 * - `unit` is a canonical code from units.ts. A counted item with no written unit ("3 carrots")
 *   gets "each". Null only when there is no quantity.
 * - `prepNote` joins preparation and qualifiers: "diced", "packed, divided", "to taste".
 * - `splitFrom` is set when one raw line named several ingredients ("salt and pepper"). Every
 *   result from that line carries the original line in `splitFrom`; `rawText` is the same line.
 */
export const ParsedIngredientSchema = z.object({
  rawText: z.string(),
  qty: z.number().nonnegative().nullable(),
  qtyMax: z.number().nonnegative().nullable().optional(),
  unit: z.string().nullable(),
  ingredientId: z.uuid().nullable(),
  ingredientName: z.string().nullable(),
  prepNote: z.string().nullable().optional(),
  /**
   * Containers the line names, when it gives one with a size: "2 (14 oz) cans" is 2 cans holding
   * 28 oz in total, so `qty` and `unit` stay the total contents and these two keep the count and
   * the container word. Null or absent when the line has no container. Added 2026-10-30 (CCR5).
   */
  containerCount: z.number().int().positive().nullable().optional(),
  container: z.string().trim().min(1).max(40).nullable().optional(),
  optional: z.boolean(),
  confidence: z.number().min(0).max(1),
  stage: ParseStageSchema,
  splitFrom: z.string().optional(),
});
export type ParsedIngredient = z.infer<typeof ParsedIngredientSchema>;
