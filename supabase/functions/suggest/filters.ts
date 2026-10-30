// Hard filters for the suggest function (WS06, risk R4). docs/03-ai-design.md §3 step 2 and §11,
// docs/05-security-privacy.md §Allergen safety.
//
// A recipe that fails any filter never reaches the model. This file turns a household's
// allergies, diets, never-foods, and time limit into a `FilterSpec`, builds the SQL that applies
// it, and offers `findViolations`, the same rules in TypeScript, which candidates.ts runs again
// on every recipe the SQL returned (defense in depth) and the eval uses as a second opinion.
//
// How allergens are matched. The brief assumed `ingredients.allergen_tags`; the ontology WS03
// shipped has no such column (docs/02 §Identity lists none). So allergens are matched by term
// lists against both the parsed ingredient name and the line's raw text, and by ingredient
// category where a category is a clean signal. Raw text matters because a recipe whose lines the
// parser has not resolved yet (ingredient_id is null) must not slip through. The lists err toward
// excluding: a recipe may be dropped that is actually safe ("coconut cream" is not excepted for
// an egg allergy, "butter lettuce" is excepted for milk), never the reverse by design. Names
// the lists do not know can still be missed; a tag column on the ontology is the long-term fix
// (contract change request in the WS06 report).
//
// The patterns are POSIX regular expressions in PostgreSQL's advanced syntax. `\m` and `\M` mark
// the start and end of a word. `toJsPattern` maps them to `\b` for the TypeScript check, and the
// tests run both engines over the same text to keep them in step.
import {
  ALLERGENS,
  type Allergen,
  DIETS,
  type Diet,
  type ProfilePreferences,
} from "../../../packages/core/src/index.ts";

export type FilterErrorCode = "unknown_allergen" | "unknown_diet";

