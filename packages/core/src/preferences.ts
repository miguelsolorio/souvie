// Onboarding and suggestion contracts (WS06). docs/02-data-model.md §Identity (profiles) and
// docs/03-ai-design.md §2 and §3 are the references.
//
//   * DIETS and ALLERGENS: the canonical vocabularies. `ProfilePreferences` (identity.ts) uses
//     them, the `suggest` function's hard filters are keyed by them, and a CHECK constraint on
//     profiles.preferences repeats them in SQL. Change all three together.
//   * defaultPreferences(): a valid starting point for a form. It is never written to the
//     database as is: an `allergies` key in profiles.preferences means "the person answered the
//     allergy question", so only the allergies screen may write it.
//   * One input schema per onboarding screen, with the validation the brief lists.
//   * The request and response of the `suggest` Edge Function.
//
// This file imports only the TYPE of ProfilePreferences, so identity.ts can import the
// vocabularies from here without a runtime cycle.
import { z } from "zod";
import type { ProfilePreferences } from "./identity.ts";
import { isoDateOf, MEAL_SLOTS, MealSlot } from "./planning.ts";

// ---------------------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------------------

export const DIETS = [
  "omnivore",
  "vegetarian",
  "vegan",
  "pescatarian",
  "halal",
  "kosher",
  "gluten_free",
  "dairy_free",
  "low_carb",
  "keto",
  "paleo",
] as const;
export const Diet = z.enum(DIETS);
export type Diet = z.infer<typeof Diet>;

/** The nine major food allergens in US law (FDA, with sesame). Hard filters, never model-only. */
export const ALLERGENS = [
  "peanut",
  "tree_nut",
  "milk",
  "egg",
  "wheat",
  "soy",
  "fish",
  "shellfish",
  "sesame",
] as const;
export const Allergen = z.enum(ALLERGENS);
export type Allergen = z.infer<typeof Allergen>;

export const SKILLS = ["beginner", "comfortable", "confident"] as const;
export const LEFTOVERS = ["avoid", "ok", "prefer"] as const;

/** Diets the `suggest` filters can enforce from ingredients. The others only steer taste. */
export const ENFORCED_DIETS: readonly Diet[] = [
  "vegetarian",
  "vegan",
  "pescatarian",
  "halal",
  "kosher",
  "gluten_free",
  "dairy_free",
];

// ---------------------------------------------------------------------------------------
// Limits (screen validation from the WS06 brief)
// ---------------------------------------------------------------------------------------

export const PREFERENCE_LIMITS = {
  householdName: { min: 2, max: 40 },
  adults: { min: 1, max: 12 },
  kids: { min: 0, max: 12 },
  dinnersPerWeek: { min: 1, max: 7 },
  dislikes: { maxItems: 20, maxLength: 60 },
  weeknightMinutes: { min: 10, max: 120 },
  budgetPerWeekUsd: { min: 20, max: 1000 },
  notes: { max: 500 },
  equipmentItem: { maxLength: 40 },
} as const;

/** Equipment the screen offers. The profile accepts any short text, so this is a UI list. */
export const EQUIPMENT_OPTIONS = [
  "oven",
  "stovetop",
  "slow cooker",
  "pressure cooker",
  "air fryer",
  "grill",
  "rice cooker",
  "blender",
  "food processor",
  "microwave",
] as const;

/** Cuisines the screen offers. The profile accepts any short text, so this is a UI list. */
export const CUISINE_OPTIONS = [
  "american",
  "italian",
  "mexican",
  "chinese",
  "japanese",
  "korean",
  "thai",
  "vietnamese",
  "indian",
  "mediterranean",
  "greek",
  "middle eastern",
  "french",
  "spanish",
  "caribbean",
  "african",
] as const;

// ---------------------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------------------

/** A complete, valid preferences object for a form to start from. Not for the database. */
export function defaultPreferences(): ProfilePreferences {
  return {
    household_size: { adults: 2, kids: 0 },
    dinners_per_week: 5,
    diets: [],
    allergies: [],
    dislikes: [],
    cuisines: [],
    skill: "comfortable",
    weeknight_minutes: 45,
    equipment: [],
    portions: 2,
    leftovers: "ok",
  };
}

// ---------------------------------------------------------------------------------------
// Onboarding steps
// ---------------------------------------------------------------------------------------

export const ONBOARDING_STEP_COUNT = 8;

export interface OnboardingStepInfo {
  /** 1 to 8. `profiles.onboarding_step` holds the number of the last screen completed. */
  step: number;
  /** The file name in apps/mobile/app/(onboarding)/. */
  route: string;
  title: string;
}

export const ONBOARDING_STEPS: readonly OnboardingStepInfo[] = [
  { step: 1, route: "01-household", title: "Your household" },
  { step: 2, route: "02-eaters", title: "Who is eating" },
  { step: 3, route: "03-diets-allergies", title: "Diets and allergies" },
  { step: 4, route: "04-dislikes-cuisines", title: "Dislikes and cuisines" },
  { step: 5, route: "05-time-skill", title: "Time and skill" },
  { step: 6, route: "06-budget-leftovers", title: "Budget and leftovers" },
  { step: 7, route: "07-stores", title: "Your stores" },
  { step: 8, route: "08-calibrate", title: "Taste check" },
];

export function isOnboardingComplete(completedStep: number | null | undefined): boolean {
  return (completedStep ?? 0) >= ONBOARDING_STEP_COUNT;
}

/**
 * The screen to show for a profile whose last completed screen is `completedStep`. Returns null
 * when onboarding is done. Values outside 0 to 8 are clamped, so a bad row never strands anyone.
 */
export function nextOnboardingStep(
  completedStep: number | null | undefined,
): OnboardingStepInfo | null {
  const done = Math.min(Math.max(Math.trunc(completedStep ?? 0), 0), ONBOARDING_STEP_COUNT);
  if (done >= ONBOARDING_STEP_COUNT) return null;
  return ONBOARDING_STEPS[done] ?? null;
}

// ---------------------------------------------------------------------------------------
// Per-screen input schemas
// ---------------------------------------------------------------------------------------

const L = PREFERENCE_LIMITS;

/** Screen 1: the household name. */
export const HouseholdNameInput = z.object({
  name: z.string().trim().min(L.householdName.min).max(L.householdName.max),
});
export type HouseholdNameInput = z.infer<typeof HouseholdNameInput>;

/** Screen 2: adults, kids, dinners per week. */
export const EatersInput = z.object({
  adults: z.number().int().min(L.adults.min).max(L.adults.max),
  kids: z.number().int().min(L.kids.min).max(L.kids.max),
  dinners_per_week: z.number().int().min(L.dinnersPerWeek.min).max(L.dinnersPerWeek.max),
});
export type EatersInput = z.infer<typeof EatersInput>;

/**
 * Screen 3: diets and allergies. The person must either pick at least one allergen or say "No
 * allergies" (`noAllergies`). Both at once is a contradiction and is refused.
 */
export const DietsAllergiesInput = z
  .object({
    diets: z.array(Diet).max(DIETS.length),
    allergies: z.array(Allergen).max(ALLERGENS.length),
    noAllergies: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.allergies.length === 0 && !value.noAllergies) {
      ctx.addIssue({
        code: "custom",
        path: ["allergies"],
        message: "Choose your allergens, or choose No allergies.",
      });
    }
    if (value.allergies.length > 0 && value.noAllergies) {
      ctx.addIssue({
        code: "custom",
        path: ["noAllergies"],
        message: "You chose allergens and No allergies. Pick one.",
      });
    }
  });
export type DietsAllergiesInput = z.infer<typeof DietsAllergiesInput>;