/** Thrown when preferences name an allergen or diet we have no rule for. Fail closed. */
export class FilterError extends Error {
  readonly code: FilterErrorCode;
  constructor(code: FilterErrorCode, message: string) {
    super(message);
    this.name = "FilterError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------
// Term lists
// ---------------------------------------------------------------------------------------

/** One word-bounded alternation. `alts` is already a regular expression fragment. */
function words(alts: string, after = ""): string {
  return String.raw`\m(?:${alts})\M${after}`;
}

/** A word that is not preceded by one of `prefixes` (each followed by a space). */
function wordsNot(prefixes: string, alts: string, after = ""): string {
  return String.raw`(?<!(?:${prefixes}) )\m(?:${alts})\M${after}`;
}

/**
 * A word that counts only when the whole line mentions none of `unless` ("cauliflower steaks",
 * "3 ribs celery"). Anchored at the start of the line, with a lookahead over the rest of it.
 */
function wordsUnlessLine(unless: string, alts: string): string {
  return String.raw`^(?!.*\m(?:${unless})\M).*\m(?:${alts})\M`;
}

const PLANT_PREFIXES =
  "almond|oat|soy|rice|cashew|coconut|hemp|pea|macadamia|flax|plant|nut|vegan|non-dairy|dairy-free";
const NUT_BUTTER_PREFIXES =
  "peanut|almond|cashew|nut|sunflower seed|sunflower|soy|cocoa|shea|apple|pumpkin|seed|coconut|tahini|hazelnut|walnut|pistachio|sesame|vegan|plant";

const MEAT_TERMS =
  "beef|brisket|veal|pork|bacon|ham|hams|prosciutto|pancetta|guanciale|speck|salami|pepperoni|sausages?|chorizo|kielbasa|bratwurst|bologna|mortadella|hot ?dogs?|frankfurters?|lamb|mutton|chicken|turkey|duck|goose|quail|venison|bison|rabbit|meatballs?|meatloaf|lard|tallow|suet|schmaltz|gelatin|gelatine|bone broth|jerky|foie gras|oxtail|tripe|giblets|gizzards?|drippings|liver|carnitas|pulled pork|hamburger|ground meat|minced meat|capicola|coppa|salt pork|meat";

const PORK_TERMS =
  "pork|bacon|ham|hams|prosciutto|pancetta|guanciale|speck|salami|pepperoni|chorizo|sausages?|lard|gelatin|gelatine|hot ?dogs?|bologna|mortadella|capicola|coppa|salt pork|carnitas";

const SHELLFISH_TERMS =
  "shellfish|shrimps?|prawns?|crabs?|crab ?meat|lobsters?|crawfish|crayfish|langoustines?|clams?|mussels?|oysters?|scallops?|abalone|squid|calamari|octopus|cuttlefish|snails?|escargot|krill|cockles?|whelks?|conch|sea urchin|uni|barnacles?|seafood|surimi|cioppino|bouillabaisse|paella";

const FISH_TERMS =
  "fish|salmon|tuna|cod|haddock|halibut|tilapia|trout|bass|snapper|mahi[- ]mahi|mahi|swordfish|mackerel|sardines?|anchov(?:y|ies)|herring|catfish|pollock|pollack|flounder|sole|perch|pike|carp|eel|unagi|grouper|barramundi|branzino|monkfish|whitefish|whiting|skate|shad|smelt|turbot|wahoo|amberjack|yellowtail|hamachi|ahi|bonito|dashi|katsuobushi|worcestershire|surimi|caviar|roe|lox|kippers?|fumet|caesar|nam pla|bagoong|rockfish|walleye|tilefish|cioppino";

/** Dairy terms, with the plant milks, nut butters and cream of tartar that are not dairy excepted. */
const MILK_PATTERNS: readonly string[] = [
  wordsNot(PLANT_PREFIXES, "milk"),
  wordsNot(
    "coconut|oat|soy|almond|cashew|vegan|non-dairy|whipped coconut",
    "cream",
    "(?! of tartar)",
  ),
  wordsNot(NUT_BUTTER_PREFIXES, "butter", "(?! (?:beans?|lettuce|leaf|leaves|squash))"),
  words(
    "buttermilk|butterscotch|pesto|cheeses?|cheddar|mozzarella|parmesan|parmigiano|ricotta|mascarpone|feta|brie|camembert|gouda|gruy[eè]re|provolone|halloumi|paneer|asiago|fontina|manchego|romano|gorgonzola|burrata|queso|cotija|havarti|emmental|jarlsberg|stilton|roquefort|colby|monterey jack|pepper jack|neufchatel|labneh|quark|skyr|yogh?urt|kefir|ghee|whey|casein|caseinate|lactose|custard|ice cream|gelato|half[- ]and[- ]half|cr[eè]me fra[iî]che|eggnog|alfredo|b[eé]chamel|ranch|curds?|clotted|dulce de leche|whipped topping|cool whip|nougat|caramels?",
  ),
];

const EGG_PATTERNS: readonly string[] = [
  words(
    "eggs?|egg ?whites?|egg ?yolks?|yolks?|mayo|mayonnaise|caesar|meringues?|aioli|hollandaise|albumin|lysozyme|ovalbumin|eggnog|custard|quiche|frittata|carbonara|brioche|challah|souffl[eé]s?|zabaglione|pavlova|mousse|lemon curd",
  ),
];

const WHEAT_PATTERNS: readonly string[] = [
  wordsNot(
    "rice|almond|coconut|corn|chickpea|garbanzo|oat|tapioca|potato|cassava|buckwheat|gram|besan|sorghum|teff|millet|arrowroot|nut|hazelnut|masa",
    "flour",
  ),
  wordsNot("rice|glass|bean thread|shirataki|sweet potato|cellophane", "noodles?"),
  wordsNot("rice|chickpea|lentil|corn|quinoa", "pasta"),
  wordsNot("corn", "tortillas?"),
  words(
    "wheat|wholewheat|whole-wheat|bread|breads|breadcrumbs?|bread crumbs?|panko|spaghetti|linguine|fettuccine|fettucine|tagliatelle|pappardelle|penne|rigatoni|macaroni|lasagn[ae]|orzo|ravioli|tortellini|gnocchi|couscous|bulgur|semolina|farro|spelt|kamut|durum|einkorn|seitan|pita|naan|bagels?|buns?|crackers?|croutons?|dough|biscuits?|bisquick|barley|rye|malt|beer|ale|lager|stout|graham|dumplings?|wontons?|phyllo|filo|pastry|pie crust|cake mix|baking mix|matzo|matzah|udon|ramen|lo mein|chow mein|crepes?|pancakes?|waffles?|flatbread|baguette|ciabatta|focaccia|sourdough|toast|soy sauce|teriyaki|hoisin|cereal",
  ),
];

/** Grains that matter to a gluten-free diet but are not wheat. */
const GLUTEN_EXTRA_PATTERNS: readonly string[] = [
  words("oats?|oatmeal|barley|rye|malt|brewer'?s yeast|farina|triticale"),
];

/** Allergen term lists. Every allergen in ALLERGENS has an entry (a test enforces it). */
export const ALLERGEN_PATTERNS: Readonly<Record<Allergen, readonly string[]>> = {
  peanut: [words("peanuts?|groundnuts?|arachis|satay|nuts?")],
  tree_nut: [
    words(
      "almonds?|brazil nuts?|cashews?|chestnuts?|hazelnuts?|filberts?|macadamias?|macadamia nuts?|pecans?|pine ?nuts?|pignoli|pistachios?|walnuts?|pralines?|marzipan|amaretto|frangelico|nutella|gianduja|pesto|nuts?",
    ),
  ],
  milk: MILK_PATTERNS,
  egg: EGG_PATTERNS,
  wheat: WHEAT_PATTERNS,
  soy: [
    words(
      "soy|soya|soybeans?|soy beans?|edamame|tofu|tempeh|miso|tamari|shoyu|natto|teriyaki|hoisin|textured vegetable protein|tvp",
    ),
  ],
  fish: [words(FISH_TERMS)],
  shellfish: [words(SHELLFISH_TERMS)],
  sesame: [
    words(
      "sesame|tahini|halva|halvah|hummus|houmous|gomasio|gomashio|benne|za'?atar|dukkah|furikake|baba gh?anou?[sj]h?|goma|shichimi|togarashi|everything bagel|everything seasoning",
    ),
  ],
};

const PLANT_MILK_EXCEPT = String.raw`\m(?:almond|oat|soy|cashew|rice|hemp|coconut)\M.*\mmilk\M|\mplant\M`;
const SHELLFISH_EXCEPT = String.raw`\m(?:${SHELLFISH_TERMS})\M`;

interface CategoryRule {
  category: string;
  /** Names matching this pattern are exempt. Empty means no exception. */
  except: string;
}

/** Categories that are a clean signal for an allergen, beyond its term list. */
const ALLERGEN_CATEGORY_RULES: Partial<Record<Allergen, readonly CategoryRule[]>> = {
  milk: [{ category: "dairy", except: PLANT_MILK_EXCEPT }],
  egg: [{ category: "eggs", except: "" }],
  // The ontology files fish and shellfish together under seafood. Anything under seafood that
  // is not a shellfish name is a fish.
  fish: [{ category: "seafood", except: SHELLFISH_EXCEPT }],
};

interface DietRule {
  patterns: readonly string[];
  categories: readonly CategoryRule[];
  /** Recipe tags (lowercase) that mark a conflict. Tags are free text, so this is a weak signal. */
  tags: readonly string[];
}

const MEAT_PATTERNS: readonly string[] = [
  words(MEAT_TERMS),
  words("goat", "(?! (?:cheese|milk|yogh?urt))"),
  wordsUnlessLine("celery|rhubarb", "ribs?"),
  wordsUnlessLine(
    "cauliflower|portobello|tofu|eggplant|vegan|vegetarian|mushroom|veggie",
    "steaks?",
  ),
  wordsUnlessLine(
    "veggie|vegetarian|vegan|bean|plant|plant-based|lentil|chickpea|mushroom",
    "burgers?|patty|patties",
  ),
];

const MEAT_TAGS = [
  "meat",
  "beef",
  "pork",
  "chicken",
  "poultry",
  "turkey",
  "lamb",
  "bacon",
  "sausage",
  "ham",
];
const SEAFOOD_TAGS = ["seafood", "fish", "shrimp", "salmon", "shellfish"];

const ALCOHOL_PATTERN = words(
  "wine|beer|rum|bourbon|whisk(?:e)?y|vodka|brandy|sake|mirin|liqueur|sherry|marsala|vermouth|cognac|tequila|champagne|prosecco",
  "(?! vinegar)",
);

/**
 * Diets the filters enforce. low_carb, keto, paleo, and omnivore have no rule: they steer taste
 * (the composer prompt sees them) but nothing can be proven from an ingredient list.
 */
const DIET_RULES: Partial<Record<Diet, DietRule>> = {
  vegetarian: {
    patterns: [...MEAT_PATTERNS, words(FISH_TERMS), words(SHELLFISH_TERMS)],
    categories: [
      { category: "meat", except: "" },
      { category: "seafood", except: "" },
    ],
    tags: [...MEAT_TAGS, ...SEAFOOD_TAGS],
  },
  vegan: {
    patterns: [
      ...MEAT_PATTERNS,
      words(FISH_TERMS),
      words(SHELLFISH_TERMS),
      ...MILK_PATTERNS,
      ...EGG_PATTERNS,
      words("honey|beeswax|bee pollen|royal jelly|isinglass|cochineal|carmine"),
    ],
    categories: [
      { category: "meat", except: "" },
      { category: "seafood", except: "" },
      { category: "eggs", except: "" },
      { category: "dairy", except: PLANT_MILK_EXCEPT },
    ],
    tags: [...MEAT_TAGS, ...SEAFOOD_TAGS, "dairy", "cheese", "egg", "eggs", "honey"],
  },
  pescatarian: {
    patterns: MEAT_PATTERNS,
    categories: [{ category: "meat", except: "" }],
    tags: MEAT_TAGS,
  },
  halal: {
    patterns: [words(PORK_TERMS), ALCOHOL_PATTERN],
    categories: [],
    tags: ["pork", "bacon", "ham"],
  },
  kosher: {
    patterns: [
      words(PORK_TERMS),
      words(SHELLFISH_TERMS),
      words("rabbit|catfish|eel|shark|swordfish|monkfish|sturgeon|caviar|anglerfish"),
    ],
    categories: [],
    tags: ["pork", "bacon", "ham", "shellfish", "shrimp"],
  },
  gluten_free: {
    patterns: [...WHEAT_PATTERNS, ...GLUTEN_EXTRA_PATTERNS],
    categories: [],
    tags: ["contains gluten"],
  },
  dairy_free: {
    patterns: MILK_PATTERNS,
    categories: [{ category: "dairy", except: PLANT_MILK_EXCEPT }],
    tags: ["dairy", "cheese"],
  },
};

/**
 * Recipe tags that mean "not a dinner". The suggest function plans dinners only, so a recipe
 * tagged as a dessert or a drink is never a candidate. Tags are matched case-insensitively.
 */
export const NON_DINNER_TAGS: readonly string[] = [
  "dessert",
  "desserts",
  "cake",
  "cakes",
  "cookie",
  "cookies",
  "brownie",
  "brownies",
  "drink",
  "drinks",
  "beverage",
  "beverages",
  "cocktail",
  "cocktails",
  "smoothie",
  "smoothies",
  "breakfast",
  "brunch",
  "snack",
  "snacks",
  "condiment",
  "condiments",
];

/** A pattern that matches nothing, for an empty list. */
export const NEVER_MATCHES = "(?!)";

// ---------------------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------------------

export interface FilterInput {
  /** Union of every household member's allergies. */
  allergies: readonly string[];
  /** Union of every household member's diets. */
  diets: readonly string[];
  /** The requesting person's never-foods, free text. */
  dislikes: readonly string[];
  /** The requesting person's weeknight limit. Null or undefined for no limit. */
  weeknightMinutes?: number | null | undefined;
  /**
   * Leave out recipes tagged dessert, drink, breakfast, and the like. True unless a swap asks
   * for another slot (a breakfast swap should be able to return a breakfast recipe).
   */
  dinnerOnly?: boolean | undefined;
}

export interface FilterSpec {
  allergies: Allergen[];
  diets: Diet[];
  /** One regular expression for all allergen and diet terms, or NEVER_MATCHES. */
  textPattern: string;
  /** One regular expression for the never-foods, or NEVER_MATCHES. */
  neverPattern: string;
  /** Lowercase names and aliases to resolve to ingredient ids through the ontology. */
  neverTerms: string[];
  /** Category rules as parallel arrays for unnest. */
  categoryRuleCategories: string[];
  categoryRuleExcepts: string[];
  /** Lowercase recipe tags that exclude a recipe: diet conflicts and non-dinner tags. */
  excludedTags: string[];
  maxMinutes: number | null;
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function combine(patterns: readonly string[]): string {
  const list = unique(patterns);
  if (list.length === 0) return NEVER_MATCHES;
  if (list.length === 1) return list[0] as string;
  return list.map((pattern) => `(?:${pattern})`).join("|");
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The pattern for one never-food: the whole word, with an optional plural. */
export function neverFoodPattern(term: string): string {
  return String.raw`\m${escapeRegex(term)}(?:e?s)?\M`;
}

/**
 * The filter input for a household. Everyone's allergies and diets apply, because a plan is
 * cooked for the whole table. The requesting person's never-foods and weeknight limit apply,
 * because those are tastes and schedules that belong to one person.
 */
export function filterInputFromPreferences(
  requester: ProfilePreferences,
  otherMembers: readonly ProfilePreferences[] = [],
): FilterInput {
  const everyone = [requester, ...otherMembers];
  return {
    allergies: unique(everyone.flatMap((p) => p.allergies ?? [])),
    diets: unique(everyone.flatMap((p) => p.diets ?? [])),
    dislikes: requester.dislikes ?? [],
    weeknightMinutes: requester.weeknight_minutes ?? null,
  };
}

/**
 * Compiles preferences into a spec. Unknown allergens and diets throw: a typo must stop the
 * suggestion, not silently filter nothing.
 */
export function buildFilterSpec(input: FilterInput): FilterSpec {
  const allergies = unique(input.allergies).map((value) => {
    if (!(ALLERGENS as readonly string[]).includes(value)) {
      throw new FilterError("unknown_allergen", `unknown allergen: ${value}`);
    }
    return value as Allergen;
  });
  const diets = unique(input.diets).map((value) => {
    if (!(DIETS as readonly string[]).includes(value)) {
      throw new FilterError("unknown_diet", `unknown diet: ${value}`);
    }
    return value as Diet;
  });

  const patterns: string[] = [];
  const categoryRules: CategoryRule[] = [];
  const tags = new Set<string>(input.dinnerOnly === false ? [] : NON_DINNER_TAGS);

  for (const allergen of allergies) {
    patterns.push(...ALLERGEN_PATTERNS[allergen]);
    categoryRules.push(...(ALLERGEN_CATEGORY_RULES[allergen] ?? []));
  }
  for (const diet of diets) {
    const rule = DIET_RULES[diet];
    if (!rule) continue;
    patterns.push(...rule.patterns);
    categoryRules.push(...rule.categories);
    for (const tag of rule.tags) tags.add(tag);
  }

  // Dedupe category rules by category and exception.
  const rules = new Map<string, CategoryRule>();
  for (const rule of categoryRules) rules.set(`${rule.category}\u0000${rule.except}`, rule);

  // Two characters or more: a one letter never-food would match whole words like "a" and empty
  // the candidate list, which is not what anyone typed it for.
  const never = unique(
    input.dislikes
      .map((term) => term.trim().toLowerCase().replace(/\s+/g, " "))
      .filter((t) => t.length >= 2),
  );

  const minutes = input.weeknightMinutes;
  return {
    allergies,
    diets,
    textPattern: combine(patterns),
    neverPattern: combine(never.map(neverFoodPattern)),
    neverTerms: never,
    categoryRuleCategories: [...rules.values()].map((rule) => rule.category),
    categoryRuleExcepts: [...rules.values()].map((rule) => rule.except),
    excludedTags: [...tags],
    maxMinutes: typeof minutes === "number" && minutes > 0 ? Math.trunc(minutes) : null,
  };
}

// ---------------------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------------------

export interface BuiltQuery {
  text: string;
  params: unknown[];
}

export interface CandidateQueryOptions {
  householdId: string;
  spec: FilterSpec;
  /** pgvector text such as [0.1,0.2,...], or null for a cold profile. */
  tasteEmbedding: string | null;
  /** Recipes to leave out, for example the ones already planned this week. */
  excludeIds?: readonly string[];
  /** Rows to return. */
  limit: number;
}

/**
 * The retrieval query. Candidates are the household's recipes and the catalog; every filter is a
 * `where` clause; the model sees only what comes back.
 *
 * Parameters: $1 household, $2 excluded recipe ids, $3 minutes limit, $4 excluded tags,
 * $5 allergen and diet pattern, $6 never-food names, $7 never-food pattern, $8 and $9 category
 * rules, $10 taste embedding, $11 limit.
 *
 * A recipe with no time on it passes the minutes filter (its time is unknown, not too long).
 */
export function buildCandidateQuery(options: CandidateQueryOptions): BuiltQuery {
  const { spec } = options;
  const text = `
with never_ids as (
  select i.id
  from public.ingredients i
  where i.name = any($6::text[]) or i.plural = any($6::text[])
  union
  select a.ingredient_id
  from public.ingredient_aliases a
  where a.alias = any($6::text[])
)
select
  r.id,
  r.household_id,
  r.visibility::text as visibility,
  r.title,
  r.description,
  r.image_url,
  r.source_url,
  r.cuisine,
  r.tags,
  r.servings,
  nullif(coalesce(r.prep_min, 0) + coalesce(r.cook_min, 0), 0) as total_min,
  case
    when $10::extensions.vector is null or r.embedding is null then null
    else 1 - (r.embedding <=> $10::extensions.vector)
  end as similarity
from public.recipes r
where r.deleted_at is null
  and (r.household_id = $1::uuid or r.visibility = 'catalog')
  and r.id <> all($2::uuid[])
  and (
    $3::int is null
    or nullif(coalesce(r.prep_min, 0) + coalesce(r.cook_min, 0), 0) is null
    or coalesce(r.prep_min, 0) + coalesce(r.cook_min, 0) <= $3::int
  )
  and not exists (
    select 1 from unnest(r.tags) as t(tag) where lower(t.tag) = any($4::text[])
  )
  and not exists (
    select 1
    from public.recipe_ingredients ri
    left join public.ingredients i on i.id = ri.ingredient_id
    where ri.recipe_id = r.id
      and (
        ri.raw_text ~* $5::text
        or i.name ~* $5::text
        or ri.raw_text ~* $7::text
        or i.name ~* $7::text
        or ri.ingredient_id in (select id from never_ids)
        or exists (
          select 1
          from unnest($8::text[], $9::text[]) as cr(category, except_pattern)
          where i.category = cr.category
            and (cr.except_pattern = '' or i.name !~* cr.except_pattern)
        )
      )
  )
order by similarity desc nulls last, r.title, r.id
limit $11::int`;
  return {
    text,
    params: [
      options.householdId,
      [...(options.excludeIds ?? [])],
      spec.maxMinutes,
      spec.excludedTags,
      spec.textPattern,
      spec.neverTerms,
      spec.neverPattern,
      spec.categoryRuleCategories,
      spec.categoryRuleExcepts,
      options.tasteEmbedding,
      options.limit,
    ],
  };
}

// ---------------------------------------------------------------------------------------
// The same rules in TypeScript
// ---------------------------------------------------------------------------------------

const JS_PATTERNS = new Map<string, RegExp>();

/** PostgreSQL's word markers become JavaScript's. Compiled patterns are kept. */
export function toJsPattern(pattern: string): RegExp {
  let compiled = JS_PATTERNS.get(pattern);
  if (!compiled) {
    compiled = new RegExp(pattern.replaceAll("\\m", "\\b").replaceAll("\\M", "\\b"), "i");
    JS_PATTERNS.set(pattern, compiled);
  }
  return compiled;
}

export interface RecipeLine {
  rawText: string;
  /** The ontology name when the parser resolved the line. */
  ingredientName: string | null;
  category: string | null;
  ingredientId?: string | null;
}

export interface RecipeFacts {
  tags: readonly string[];
  /** Prep plus cook minutes; null when the recipe carries no time. */
  totalMin: number | null;
  lines: readonly RecipeLine[];
}

/**
 * Why a recipe fails the filters, or an empty list when it passes. Checks the same things the SQL
 * does: tags, time, allergen and diet terms, never-foods, and category rules. `neverIds` are the
 * ingredient ids the never-food names resolved to (empty when the caller has none).
 */
export function findViolations(
  recipe: RecipeFacts,
  spec: FilterSpec,
  neverIds: ReadonlySet<string> = new Set(),
): string[] {
  const reasons: string[] = [];
  const excluded = new Set(spec.excludedTags);
  for (const tag of recipe.tags) {
    if (excluded.has(tag.toLowerCase())) reasons.push(`tag: ${tag}`);
  }
  if (spec.maxMinutes !== null && recipe.totalMin !== null && recipe.totalMin > spec.maxMinutes) {
    reasons.push(`time: ${recipe.totalMin} min over ${spec.maxMinutes}`);
  }

  const text = spec.textPattern === NEVER_MATCHES ? null : toJsPattern(spec.textPattern);
  const never = spec.neverPattern === NEVER_MATCHES ? null : toJsPattern(spec.neverPattern);
  const rules = spec.categoryRuleCategories.map((category, i) => ({
    category,
    except: spec.categoryRuleExcepts[i] ? toJsPattern(spec.categoryRuleExcepts[i] as string) : null,
  }));

  for (const line of recipe.lines) {
    const name = line.ingredientName ?? "";
    const hit = (pattern: RegExp | null) => {
      if (!pattern) return null;
      return pattern.exec(line.rawText)?.[0] ?? pattern.exec(name)?.[0] ?? null;
    };
    const allergenHit = hit(text);
    if (allergenHit) reasons.push(`ingredient: "${allergenHit}" in "${line.rawText}"`);
    const neverHit = hit(never);
    if (neverHit) reasons.push(`never-food: "${neverHit}" in "${line.rawText}"`);
    if (line.ingredientId && neverIds.has(line.ingredientId)) {
      reasons.push(`never-food ingredient: ${name || line.rawText}`);
    }
    if (line.category) {
      for (const rule of rules) {
        if (rule.category !== line.category) continue;
        if (rule.except?.test(name)) continue;
        reasons.push(`category: ${line.category} (${name || line.rawText})`);
      }
    }
  }
  return reasons;
}