const FreeText = z
  .string()
  .trim()
  .min(1)
  .max(L.dislikes.maxLength)
  .transform((value) => value.toLowerCase().replace(/\s+/g, " "));

/** Screen 4: never-foods and favorite cuisines. Never-foods are lowercased and de-duplicated. */
export const DislikesCuisinesInput = z.object({
  dislikes: z
    .array(FreeText)
    .max(L.dislikes.maxItems)
    .transform((items) => [...new Set(items)]),
  cuisines: z
    .array(FreeText)
    .max(CUISINE_OPTIONS.length)
    .transform((items) => [...new Set(items)]),
});
export type DislikesCuisinesInput = z.infer<typeof DislikesCuisinesInput>;

/** Screen 5: weeknight minutes, skill, equipment. */
export const TimeSkillInput = z.object({
  weeknight_minutes: z.number().int().min(L.weeknightMinutes.min).max(L.weeknightMinutes.max),
  skill: z.enum(SKILLS),
  equipment: z
    .array(z.string().trim().min(1).max(L.equipmentItem.maxLength))
    .max(EQUIPMENT_OPTIONS.length * 2)
    .transform((items) => [...new Set(items)]),
});
export type TimeSkillInput = z.infer<typeof TimeSkillInput>;

/** Screen 6: weekly budget (null skips it), leftovers stance, and the one free-text note. */
export const BudgetLeftoversInput = z.object({
  budget_per_week_usd: z
    .number()
    .min(L.budgetPerWeekUsd.min)
    .max(L.budgetPerWeekUsd.max)
    .nullable(),
  leftovers: z.enum(LEFTOVERS),
  notes: z.string().trim().max(L.notes.max).optional(),
});
export type BudgetLeftoversInput = z.infer<typeof BudgetLeftoversInput>;

/** A five digit US ZIP. */
export const ZipCode = z.string().regex(/^\d{5}$/, "Enter a 5 digit ZIP code.");

/** Screen 7: ZIP, the primary store, and the Costco membership answer. */
export const StoresInput = z.object({
  zip: ZipCode,
  primary_store_id: z.string().trim().min(1).max(120),
  costco_member: z.boolean(),
});
export type StoresInput = z.infer<typeof StoresInput>;

/** The `profiles.preferences` keys screen 2 writes. `portions` is the headcount per dinner. */
export function eatersToPreferences(input: EatersInput): ProfilePreferences {
  return {
    household_size: { adults: input.adults, kids: input.kids },
    dinners_per_week: input.dinners_per_week,
    portions: input.adults + input.kids,
  };
}

export function dietsAllergiesToPreferences(input: DietsAllergiesInput): ProfilePreferences {
  return { diets: [...input.diets], allergies: [...input.allergies] };
}

export function dislikesCuisinesToPreferences(input: DislikesCuisinesInput): ProfilePreferences {
  return { dislikes: input.dislikes, cuisines: input.cuisines };
}

export function timeSkillToPreferences(input: TimeSkillInput): ProfilePreferences {
  return {
    weeknight_minutes: input.weeknight_minutes,
    skill: input.skill,
    equipment: input.equipment,
  };
}

/** The budget key is left out entirely when the person skips it. */
export function budgetLeftoversToPreferences(input: BudgetLeftoversInput): ProfilePreferences {
  // undefined, not absent: `mergePreferences` removes a key set to undefined, so skipping the
  // budget on a second pass clears the amount the person entered on the first.
  return {
    leftovers: input.leftovers,
    budget_per_week_usd: input.budget_per_week_usd ?? undefined,
    notes: input.notes ? input.notes : undefined,
  };
}

export function storesToPreferences(input: StoresInput): ProfilePreferences {
  return { primary_store_id: input.primary_store_id };
}

/**
 * Merges one screen's keys into the stored preferences. Keys the screen does not write are kept
 * as they are. A key set to undefined is removed (the budget a person clears, for example), so
 * the stored object never carries a null where the schema allows only absence.
 */
export function mergePreferences(
  current: ProfilePreferences | null | undefined,
  patch: Partial<Record<string, unknown>>,
): ProfilePreferences {
  const merged: Record<string, unknown> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged as ProfilePreferences;
}

// ---------------------------------------------------------------------------------------
// Weeks
// ---------------------------------------------------------------------------------------

/**
 * The Monday that starts "the coming week": today when today is Monday, otherwise the next
 * Monday. The first plan is drafted for this week, on the same Monday-based `week_start` the
 * planner uses.
 */
export function comingWeekStart(now: Date): string {
  const daysUntilMonday = (8 - now.getDay()) % 7; // Sunday 0 -> 1, Monday 1 -> 0, Tuesday 2 -> 6
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysUntilMonday);
  return isoDateOf(monday);
}

// ---------------------------------------------------------------------------------------
// The suggest Edge Function (supabase/functions/suggest)
// ---------------------------------------------------------------------------------------

/** How many cards the calibration screen shows. */
export const CALIBRATION_CARD_COUNT = 12;
/** The longest one-line reason a dinner may carry. */
export const WHY_MAX_CHARS = 139;

export const SUGGEST_MODES = ["draft", "replace", "calibration", "backfill", "swap"] as const;
export const SuggestMode = z.enum(SUGGEST_MODES);
export type SuggestMode = z.infer<typeof SuggestMode>;

/**
 * The meal slots a suggestion can be for. Plans are dinners; a swap may name any slot. These are
 * WS04's slots (planning.ts), under the names this contract has used, so the two cannot drift.
 */
export const SUGGEST_SLOTS = MEAL_SLOTS;
export const SuggestSlot = MealSlot;
export type SuggestSlot = MealSlot;

/** Most recipe ids a swap may ask to avoid. */
export const SWAP_EXCLUDE_MAX = 200;

/**
 * Request body of POST /functions/v1/suggest.
 *
 *   draft        Compose the week's dinners. When the week already has a plan with dinners, that
 *                plan comes back unchanged.
 *   replace      Recompose. Without `date`, every still-planned dinner of the week is replaced.
 *                With `date`, only that night is replaced.
 *   swap         One recipe for one slot, for the planner's "swap with a suggestion". Needs `date`
 *                and `slot`. `excludeRecipeIds` are recipes it must not return (the one being
 *                replaced, the rest of the week); the recipes already on that week's plan are left
 *                out as well. It writes nothing: the planner applies the answer itself.
 *   calibration  Twelve recipes for the swipe screen. Writes nothing.
 *   backfill     Embed the household's recipes that have no embedding yet. Writes nothing else.
 *
 * `weekStart` must be a Monday.
 */
export const SuggestRequest = z
  .object({
    householdId: z.uuid(),
    weekStart: z.iso.date(),
    dinners: z.number().int().min(1).max(7).optional(),
    mode: SuggestMode,
    date: z.iso.date().optional(),
    /** swap only. */
    slot: SuggestSlot.optional(),
    /** swap only. */
    excludeRecipeIds: z.array(z.uuid()).max(SWAP_EXCLUDE_MAX).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.mode !== "swap") return;
    if (!value.date) ctx.addIssue({ code: "custom", path: ["date"], message: "swap needs a date" });
    if (!value.slot) ctx.addIssue({ code: "custom", path: ["slot"], message: "swap needs a slot" });
  });
export type SuggestRequest = z.infer<typeof SuggestRequest>;

export const SuggestEntry = z.object({
  /** YYYY-MM-DD, inside the requested week. */
  date: z.iso.date(),
  slot: SuggestSlot,
  recipeId: z.uuid(),
  servings: z.number().int().min(1),
  /** One line, at most 139 characters. Empty only for a dinner someone added by hand. */
  why: z.string().max(WHY_MAX_CHARS),
});
export type SuggestEntry = z.infer<typeof SuggestEntry>;

/** What the swipe screen shows for one recipe. The title and image are the recipe's own. */
export const CalibrationCard = z.object({
  recipeId: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  /** An http(s) URL. Storage paths are turned into short-lived signed URLs by the function. */
  imageUrl: z.string().nullable(),
  /** Where an imported recipe came from, for the attribution line. Null for the catalog. */
  sourceUrl: z.string().nullable(),
  cuisine: z.string().nullable(),
  totalMin: z.number().nullable(),
  tags: z.array(z.string()),
});
export type CalibrationCard = z.infer<typeof CalibrationCard>;

export const SuggestPlanResponse = z.object({
  ok: z.literal(true),
  planId: z.uuid(),
  entries: z.array(SuggestEntry),
  /** "model" when Sonnet composed the week, "fallback" when ranked candidates were used. */
  composedBy: z.enum(["model", "fallback", "existing"]),
  /** The composer's note about shared ingredients, when it wrote one. */
  notes: z.string().optional(),
  /** How many dinners short of the request the plan is, when too few recipes fit. */
  shortBy: z.number().int().min(1).optional(),
  /**
   * Present when the call changed dinners that were already planned because they no longer fit the
   * household's allergies or diets: how many were replaced and how many removed (nothing fit).
   */
  repaired: z
    .object({ replaced: z.number().int().min(0), removed: z.number().int().min(0) })
    .optional(),
});
export type SuggestPlanResponse = z.infer<typeof SuggestPlanResponse>;

/** The answer to a swap: exactly one entry. `planId` is there when the week already has a plan. */
export const SuggestSwapResponse = z.object({
  ok: z.literal(true),
  planId: z.uuid().optional(),
  entries: z.array(SuggestEntry).length(1),
});
export type SuggestSwapResponse = z.infer<typeof SuggestSwapResponse>;

export const SuggestCalibrationResponse = z.object({
  ok: z.literal(true),
  /** The same recipes as `cards`, ids only, in the order shown. */
  recipeIds: z.array(z.uuid()).max(CALIBRATION_CARD_COUNT),
  cards: z.array(CalibrationCard).max(CALIBRATION_CARD_COUNT),
});
export type SuggestCalibrationResponse = z.infer<typeof SuggestCalibrationResponse>;

export const SuggestBackfillResponse = z.object({
  ok: z.literal(true),
  embedded: z.number().int().min(0),
  remaining: z.number().int().min(0),
});
export type SuggestBackfillResponse = z.infer<typeof SuggestBackfillResponse>;

export const SUGGEST_ERROR_CODES = [
  "unauthorized",
  "invalid_request",
  "no_household",
  "not_a_member",
  "allergies_not_set",
  "no_candidates",
  "week_not_monday",
  "cost_cap",
  "embedding_unavailable",
  "internal_error",
] as const;
export type SuggestErrorCode = (typeof SUGGEST_ERROR_CODES)[number];

export const SUGGEST_ERROR_MESSAGES: Record<SuggestErrorCode, string> = {
  unauthorized: "Your session has ended. Sign in again.",
  invalid_request: "That request was not valid.",
  no_household: "Create or join a household first.",
  not_a_member: "You are not a member of that household.",
  allergies_not_set: "Tell us about allergies in your profile before we suggest meals.",
  no_candidates:
    "We have no recipes that fit your diet, allergies, and time yet. Add a few recipes and try again.",
  week_not_monday: "A week starts on a Monday.",
  cost_cap: "You have reached today's limit for suggestions. Try again tomorrow.",
  embedding_unavailable: "Recipe matching is not available right now.",
  internal_error: "Something went wrong. Try again.",
};

export const SuggestFailure = z.object({
  ok: z.literal(false),
  error: z.enum(SUGGEST_ERROR_CODES),
  message: z.string(),
});
export type SuggestFailure = z.infer<typeof SuggestFailure>;
