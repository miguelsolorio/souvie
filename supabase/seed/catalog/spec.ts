// Starter catalog spec (WS16): the coverage minimums, the tag vocabulary, the plan the drafting
// script works through, the deterministic diet and allergen checks, and the banned-word lists.
//
// Everything that decides what the catalog may contain lives here, so the drafting script, the
// loader (load.ts) and the test (catalog.test.ts) read the same rules. Plain Node, no
// dependencies, erasable TypeScript only (it runs under `node` as well as Vitest).
//
// The checks are conservative on purpose (docs/05-security-privacy.md §Allergen safety):
//   - an allergen is "present" when a line might carry it (soy sauce carries soy and wheat);
//   - a diet tag is given only when no line casts doubt (a line the ontology could not resolve
//     is doubt, unless it is a plain spice or herb).
// Tags are not the enforcement for allergies. WS06 filters on ingredient ids in SQL and again in
// TypeScript. These checks decide the diet tags and the review sheet.

import { uuidV5 } from "../load.ts";

// ---------------------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------------------

/** Fixed namespace for catalog ids. Never change it: every stored id derives from it. */
export const CATALOG_NAMESPACE = "b3f6f1a4-8d2e-4c57-a1f0-5e9c7d3b2a64";

/** Recipe id: UUID v5 of the slug. A changed slug is a new recipe. */
export function recipeId(slug: string): string {
  return uuidV5(slug, CATALOG_NAMESPACE);
}

/** Ingredient line id: UUID v5 of `<slug>#<position>`. */
export function lineId(slug: string, position: number): string {
  return uuidV5(`${slug}#${position}`, CATALOG_NAMESPACE);
}

// ---------------------------------------------------------------------------------------
// Tag vocabulary
// ---------------------------------------------------------------------------------------

export const COURSE_TAG = "dinner";

export const MEAT_PROTEIN_TAGS = [
  "chicken",
  "beef",
  "pork",
  "lamb",
  "turkey",
  "fish",
  "shellfish",
] as const;
export const NON_MEAT_PROTEIN_TAGS = [
  "tofu",
  "tempeh",
  "beans",
  "lentils",
  "eggs",
  "cheese",
  "vegetables",
] as const;
export const PROTEIN_TAGS = [...MEAT_PROTEIN_TAGS, ...NON_MEAT_PROTEIN_TAGS] as const;
export type ProteinTag = (typeof PROTEIN_TAGS)[number];

export const DIET_TAGS = ["vegetarian", "vegan", "gluten_free", "dairy_free"] as const;
export type DietTag = (typeof DIET_TAGS)[number];

export const METHOD_TAGS = [
  "sheet_pan",
  "one_pot",
  "skillet",
  "slow_cooker",
  "pressure_cooker",
  "grill",
  "no_cook",
  "bake",
] as const;
export type MethodTag = (typeof METHOD_TAGS)[number];

export const AUDIENCE_TAGS = ["kid_friendly", "pantry", "leftovers", "freezer_friendly"] as const;
export type AudienceTag = (typeof AUDIENCE_TAGS)[number];

export const TAG_VOCABULARY: readonly string[] = [
  COURSE_TAG,
  ...PROTEIN_TAGS,
  ...DIET_TAGS,
  ...METHOD_TAGS,
  ...AUDIENCE_TAGS,
];

/** The nine allergens (docs/05; WS06 `ALLERGENS`). */
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
export type Allergen = (typeof ALLERGENS)[number];

/** Meat, fish, and shellfish kinds an ingredient line can be. `other` has no protein tag. */
export type FleshKind =
  | "chicken"
  | "beef"
  | "pork"
  | "lamb"
  | "turkey"
  | "fish"
  | "shellfish"
  | "other";

// ---------------------------------------------------------------------------------------
// Coverage minimums (catalog.test.ts asserts every line)
// ---------------------------------------------------------------------------------------

export const COVERAGE = {
  minRecipes: 60,
  minCuisines: 10,
  maxPerCuisine: 12,
  proteinCaps: { chicken: 14, beef: 8, pork: 6, lamb: 3, turkey: 4, fish: 6, shellfish: 4 },
  minNonMeatProtein: 20,
  minVegetarian: 20,
  minVegan: 8,
  minGlutenFree: 15,
  minDairyFree: 15,
  minAllergenFree: 30,
  minQuick: 40,
  quickMinutes: 35,
  maxMinutes: 120,
  servings: 4,
  minIngredientLines: 5,
  maxIngredientLines: 16,
  minSteps: 4,
  maxSteps: 12,
  minResolvedShare: 0.9,
  resolvedConfidence: 0.8,
  minKidFriendly: 15,
  minPantry: 10,
  /** The CI step asserts at least this many ingredient lines across the catalog. */
  minTotalIngredientLines: 300,
} as const;

/** `pantry` means at most this many fresh lines (see freshLineCount). */
export const PANTRY_MAX_FRESH_LINES = 4;

// ---------------------------------------------------------------------------------------
// Banned text
// ---------------------------------------------------------------------------------------

export const RETAILER_NAMES: readonly string[] = [
  "Kroger",
  "QFC",
  "Fred Meyer",
  "Safeway",
  "Albertsons",
  "Costco",
  "Instacart",
  "Walmart",
  "Amazon",
  "Whole Foods",
  "Trader Joe's",
];

/** Food, drink, cookware, and restaurant brands. Recipes name ingredients, never products. */
export const BRAND_NAMES: readonly string[] = [
  "Heinz",
  "Hellmann's",
  "Best Foods",
  "Kraft",
  "Velveeta",
  "Miracle Whip",
  "Campbell's",
  "Progresso",
  "Swanson",
  "Lipton",
  "Knorr",
  "Maggi",
  "Bovril",
  "Better Than Bouillon",
  "Barilla",
  "Ragu",
  "Prego",
  "Classico",
  "Rao's",
  "Bertolli",
  "Philadelphia",
  "Boursin",
  "Laughing Cow",
  "Babybel",
  "Land O'Lakes",
  "Kerrygold",
  "Tillamook",
  "Daiya",
  "Beyond Meat",
  "Morningstar",
  "Gardein",
  "Quorn",
  "Tofurky",
  "Kikkoman",
  "La Choy",
  "Lea & Perrins",
  "Lea and Perrins",
  "Huy Fong",
  "Lee Kum Kee",
  "Tabasco",
  "Cholula",
  "Tapatio",
  "Tajin",
  "Frank's RedHot",
  "Old Bay",
  "Rotel",
  "Ro-Tel",
  "Old El Paso",
  "Tostitos",
  "Herdez",
  "Goya",
  "Bob's Red Mill",
  "Gold Medal",
  "King Arthur",
  "Diamond Crystal",
  "Morton",
  "Maldon",
  "McCormick",
  "Wonder Bread",
  "Pepperidge Farm",
  "Sara Lee",
  "Ore-Ida",
  "Birds Eye",
  "Green Giant",
  "Del Monte",
  "Bush's",
  "Muir Glen",
  "Hunt's",
  "Bisquick",
  "Cheerios",
  "Oreo",
  "Doritos",
  "Fritos",
  "Cheetos",
  "Pop-Tarts",
  "Pillsbury",
  "Betty Crocker",
  "Duncan Hines",
  "Hershey",
  "Nestle",
  "Nutella",
  "Spam",
  "Jell-O",
  "Cool Whip",
  "Crisco",
  "Coca-Cola",
  "Pepsi",
  "Dr Pepper",
  "Starbucks",
  "McDonald's",
  "Olive Garden",
  "Applebee's",
  "Cheesecake Factory",
  "Panda Express",
  "P.F. Chang's",
  "Chick-fil-A",
  "KFC",
  "Taco Bell",
  "Domino's",
  "Pizza Hut",
  "Wendy's",
  "Burger King",
  "In-N-Out",
  "Red Lobster",
  "Cracker Barrel",
  "Panera",
  "Texas Roadhouse",
  "Instant Pot",
  "Crock-Pot",
  "Crockpot",
  "Pyrex",
  "Tupperware",
  "Ziploc",
  "Reynolds Wrap",
  "Cuisinart",
  "KitchenAid",
  "Vitamix",
  "Le Creuset",
  "All-Clad",
  "Traeger",
  "Nutribullet",
];

/** Chefs, cooks, authors, and publications. Recipes are original and credit no one. */
export const PERSON_AND_PUBLICATION_NAMES: readonly string[] = [
  "Julia Child",
  "Gordon Ramsay",
  "Jamie Oliver",
  "Ina Garten",
  "Barefoot Contessa",
  "Martha Stewart",
  "Bobby Flay",
  "Rachael Ray",
  "Giada",
  "Nigella",
  "Alton Brown",
  "Guy Fieri",
  "Paula Deen",
  "Emeril",
  "Anthony Bourdain",
  "Ottolenghi",
  "Mark Bittman",
  "Kenji",
  "Lopez-Alt",
  "Ree Drummond",
  "Pioneer Woman",
  "Samin Nosrat",
  "Marcella Hazan",
  "Madhur Jaffrey",
  "Joanna Gaines",
  "Chrissy Teigen",
  "Bon Appetit",
  "Bon Appétit",
  "Epicurious",
  "Serious Eats",
  "Allrecipes",
  "Food Network",
  "Taste of Home",
  "NYT Cooking",
  "New York Times",
  "Cook's Illustrated",
  "America's Test Kitchen",
  "Delish",
  "BBC Good Food",
  "Food52",
  "Southern Living",
  "Simply Recipes",
  "Gimme Some Oven",
  "RecipeTin Eats",
  "Skinnytaste",
  "Cooking Light",
  "Saveur",
  "Food & Wine",
  "Real Simple",
  "Woks of Life",
  "Pinch of Yum",
  "Half Baked Harvest",
  "Minimalist Baker",
  "Smitten Kitchen",
  "Budget Bytes",
  "Tasty",
];

/** Words a recipe may not use (copyright posture, docs/05 and R5). */
export const BANNED_WORDS: readonly string[] = [
  "copycat",
  "famous",
  "authentic",
  "restaurant style",
  "restaurant-style",
  "best ever",
  "world's best",
];

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches `name` as a whole word or phrase, case-insensitive, with ' and ’ treated alike. */
function phrasePattern(name: string): RegExp {
  const body = escapeRegExp(name).replace(/['’]/g, "['’]?").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, "i");
}

const BANNED_PATTERNS: readonly { kind: string; name: string; re: RegExp }[] = [
  ...RETAILER_NAMES.map((name) => ({ kind: "retailer", name, re: phrasePattern(name) })),
  ...BRAND_NAMES.map((name) => ({ kind: "brand", name, re: phrasePattern(name) })),
  ...PERSON_AND_PUBLICATION_NAMES.map((name) => ({
    kind: "chef or publication",
    name,
    re: phrasePattern(name),
  })),
  ...BANNED_WORDS.map((name) => ({ kind: "banned word", name, re: phrasePattern(name) })),
];

const URL_PATTERN =
  /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|us|edu|gov|app|dev|ai|tv)\b|(?:^|\s)@[a-z0-9_.]{2,}/i;

/** Problems with one piece of text (a title, a line, a step). Empty when the text is clean. */
export function textProblems(text: string): string[] {
  const out: string[] = [];
  if (text.includes("—")) out.push("contains an em dash");
  if (text.includes("–")) out.push("contains an en dash");
  if (text.includes("!")) out.push("contains an exclamation mark");
  if (URL_PATTERN.test(text)) out.push("contains a URL or handle");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to catch them.
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) out.push("contains a control character");
  for (const { kind, name, re } of BANNED_PATTERNS) {
    if (re.test(text)) out.push(`names a ${kind}: ${name}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Deterministic diet and allergen checks
// ---------------------------------------------------------------------------------------

/** What the checks read from one ingredient line of a catalog JSON file. */
export interface LineInput {
  rawText: string;
  ingredientName: string | null;
  ingredientId: string | null;
}

interface Effects {
  /** A piece of meat, fish, or shellfish. Not vegetarian, not vegan. */
  flesh?: FleshKind;
  /** An animal product that is not flesh (fish sauce, gelatin, broth). Not vegetarian. */
  animal?: boolean;
  /** Milk. The milk allergen; not dairy free, not vegan. */
  dairy?: boolean;
  /** Egg. The egg allergen; not vegan. */
  egg?: boolean;
  honey?: boolean;
  /** Might contain animal products (flour tortillas, enriched bread). Not vegan only. */
  notVegan?: boolean;
  allergens?: readonly Allergen[];
  /** Gluten (wheat, barley, rye, malt, oats, soy sauce, broth). Not gluten free. */
  gluten?: boolean;
}

interface Rule {
  re: RegExp;
  /** The rule does not fire when this also matches the line. */
  unless?: RegExp;
  effects: Effects;
}

const any = (...terms: string[]): RegExp => new RegExp(`\\b(?:${terms.join("|")})\\b`, "i");

const PLANT_MILK = "(?:coconut|almond|oat|soy|rice|cashew|hemp|pea|plant|nut|macadamia|flax)";
const PLANT_QUALIFIER = any("vegan", "dairy[- ]free", "non[- ]dairy", "plant[- ]based");
const GLUTEN_FREE_QUALIFIER = any("gluten[- ]free");
const VEGETARIAN_QUALIFIER = any("vegan", "vegetarian", "meatless", "plant[- ]based");

const RULES: readonly Rule[] = [
  // ----- flesh -----
  { re: any("chicken"), unless: any("chicken[- ]free"), effects: { flesh: "chicken" } },
  { re: any("turkey"), effects: { flesh: "turkey" } },
  {
    re: any(
      "beef",
      "brisket",
      "short ribs?",
      "oxtail",
      "veal",
      "stew meat",
      "sirloin",
      "ribeye",
      "rib-eye",
      "flank",
      "skirt steak",
      "filet mignon",
      "chuck",
      "pot roast",
      "roast beef",
    ),
    effects: { flesh: "beef" },
  },
  {
    re: any("steaks?"),
    unless: any(
      "(?:cauliflower|cabbage|portobello|mushroom|eggplant|tofu|tempeh|vegetable|salmon|tuna|swordfish|halibut|fish)\\s+steaks?",
    ),
    effects: { flesh: "beef" },
  },
  {
    re: any(
      "pork",
      "bacon",
      "ham",
      "prosciutto",
      "pancetta",
      "guanciale",
      "chorizo",
      "kielbasa",
      "bratwurst",
      "salami",
      "pepperoni",
      "andouille",
      "mortadella",
      "bologna",
      "carnitas",
      "lard",
      "hot dogs?",
      "baby back ribs?",
      "spare ribs?",
    ),
    unless: any("turkey bacon", "(?:vegan|plant[- ]based|coconut|tempeh|mushroom)\\s+bacon"),
    effects: { flesh: "pork" },
  },
  {
    re: any("sausages?"),
    unless: any(
      "(?:chicken|turkey|beef|lamb|vegan|vegetarian|veggie|vegetable|plant[- ]based)\\s+sausages?",
    ),
    effects: { flesh: "pork" },
  },
  { re: any("lamb", "mutton"), effects: { flesh: "lamb" } },
  {
    re: any(
      "salmon",
      "cod",
      "tuna",
      "tilapia",
      "halibut",
      "mahi[- ]mahi",
      "sea bass",
      "bass",
      "trout",
      "swordfish",
      "snapper",
      "catfish",
      "haddock",
      "pollock",
      "herring",
      "mackerel",
      "sardines?",
      "eel",
      "whitefish",
      "white fish",
      "fish fillets?",
      "fish stock",
      "roe",
      "caviar",
      "smoked fish",
    ),
    effects: { flesh: "fish", allergens: ["fish"] },
  },
  {
    re: any(
      "shrimps?",
      "prawns?",
      "crabs?",
      "crab meat",
      "lobster",
      "scallops?",
      "clams?",
      "mussels?",
      "squid",
      "calamari",
      "octopus",
      "crawfish",
      "crayfish",
      "langoustines?",
      "abalone",
      "shellfish",
    ),
    effects: { flesh: "shellfish", allergens: ["shellfish"] },
  },
  {
    re: any("oysters?"),
    unless: any("oyster sauce", "oyster mushrooms?"),
    effects: { flesh: "shellfish", allergens: ["shellfish"] },
  },
  {
    re: any("imitation crab", "surimi"),
    effects: { flesh: "fish", allergens: ["fish", "shellfish"] },
  },
  {
    re: any(
      "duck",
      "goose",
      "bison",
      "venison",
      "rabbit",
      "liver",
      "kidney",
      "tripe",
      "meatballs?",
    ),
    unless: any("kidney beans?", "liver[- ]free"),
    effects: { flesh: "other" },
  },

  // ----- animal products that are not flesh -----
  {
    re: any("fish sauce"),
    effects: { animal: true, allergens: ["fish"] },
  },
  {
    re: any("worcestershire", "anchov(?:y|ies)", "dashi", "bonito", "katsuobushi"),
    unless: VEGETARIAN_QUALIFIER,
    effects: { animal: true, allergens: ["fish"], gluten: true },
  },
  {
    re: any("oyster sauce"),
    unless: VEGETARIAN_QUALIFIER,
    effects: { animal: true, allergens: ["shellfish", "soy", "wheat"], gluten: true },
  },
  { re: any("shrimp paste"), effects: { animal: true, allergens: ["shellfish"] } },
  {
    // Thai curry pastes often hold shrimp paste. Doubt unless the line says otherwise.
    re: any("curry pastes?"),
    unless: any("vegan", "vegetarian", "shrimp[- ]free", "plant[- ]based"),
    effects: { animal: true, allergens: ["shellfish"] },
  },
  {
    re: any("kimchi"),
    unless: any("vegan", "vegetarian"),
    effects: { animal: true, allergens: ["fish", "shellfish"] },
  },
  {
    re: any("caesar"),
    effects: { animal: true, allergens: ["fish", "egg", "milk"], egg: true, dairy: true },
  },
  { re: any("gelatin", "tallow", "suet", "schmaltz", "bone broth"), effects: { animal: true } },
  {
    // Broth, stock, and bouillon with no plant word before them are animal-derived and may hold
    // gluten. "vegetable broth" is still doubtful for gluten (labels differ) but not animal.
    re: any("broth", "stock", "bouillon", "consomme", "chicken base", "beef base"),
    unless: any(
      "(?:vegetable|veggie|mushroom|vegan|plant[- ]based|vegetarian|miso)\\s+(?:broth|stock|bouillon|base)",
    ),
    effects: { animal: true, gluten: true },
  },
  {
    re: any(
      "(?:vegetable|veggie|mushroom|vegan|plant[- ]based|vegetarian)\\s+(?:broth|stock|bouillon|base)",
    ),
    effects: { gluten: true },
  },
  {
    re: any("baked beans", "refried beans"),
    unless: VEGETARIAN_QUALIFIER,
    effects: { animal: true },
  },
  { re: any("honey", "bee pollen"), effects: { honey: true } },
  { re: any("flour tortillas?"), effects: { notVegan: true } },

  // ----- milk -----
  {
    re: any("milk", "buttermilk"),
    unless: new RegExp(`${PLANT_MILK}\\s+milk|milk chocolate|milkweed`, "i"),
    effects: { dairy: true, allergens: ["milk"] },
  },
  {
    re: any(
      "cream",
      "half[- ]and[- ]half",
      "creme fraiche",
      "whipping cream",
      "heavy cream",
      "sour cream",
    ),
    unless: any(
      "coconut cream",
      "cream of tartar",
      "cream of coconut",
      "cashew cream",
      "ice cream",
    ),
    effects: { dairy: true, allergens: ["milk"] },
  },
  { re: any("ice cream", "custard", "eggnog"), effects: { dairy: true, allergens: ["milk"] } },
  {
    re: any("butter"),
    unless: any(
      "(?:peanut|almond|cashew|nut|seed|sunflower|cocoa|shea|apple|sesame|tahini)\\s+butter",
      "butter\\s+(?:beans?|lettuce)",
      "vegan butter",
    ),
    effects: { dairy: true, allergens: ["milk"] },
  },
  { re: any("ghee", "margarine"), effects: { dairy: true, allergens: ["milk", "soy"] } },
  {
    re: any("yogh?urt", "kefir"),
    unless: any("(?:coconut|almond|soy|oat|cashew|plant[- ]based)\\s+yogh?urt"),
    effects: { dairy: true, allergens: ["milk"] },
  },
  {
    re: any(
      "cheeses?",
      "parmesan",
      "parmigiano",
      "pecorino",
      "romano",
      "mozzarella",
      "cheddar",
      "gruyere",
      "gouda",
      "provolone",
      "fontina",
      "asiago",
      "manchego",
      "havarti",
      "gorgonzola",
      "feta",
      "halloumi",
      "paneer",
      "ricotta",
      "mascarpone",
      "cotija",
      "queso",
      "brie",
      "monterey jack",
      "pepper jack",
      "colby",
      "cream cheese",
    ),
    unless: any("(?:vegan|dairy[- ]free|plant[- ]based|cashew|nut)\\s+cheese"),
    effects: { dairy: true, allergens: ["milk"] },
  },
  {
    re: any(
      "whey",
      "casein",
      "milk powder",
      "dry milk",
      "evaporated milk",
      "condensed milk",
      "alfredo",
      "ranch",
      "tzatziki",
      "tikka masala sauce",
      "korma",
      "butter chicken sauce",
    ),
    effects: { dairy: true, allergens: ["milk"] },
  },
  {
    re: any(
      "naan",
      "brioche",
      "croissants?",
      "biscuits?",
      "cream of (?:mushroom|chicken|celery) soup",
    ),
    effects: { dairy: true, allergens: ["milk", "wheat"], gluten: true },
  },
  {
    re: any("pesto"),
    effects: { dairy: true, allergens: ["milk", "tree_nut"] },
  },

  // ----- egg -----
  {
    re: any(
      "eggs?",
      "egg whites?",
      "egg yolks?",
      "mayonnaise",
      "mayo",
      "aioli",
      "meringue",
      "hollandaise",
      "bearnaise",
      "tartar sauce",
      "challah",
      "brioche",
    ),
    unless: any("egg[- ]free", "vegan (?:mayo|mayonnaise|egg)", "eggplants?"),
    effects: { egg: true, allergens: ["egg"] },
  },
  {
    re: any("egg noodles?", "ranch", "custard", "eggnog"),
    effects: { egg: true, allergens: ["egg"] },
  },

  // ----- wheat and gluten -----
  {
    re: any("flour", "wheat", "semolina", "durum", "spelt", "kamut", "einkorn", "triticale"),
    unless: any(
      "(?:rice|corn|almond|coconut|chickpea|gram|besan|tapioca|cassava|potato|buckwheat|sorghum|arrowroot|masa|millet|teff|quinoa|lentil|soy|nut|cashew)\\s+(?:flour|meal)",
      "gluten[- ]free\\s+(?:all[- ]purpose\\s+)?flour(?:\\s+blend)?",
      "buckwheat",
    ),
    effects: { allergens: ["wheat"], gluten: true },
  },
  {
    re: any(
      "oat flour",
      "oats?",
      "rolled oats",
      "steel[- ]cut oats",
      "barley",
      "rye",
      "malt",
      "malt vinegar",
      "beer",
      "ale",
      "lager",
      "stout",
      "brewer's yeast",
    ),
    effects: { gluten: true },
  },
  {
    re: any("breads?", "bread ?crumbs?", "panko", "croutons?", "stuffing", "cornbread", "toast"),
    unless: any("breadfruit"),
    effects: { allergens: ["wheat"], gluten: true, notVegan: true },
  },
  {
    re: any(
      "pasta",
      "spaghetti",
      "penne",
      "rotini",
      "macaroni",
      "linguine",
      "fettuccine",
      "angel hair",
      "lasagn?a",
      "orzo",
      "ziti",
      "rigatoni",
      "farfalle",
      "tortellini",
      "ravioli",
      "bucatini",
      "pappardelle",
      "gnocchi",
      "cavatappi",
      "ditalini",
      "couscous",
      "bulgur",
      "farro",
      "seitan",
      "ramen",
      "udon",
      "soba",
    ),
    unless: GLUTEN_FREE_QUALIFIER,
    effects: { allergens: ["wheat"], gluten: true },
  },
  {
    re: any("vermicelli"),
    unless: any("rice vermicelli", "gluten[- ]free"),
    effects: { allergens: ["wheat"], gluten: true },
  },
  {
    re: any("noodles?"),
    unless: any(
      "(?:rice|glass|cellophane|shirataki|sweet potato|mung bean|konjac|zucchini|vegetable|bean thread)\\s+noodles?",
      "gluten[- ]free",
    ),
    effects: { allergens: ["wheat"], gluten: true },
  },
  {
    re: any(
      "pitas?",
      "pita bread",
      "buns?",
      "dinner rolls?",
      "sandwich rolls?",
      "hoagie rolls?",
      "bagels?",
      "baguettes?",
      "ciabatta",
      "focaccia",
      "sourdough",
      "crackers?",
      "pizza dough",
      "pizza crust",
      "pie crust",
      "puff pastry",
      "phyllo",
      "filo",
      "dumplings?",
      "wontons?",
      "wonton wrappers?",
      "egg roll wrappers?",
      "pancakes?",
      "waffles?",
      "cakes?",
      "cookies?",
      "muffins?",
      "donuts?",
      "gravy",
      "breaded",
      "battered",
      "tempura",
    ),
    effects: { allergens: ["wheat"], gluten: true, notVegan: true },
  },
  {
    re: any("tortillas?"),
    unless: any("corn tortillas?", "tortilla chips?", "masa", "gluten[- ]free", "tortilla soup"),
    effects: { allergens: ["wheat"], gluten: true },
  },
  {
    re: any("soy sauce", "tamari", "shoyu", "teriyaki", "hoisin"),
    effects: { allergens: ["soy", "wheat"], gluten: true },
  },
  {
    re: any("miso", "gochujang", "doenjang", "black bean sauce", "bean paste"),
    effects: { allergens: ["soy"], gluten: true },
  },

  // ----- soy -----
  {
    re: any(
      "soy",
      "soya",
      "soybeans?",
      "tofu",
      "tempeh",
      "edamame",
      "natto",
      "tvp",
      "textured vegetable protein",
    ),
    effects: { allergens: ["soy"] },
  },

  // ----- nuts, peanuts, sesame -----
  { re: any("peanuts?", "groundnuts?", "satay"), effects: { allergens: ["peanut"] } },
  {
    re: any(
      "almonds?",
      "walnuts?",
      "pecans?",
      "cashews?",
      "pistachios?",
      "hazelnuts?",
      "filberts?",
      "macadamias?",
      "pine nuts?",
      "pignoli",
      "brazil nuts?",
      "chestnuts?",
      "marzipan",
      "praline",
      "amaretto",
      "frangelico",
      "nougat",
      "romesco",
      "dukkah",
      "baklava",
    ),
    unless: any("water chestnuts?"),
    effects: { allergens: ["tree_nut"] },
  },
  {
    re: any("mixed nuts?", "nut butters?", "trail mix", "nutella", "hazelnut spread"),
    effects: { allergens: ["peanut", "tree_nut"] },
  },
  {
    re: any(
      "sesame",
      "tahini",
      "hummus",
      "furikake",
      "gomasio",
      "za'atar",
      "zaatar",
      "dukkah",
      "halva",
      "halvah",
      "baba ghanou?sh",
      "everything bagel",
      "everything seasoning",
    ),
    effects: { allergens: ["sesame"] },
  },
  { re: any("hummus"), effects: { allergens: ["sesame"] } },
];

/** Lines the ontology could not resolve are doubt, unless they are plain seasonings. */
const BENIGN_UNRESOLVED = any(
  "salt",
  "pepper",
  "peppercorns?",
  "powder",
  "flakes?",
  "seeds?",
  "leaf",
  "leaves",
  "zest",
  "extract",
  "paprika",
  "cumin",
  "coriander",
  "turmeric",
  "cinnamon",
  "cardamom",
  "oregano",
  "thyme",
  "basil",
  "parsley",
  "cilantro",
  "dill",
  "mint",
  "sage",
  "rosemary",
  "tarragon",
  "chives?",
  "chiles?",
  "chilis?",
  "vinegar",
  "water",
  "ginger",
  "garlic",
  "lime",
  "lemon",
  "sumac",
  "nutmeg",
  "allspice",
  "cloves?",
);

export interface LineFacts {
  flesh: FleshKind[];
  animal: boolean;
  dairy: boolean;
  egg: boolean;
  honey: boolean;
  notVegan: boolean;
  allergens: Allergen[];
  gluten: boolean;
  /** True when the line is unresolved and not a plain seasoning. */
  unknown: boolean;
}

/** Plant milks sit in the ontology's dairy section. They carry their own allergens. */
function plantMilkAllergens(text: string): readonly Allergen[] | null {
  if (!new RegExp(`${PLANT_MILK}\\s+milk`, "i").test(text)) return null;
  const out: Allergen[] = [];
  if (/\b(?:almond|cashew|macadamia|nut)\s+milk/i.test(text)) out.push("tree_nut");
  if (/\bsoy\s+milk/i.test(text)) out.push("soy");
  return out;
}

export function analyzeLine(
  line: LineInput,
  categoryOf: (name: string) => string | undefined,
): LineFacts {
  const text = `${line.rawText} ${line.ingredientName ?? ""}`.toLowerCase().replace(/[’]/g, "'");
  const flesh = new Set<FleshKind>();
  const allergens = new Set<Allergen>();
  let animal = false;
  let dairy = false;
  let egg = false;
  let honey = false;
  let notVegan = false;
  let gluten = false;
  let matched = false;

  for (const rule of RULES) {
    if (!rule.re.test(text) || rule.unless?.test(text)) continue;
    matched = true;
    const e = rule.effects;
    if (e.flesh) flesh.add(e.flesh);
    if (e.animal) animal = true;
    if (e.dairy) dairy = true;
    if (e.egg) egg = true;
    if (e.honey) honey = true;
    if (e.notVegan) notVegan = true;
    if (e.gluten) gluten = true;
    for (const a of e.allergens ?? []) allergens.add(a);
  }
  for (const a of plantMilkAllergens(text) ?? []) {
    allergens.add(a);
    matched = true;
  }
  if (/\boat\s+milk/.test(text)) gluten = true;

  // The ontology's own section fills in what the words missed.
  const category = line.ingredientName ? categoryOf(line.ingredientName) : undefined;
  const plantMilk = plantMilkAllergens(text) !== null;
  if (category === "meat" && flesh.size === 0) flesh.add("other");
  if (category === "seafood" && flesh.size === 0) {
    flesh.add("other");
    allergens.add("fish");
    allergens.add("shellfish");
  }
  if (category === "dairy" && !plantMilk && !dairy && !/\b(?:vegan|dairy[- ]free)\b/.test(text)) {
    dairy = true;
    allergens.add("milk");
  }
  if (category === "eggs" && !egg) {
    egg = true;
    allergens.add("egg");
  }

  // Qualifiers the line states for itself.
  if (GLUTEN_FREE_QUALIFIER.test(text)) {
    gluten = false;
    allergens.delete("wheat");
  }
  if (PLANT_QUALIFIER.test(text)) {
    dairy = false;
    egg = false;
    notVegan = false;
    allergens.delete("milk");
    allergens.delete("egg");
  }

  const unresolved = line.ingredientId === null;
  const unknown = unresolved && !matched && !BENIGN_UNRESOLVED.test(text);
  return {
    flesh: [...flesh],
    animal,
    dairy,
    egg,
    honey,
    notVegan,
    allergens: [...allergens],
    gluten,
    unknown,
  };
}

export interface RecipeFacts {
  /** Allergens a line might carry, in the order of ALLERGENS. */
  allergens: Allergen[];
  /** Diet tags the lines support, in the order of DIET_TAGS. */
  diets: DietTag[];
  /** Kinds of meat, fish, and shellfish present. */
  flesh: FleshKind[];
  /** Raw text of unresolved lines the checks could not clear. */
  unknownLines: string[];
  /** No allergen and nothing unclear. */
  allergenFree: boolean;
}

export function analyzeRecipe(
  lines: readonly LineInput[],
  categoryOf: (name: string) => string | undefined,
): RecipeFacts {
  const facts = lines.map((line) => analyzeLine(line, categoryOf));
  const allergens = new Set<Allergen>();
  const flesh = new Set<FleshKind>();
  let animal = false;
  let dairy = false;
  let egg = false;
  let honey = false;
  let notVegan = false;
  let gluten = false;
  const unknownLines: string[] = [];
  facts.forEach((f, i) => {
    for (const a of f.allergens) allergens.add(a);
    for (const k of f.flesh) flesh.add(k);
    animal ||= f.animal;
    dairy ||= f.dairy;
    egg ||= f.egg;
    honey ||= f.honey;
    notVegan ||= f.notVegan;
    gluten ||= f.gluten;
    if (f.unknown) unknownLines.push(lines[i]?.rawText ?? "");
  });
  const doubt = unknownLines.length > 0;
  const vegetarian = !doubt && flesh.size === 0 && !animal;
  const diets: DietTag[] = [];
  if (vegetarian) diets.push("vegetarian");
  if (vegetarian && !dairy && !egg && !honey && !notVegan) diets.push("vegan");
  if (!doubt && !gluten) diets.push("gluten_free");
  if (!doubt && !dairy) diets.push("dairy_free");
  return {
    allergens: ALLERGENS.filter((a) => allergens.has(a)),
    diets,
    flesh: [...flesh],
    unknownLines,
    allergenFree: allergens.size === 0 && !doubt,
  };
}

/**
 * Kinds of flesh a recipe holds that its protein tag does not name. Empty when honest: a chicken
 * recipe holds chicken only, and a recipe with a non-meat protein holds no flesh at all.
 */
export function strayFlesh(protein: ProteinTag, facts: RecipeFacts): FleshKind[] {
  return facts.flesh.filter((kind) => kind !== protein);
}

/** Fresh lines a pantry recipe may count: perishable sections, minus long-keeping produce. */
const KEEPS_WELL = any(
  "onions?",
  "garlic",
  "potatoes",
  "carrots?",
  "lemons?",
  "limes?",
  "ginger",
  "cabbage",
  "shallots?",
  "sweet potatoes?",
);
const FRESH_CATEGORIES = new Set(["produce", "meat", "seafood", "dairy", "eggs", "bakery"]);

export function freshLineCount(
  lines: readonly LineInput[],
  categoryOf: (name: string) => string | undefined,
): number {
  return lines.filter((line) => {
    if (!line.ingredientName) return false;
    const category = categoryOf(line.ingredientName);
    if (!category || !FRESH_CATEGORIES.has(category)) return false;
    return !KEEPS_WELL.test(line.ingredientName);
  }).length;
}

/** True when the lines hold the named protein: the check behind "tag the protein honestly". */
export function proteinPresent(
  protein: ProteinTag,
  lines: readonly (LineInput & { qty?: number | null })[],
  facts: RecipeFacts,
): boolean {
  const names = lines.map((l) => `${l.ingredientName ?? ""} ${l.rawText}`.toLowerCase());
  switch (protein) {
    case "chicken":
    case "beef":
    case "pork":
    case "lamb":
    case "turkey":
    case "fish":
    case "shellfish":
      return facts.flesh.includes(protein);
    case "tofu":
      return names.some((n) => /\btofu\b/.test(n));
    case "tempeh":
      return names.some((n) => /\btempeh\b/.test(n));
    case "beans":
      return names.some((n) =>
        /\b(?:black|kidney|pinto|cannellini|navy|white|red|great northern|garbanzo|lima)?\s*beans?\b|\bchickpeas?\b|\bgarbanzo/.test(
          n.replace(/green beans?|bean sprouts?|vanilla bean|black bean sauce|jelly beans?/g, ""),
        ),
      );
    case "lentils":
      return names.some((n) => /\blentils?\b/.test(n));
    case "eggs":
      return lines.some(
        (l) => /\beggs?\b/i.test(`${l.ingredientName ?? ""} ${l.rawText}`) && (l.qty ?? 0) >= 3,
      );
    case "cheese":
      return (
        names.filter((n) =>
          /\bcheese|ricotta|mozzarella|parmesan|cheddar|feta|paneer|halloumi/.test(n),
        ).length >= 1
      );
    case "vegetables":
      return true;
  }
}

// ---------------------------------------------------------------------------------------
// The JSON file shape (supabase/seed/catalog/recipes/<slug>.json)
// ---------------------------------------------------------------------------------------

export interface CatalogIngredient {
  position: number;
  groupName: string | null;
  rawText: string;
  qty: number | null;
  qtyMax: number | null;
  unit: string | null;
  ingredientName: string | null;
  ingredientId: string | null;
  prepNote: string | null;
  optional: boolean;
  parseConfidence: number | null;
}

export interface CatalogDraftInfo {
  model: string;
  promptVersion: string;
  draftedAt: string;
  costUsd: number;
}

export interface CatalogRecipe {
  id: string;
  slug: string;
  title: string;
  description: string;
  servings: number;
  prepMin: number;
  cookMin: number;
  cuisine: string;
  tags: string[];
  ingredients: CatalogIngredient[];
  instructions: string[];
  draft: CatalogDraftInfo;
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Problems with the shape and the text of one recipe file. Checks that need the ontology or the
 * unit table (ids exist, unit codes, diet agreement) are in catalog.test.ts and the script.
 */
export function shapeProblems(value: unknown): string[] {
  const out: string[] = [];
  if (!isRecord(value)) return ["not an object"];
  const r = value;
  const str = (key: string, min = 1, max = Number.POSITIVE_INFINITY): string | null => {
    const v = r[key];
    if (typeof v !== "string" || v.trim().length < min || v.length > max) {
      out.push(`${key} must be a string of ${min} to ${max} characters`);
      return null;
    }
    return v;
  };
  const whole = (key: string, min: number, max: number): number | null => {
    const v = r[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      out.push(`${key} must be an integer from ${min} to ${max}`);
      return null;
    }
    return v;
  };

  const slug = str("slug");
  if (slug !== null && !SLUG_PATTERN.test(slug)) out.push("slug must be lowercase kebab-case");
  const id = str("id");
  if (id !== null && !UUID_PATTERN.test(id)) out.push("id must be a lowercase uuid");
  if (slug !== null && id !== null && id !== recipeId(slug))
    out.push("id is not the uuid v5 of the slug");
  const title = str("title", 1, 200);
  const description = str("description", 1, 4000);
  const cuisine = str("cuisine", 1, 80);
  if (cuisine !== null && cuisine !== cuisine.toLowerCase()) out.push("cuisine must be lowercase");
  if (r.servings !== COVERAGE.servings) out.push(`servings must be ${COVERAGE.servings}`);
  const prep = whole("prepMin", 0, COVERAGE.maxMinutes);
  const cook = whole("cookMin", 0, COVERAGE.maxMinutes);
  if (prep !== null && cook !== null && prep + cook > COVERAGE.maxMinutes) {
    out.push(`prepMin plus cookMin must not exceed ${COVERAGE.maxMinutes}`);
  }
  if (prep !== null && cook !== null && prep + cook < 5)
    out.push("total time must be at least 5 minutes");

  const tags = r.tags;
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) {
    out.push("tags must be an array of strings");
  } else {
    for (const tag of tags as string[]) {
      if (!TAG_VOCABULARY.includes(tag)) out.push(`tag "${tag}" is not in the vocabulary`);
    }
    if (new Set(tags).size !== tags.length) out.push("tags repeat");
    if (!tags.includes(COURSE_TAG)) out.push(`tags must include ${COURSE_TAG}`);
    const proteins = (tags as string[]).filter((t) =>
      (PROTEIN_TAGS as readonly string[]).includes(t),
    );
    if (proteins.length !== 1)
      out.push(`tags must hold exactly one protein tag, found ${proteins.length}`);
  }

  const lines = r.ingredients;
  if (!Array.isArray(lines)) {
    out.push("ingredients must be an array");
  } else {
    if (lines.length < COVERAGE.minIngredientLines || lines.length > COVERAGE.maxIngredientLines) {
      out.push(
        `ingredients must hold ${COVERAGE.minIngredientLines} to ${COVERAGE.maxIngredientLines} lines`,
      );
    }
    lines.forEach((line: unknown, i) => {
      const where = `ingredients[${i}]`;
      if (!isRecord(line)) {
        out.push(`${where} is not an object`);
        return;
      }
      if (line.position !== i) out.push(`${where}.position must be ${i}`);
      const raw = line.rawText;
      if (typeof raw !== "string" || raw.trim().length === 0 || raw.length > 500) {
        out.push(`${where}.rawText must be a string of 1 to 500 characters`);
      }
      if (
        line.groupName !== null &&
        (typeof line.groupName !== "string" || line.groupName.length > 200)
      ) {
        out.push(`${where}.groupName must be null or a short string`);
      }
      for (const key of ["qty", "qtyMax", "parseConfidence"] as const) {
        const v = line[key];
        if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
          out.push(`${where}.${key} must be null or a non-negative number`);
        }
      }
      if (
        typeof line.qty === "number" &&
        typeof line.qtyMax === "number" &&
        line.qtyMax < line.qty
      ) {
        out.push(`${where}.qtyMax must not be below qty`);
      }
      if (typeof line.parseConfidence === "number" && line.parseConfidence > 1) {
        out.push(`${where}.parseConfidence must be at most 1`);
      }
      for (const key of ["unit", "ingredientName", "prepNote"] as const) {
        if (line[key] !== null && typeof line[key] !== "string")
          out.push(`${where}.${key} must be null or a string`);
      }
      if (
        line.ingredientId !== null &&
        (typeof line.ingredientId !== "string" || !UUID_PATTERN.test(line.ingredientId))
      ) {
        out.push(`${where}.ingredientId must be null or a uuid`);
      }
      if (typeof line.optional !== "boolean") out.push(`${where}.optional must be a boolean`);
      if (typeof raw === "string") {
        for (const p of textProblems(raw)) out.push(`${where}.rawText ${p}`);
      }
      if (typeof line.prepNote === "string") {
        for (const p of textProblems(line.prepNote)) out.push(`${where}.prepNote ${p}`);
      }
      if (typeof line.groupName === "string") {
        for (const p of textProblems(line.groupName)) out.push(`${where}.groupName ${p}`);
      }
    });
  }

  const steps = r.instructions;
  if (
    !Array.isArray(steps) ||
    steps.some((s) => typeof s !== "string" || s.trim().length === 0 || s.length > 4000)
  ) {
    out.push("instructions must be an array of non-empty strings");
  } else {
    if (steps.length < COVERAGE.minSteps || steps.length > COVERAGE.maxSteps) {
      out.push(`instructions must hold ${COVERAGE.minSteps} to ${COVERAGE.maxSteps} steps`);
    }
    steps.forEach((s, i) => {
      for (const p of textProblems(s as string)) out.push(`instructions[${i}] ${p}`);
    });
  }

  for (const [key, text] of [
    ["title", title],
    ["description", description],
    ["cuisine", cuisine],
  ] as const) {
    if (text !== null) for (const p of textProblems(text)) out.push(`${key} ${p}`);
  }

  const draft = r.draft;
  if (!isRecord(draft)) {
    out.push("draft must be an object");
  } else {
    if (typeof draft.model !== "string") out.push("draft.model must be a string");
    if (typeof draft.promptVersion !== "string") out.push("draft.promptVersion must be a string");
    if (typeof draft.draftedAt !== "string" || Number.isNaN(Date.parse(draft.draftedAt))) {
      out.push("draft.draftedAt must be an ISO timestamp");
    }
    if (typeof draft.costUsd !== "number" || draft.costUsd < 0)
      out.push("draft.costUsd must be a non-negative number");
  }
  return out;
}

/** The single protein tag of a recipe, or null when the file has none. */
export function proteinOf(tags: readonly string[]): ProteinTag | null {
  const found = tags.find((t) => (PROTEIN_TAGS as readonly string[]).includes(t));
  return (found as ProteinTag | undefined) ?? null;
}

/** The tags a recipe gets from its parts: course, protein, computed diets, methods, audience. */
export function buildTags(parts: {
  protein: ProteinTag;
  diets: readonly DietTag[];
  methods: readonly MethodTag[];
  audience: readonly AudienceTag[];
}): string[] {
  return [COURSE_TAG, parts.protein, ...parts.diets, ...parts.methods, ...parts.audience];
}

// ---------------------------------------------------------------------------------------
// The plan: one slot per recipe the drafting script asks for
// ---------------------------------------------------------------------------------------

export type DietIntent = "vegan" | "gluten_free" | "dairy_free";

export interface Slot {
  /** The file name and the id seed. Pick once: a changed slug is a new recipe. */
  slug: string;
  /** A working idea. The model writes the final title. */
  dish: string;
  cuisine: string;
  protein: ProteinTag;
  methods: readonly MethodTag[];
  audience: readonly AudienceTag[];
  /** Diet tags the recipe must earn. Vegetarian is implied by a non-meat protein. */
  diets: readonly DietIntent[];
  /** None of the nine allergens. */
  allergenFree?: boolean;
  /** Upper bound for prep plus cook. */
  maxMinutes: number;
}

const slot = (
  slug: string,
  dish: string,
  cuisine: string,
  protein: ProteinTag,
  methods: readonly MethodTag[],
  audience: readonly AudienceTag[],
  diets: readonly DietIntent[],
  maxMinutes: number,
  allergenFree = false,
): Slot => ({ slug, dish, cuisine, protein, methods, audience, diets, maxMinutes, allergenFree });

const GF: DietIntent = "gluten_free";
const DF: DietIntent = "dairy_free";
const VG: DietIntent = "vegan";

/**
 * Ordered so that any prefix is a varied mix of proteins, cuisines and times, and so that the
 * whole list stays inside every cap in COVERAGE even when nothing is rejected.
 */
export const PLAN: readonly Slot[] = [
  slot(
    "sheet-pan-lemon-chicken-thighs",
    "Lemon garlic boneless chicken thighs roasted on a sheet pan with potatoes and green beans",
    "american",
    "chicken",
    ["sheet_pan"],
    ["kid_friendly", "leftovers"],
    [GF, DF],
    50,
    true,
  ),
  slot(
    "black-bean-tacos",
    "Black bean tacos in corn tortillas with cabbage slaw and avocado",
    "mexican",
    "beans",
    ["skillet"],
    ["kid_friendly", "pantry"],
    [VG, GF, DF],
    25,
    true,
  ),
  slot(
    "chicken-tikka-masala",
    "Chicken tikka masala in a tomato cream sauce, served with basmati rice",
    "indian",
    "chicken",
    ["skillet"],
    ["leftovers", "freezer_friendly"],
    [GF],
    35,
  ),
  slot(
    "beef-and-broccoli-stir-fry",
    "Beef and broccoli stir fry in a ginger coconut aminos sauce, over rice",
    "chinese",
    "beef",
    ["skillet"],
    ["kid_friendly"],
    [GF, DF],
    30,
    true,
  ),
  slot(
    "red-lentil-dal",
    "Red lentil dal with ginger, garlic, and turmeric, served with basmati rice",
    "indian",
    "lentils",
    ["one_pot"],
    ["pantry", "leftovers", "freezer_friendly"],
    [VG, GF, DF],
    35,
    true,
  ),
  slot(
    "sheet-pan-salmon-and-broccoli",
    "Sheet pan salmon with broccoli and lemon",
    "american",
    "fish",
    ["sheet_pan"],
    ["kid_friendly"],
    [GF, DF],
    25,
  ),
  slot(
    "spaghetti-with-meat-sauce",
    "Spaghetti with a ground beef and tomato sauce, made with gluten-free spaghetti and no cheese",
    "italian",
    "beef",
    ["skillet"],
    ["kid_friendly", "freezer_friendly"],
    [GF, DF],
    35,
    true,
  ),
  slot(
    "crispy-tofu-vegetable-stir-fry",
    "Crispy tofu with broccoli, peppers, and carrots in a ginger soy sauce, over rice",
    "chinese",
    "tofu",
    ["skillet"],
    [],
    [VG, DF],
    30,
  ),
  slot(
    "garlic-shrimp-with-rice",
    "Garlic shrimp with lemon and parsley over rice",
    "spanish",
    "shellfish",
    ["skillet"],
    [],
    [GF, DF],
    20,
  ),
  slot(
    "white-bean-and-kale-soup",
    "White bean and kale soup with garlic and rosemary",
    "italian",
    "beans",
    ["one_pot"],
    ["pantry", "leftovers", "freezer_friendly"],
    [VG, GF, DF],
    35,
    true,
  ),
  slot(
    "pork-chops-with-apples",
    "Pan seared pork chops with apples and onions",
    "american",
    "pork",
    ["skillet"],
    ["kid_friendly"],
    [GF, DF],
    30,
    true,
  ),
  slot(
    "shakshuka",
    "Eggs poached in a spiced tomato and pepper sauce",
    "middle eastern",
    "eggs",
    ["skillet"],
    ["pantry"],
    [GF, DF],
    30,
  ),
  slot(
    "one-pot-chicken-and-rice",
    "One pot chicken and rice with peas and carrots",
    "american",
    "chicken",
    ["one_pot"],
    ["kid_friendly", "leftovers"],
    [GF, DF],
    35,
    true,
  ),
  slot(
    "fish-tacos-with-cabbage-slaw",
    "Pan seared white fish tacos in corn tortillas with lime cabbage slaw",
    "mexican",
    "fish",
    ["skillet"],
    ["kid_friendly"],
    [GF, DF],
    30,
  ),
  slot(
    "lamb-kofta-with-yogurt-sauce",
    "Spiced lamb kofta with lemon herb sauce, cucumber, and rice",
    "middle eastern",
    "lamb",
    ["grill"],
    [],
    [GF, DF],
    35,
    true,
  ),
  slot(
    "turkey-burrito-bowls",
    "Ground turkey burrito bowls with rice, black beans, corn, and salsa",
    "mexican",
    "turkey",
    ["skillet"],
    ["kid_friendly", "leftovers"],
    [GF, DF],
    30,
    true,
  ),
  slot(
    "chickpea-spinach-curry",
    "Chickpea and spinach curry with tomatoes",
    "indian",
    "beans",
    ["one_pot"],
    ["pantry", "leftovers", "freezer_friendly"],
    [VG, GF, DF],
    30,
    true,
  ),
  slot(
    "chicken-teriyaki-bowls",
    "Chicken teriyaki rice bowls with steamed broccoli, using a homemade sauce of coconut aminos, ginger, and garlic",
    "japanese",
    "chicken",
    ["skillet"],
    ["kid_friendly"],
    [GF, DF],
    30,
    true,
  ),
  slot(
    "stovetop-mac-and-cheese",
    "Stovetop macaroni and cheese with broccoli",
    "american",
    "cheese",
    ["one_pot"],
    ["kid_friendly", "pantry"],
    [],
    30,
  ),
  slot(
    "sheet-pan-sausage-and-peppers",
    "Italian sausage with bell peppers, onions, and potatoes on a sheet pan",
    "italian",
    "pork",
    ["sheet_pan"],
    ["kid_friendly"],
    [GF, DF],
    35,
    true,
  ),
  slot(
    "mushroom-stroganoff",
    "Mushroom stroganoff with sour cream over egg noodles",
    "eastern european",
    "vegetables",
    ["skillet"],
    ["kid_friendly"],
    [],
    35,
  ),
  slot(
    "chicken-fajita-skillet",
    "Chicken fajitas with peppers and onions, served in corn tortillas",
    "mexican",
    "chicken",
    ["skillet"],
    ["kid_friendly"],
    [GF, DF],
    30,
    true,
  ),
  slot(
    "pressure-cooker-beef-stew",
    "Beef stew with potatoes and carrots made in an electric pressure cooker",
    "american",
    "beef",
    ["pressure_cooker"],
    ["freezer_friendly", "leftovers"],
    [GF, DF],
    75,
    true,
  ),
  slot(
    "tofu-scramble-tacos",
    "Tofu scramble tacos with peppers and onions in corn tortillas",
    "mexican",
    "tofu",
    ["skillet"],
    ["kid_friendly"],
    [VG, GF, DF],
    25,
  ),
  slot(
    "miso-glazed-salmon-with-rice",
    "Miso glazed salmon with rice and green beans",
    "japanese",
    "fish",
    ["bake"],
    [],
    [DF],
    25,
  ),
  slot(
    "chicken-piccata",
    "Chicken piccata with lemon and capers over spaghetti",
    "italian",
    "chicken",
    ["skillet"],
    [],
    [],
    35,
  ),
  slot(
    "lentil-bolognese",
    "Lentil and mushroom bolognese over gluten-free spaghetti",
    "italian",
    "lentils",
    ["skillet"],
    ["freezer_friendly"],
    [VG, GF, DF],
    40,
    true,
  ),
  slot(
    "thai-basil-chicken",
    "Stir fried chicken with Thai basil, chiles, and garlic over jasmine rice",
    "thai",
    "chicken",
    ["skillet"],
    [],
    [DF],
    30,
  ),
  slot(
    "tuna-pasta-with-lemon-and-peas",
    "Pantry tuna pasta with lemon, capers, and peas",
    "italian",
    "fish",
    ["one_pot"],
    ["pantry", "kid_friendly"],
    [DF],
    25,
  ),
  slot(
    "pasta-e-fagioli",
    "Pasta e fagioli with cannellini beans and tomatoes, made with gluten-free small pasta",
    "italian",
    "beans",
    ["one_pot"],
    ["pantry", "kid_friendly", "leftovers"],
    [VG, GF, DF],
    35,
    true,
  ),
  slot(
    "korean-beef-rice-bowls",
    "Ground beef bulgogi style rice bowls with cucumber and carrots, seasoned with coconut aminos, no sesame",
    "korean",
    "beef",
    ["skillet"],
    ["kid_friendly"],
    [GF, DF],
    25,
    true,
  ),
  slot(
    "spinach-mushroom-frittata",
    "Baked frittata with spinach, mushrooms, and cheese",
    "italian",
    "eggs",
    ["bake"],
    ["leftovers"],
    [GF],
    35,
  ),
  slot(
    "sheet-pan-shrimp-fajitas",
    "Sheet pan shrimp fajitas with peppers and onions in corn tortillas",
    "mexican",
    "shellfish",
    ["sheet_pan"],
    [],
    [GF, DF],
    25,
  ),
  slot(
    "chicken-chickpea-curry",
    "Chicken and chickpea curry in coconut milk",
    "indian",
    "chicken",
    ["one_pot"],
    ["pantry", "leftovers"],
    [GF, DF],
    35,
    true,
  ),
  slot(
    "maple-tempeh-sweet-potato-bowls",
    "Maple glazed tempeh with roasted sweet potatoes and kale",
    "american",
    "tempeh",
    ["sheet_pan"],
    [],
    [VG, GF, DF],
    35,
  ),
  slot(
    "classic-beef-chili",
    "Beef and kidney bean chili with tomatoes",
    "american",
    "beef",
    ["one_pot"],
    ["pantry", "freezer_friendly", "leftovers"],
    [GF, DF],
    60,
    true,
  ),
  slot(
    "baked-cod-with-tomatoes-and-olives",
    "Baked cod with cherry tomatoes, olives, and capers",
    "mediterranean",
    "fish",
    ["bake"],
    [],
    [GF, DF],
    30,
  ),
  slot(
    "chicken-fried-rice",
    "Chicken fried rice with eggs, peas, and carrots",
    "chinese",
    "chicken",
    ["skillet"],
    ["kid_friendly", "pantry"],
    [DF],
    25,
  ),
  slot(
    "mediterranean-lentil-soup",
    "Lentil soup with carrots, celery, and lemon",
    "mediterranean",
    "lentils",
    ["one_pot"],
    ["pantry", "leftovers", "freezer_friendly"],
    [VG, GF, DF],
    35,
    true,
  ),
  slot(
    "garlic-ginger-pork-lettuce-wraps",
    "Ground pork with garlic, ginger, and water chestnuts in lettuce cups, seasoned with coconut aminos",
    "chinese",
    "pork",
    ["skillet"],
    [],
    [GF, DF],
    25,
    true,
  ),
  slot(
    "huevos-rancheros",
    "Huevos rancheros with fried eggs, black beans, and salsa on corn tortillas",
    "mexican",
    "eggs",
    ["skillet"],
    ["kid_friendly"],
    [GF],
    25,
  ),
  slot(
    "coconut-shrimp-curry",
    "Shrimp in a coconut tomato curry with rice",
    "indian",
    "shellfish",
    ["one_pot"],
    [],
    [GF, DF],
    30,
  ),
  slot(
    "black-bean-burrito-bowls",
    "Black bean and rice burrito bowls with corn, salsa, and avocado",
    "mexican",
    "beans",
    ["one_pot"],
    ["pantry", "kid_friendly", "leftovers"],
    [VG, GF, DF],
    30,
    true,
  ),
  slot(
    "baked-chicken-parmesan",
    "Baked chicken parmesan with marinara over spaghetti",
    "italian",
    "chicken",
    ["bake"],
    ["kid_friendly", "freezer_friendly"],
    [],
    60,
  ),
  slot(
    "sweet-and-sour-tofu",
    "Sweet and sour tofu with pineapple and bell peppers over rice",
    "chinese",
    "tofu",
    ["skillet"],
    ["kid_friendly"],
    [VG, DF],
    30,
  ),
  slot(
    "grilled-flank-steak-with-corn",
    "Grilled flank steak with corn on the cob and zucchini",
    "american",
    "beef",
    ["grill"],
    [],
    [GF, DF],
    35,
    true,
  ),
  slot(
    "moroccan-lamb-and-chickpea-stew",
    "Moroccan spiced lamb and chickpea stew with carrots",
    "moroccan",
    "lamb",
    ["one_pot"],
    ["leftovers", "freezer_friendly"],
    [GF, DF],
    90,
    true,
  ),
  slot(
    "ratatouille-with-polenta",
    "Ratatouille with eggplant, zucchini, and tomatoes over soft polenta",
    "french",
    "vegetables",
    ["one_pot"],
    [],
    [VG, GF, DF],
    55,
    true,
  ),
  slot(
    "shrimp-pad-thai",
    "Shrimp pad thai with rice noodles, eggs, bean sprouts, and peanuts",
    "thai",
    "shellfish",
    ["skillet"],
    [],
    [GF],
    35,
  ),
  slot(
    "sheet-pan-chicken-shawarma",
    "Sheet pan chicken shawarma with red onion and peppers, served over rice with cucumber",
    "middle eastern",
    "chicken",
    ["sheet_pan"],
    ["leftovers"],
    [GF, DF],
    35,
    true,
  ),
  slot(
    "turkey-meatballs-with-marinara",
    "Baked turkey meatballs with marinara over spaghetti",
    "italian",
    "turkey",
    ["bake"],
    ["kid_friendly", "freezer_friendly"],
    [],
    35,
  ),
  slot(
    "tofu-vegetable-coconut-curry",
    "Tofu and vegetable curry with coconut milk, sweet potato, and spinach",
    "indian",
    "tofu",
    ["one_pot"],
    ["leftovers"],
    [VG, GF, DF],
    35,
    true,
  ),
  slot(
    "mediterranean-chickpea-salad-bowls",
    "Chickpea salad bowls with cucumber, tomato, olives, and red onion in a lemon dressing",
    "greek",
    "beans",
    ["no_cook"],
    ["pantry"],
    [VG, GF, DF],
    15,
    true,
  ),
  slot(
    "pressure-cooker-pork-carnitas",
    "Pork carnitas made in an electric pressure cooker, served in corn tortillas",
    "mexican",
    "pork",
    ["pressure_cooker"],
    ["freezer_friendly", "leftovers"],
    [GF, DF],
    80,
    true,
  ),
  slot(
    "chicken-souvlaki-rice-bowls",
    "Chicken souvlaki rice bowls with cucumber tomato salad and a lemon oregano dressing",
    "greek",
    "chicken",
    ["grill"],
    [],
    [GF, DF],
    35,
    true,
  ),
  slot(
    "turkey-sweet-potato-skillet",
    "Ground turkey and sweet potato skillet with kale and cumin",
    "american",
    "turkey",
    ["skillet"],
    ["leftovers"],
    [GF, DF],
    30,
    true,
  ),
  slot(
    "spinach-ricotta-stuffed-shells",
    "Spinach and ricotta stuffed pasta shells baked in marinara",
    "italian",
    "cheese",
    ["bake"],
    ["kid_friendly", "freezer_friendly"],
    [],
    60,
  ),
  slot(
    "baked-teriyaki-tofu-bowls",
    "Baked teriyaki tofu bowls with broccoli and rice",
    "japanese",
    "tofu",
    ["bake"],
    ["kid_friendly"],
    [VG, DF],
    35,
  ),
  slot(
    "red-beans-and-rice",
    "Red beans and rice with bell pepper, celery, and smoked paprika",
    "cajun",
    "beans",
    ["one_pot"],
    ["pantry", "leftovers"],
    [VG, GF, DF],
    50,
    true,
  ),
  slot(
    "mustard-roasted-pork-tenderloin",
    "Dijon roasted pork tenderloin with sweet potatoes and broccoli on a sheet pan",
    "french",
    "pork",
    ["sheet_pan"],
    [],
    [GF, DF],
    45,
    true,
  ),
  slot(
    "margherita-flatbread-pizzas",
    "Margherita flatbread pizzas with fresh mozzarella and basil",
    "italian",
    "cheese",
    ["bake"],
    ["kid_friendly"],
    [],
    25,
  ),
  slot(
    "stuffed-bell-peppers-with-rice",
    "Bell peppers stuffed with rice, tomatoes, and zucchini",
    "mediterranean",
    "vegetables",
    ["bake"],
    [],
    [VG, GF, DF],
    65,
    true,
  ),
  slot(
    "loaded-sweet-potatoes-with-black-beans",
    "Baked sweet potatoes stuffed with black beans, corn, and avocado",
    "american",
    "beans",
    ["bake"],
    ["kid_friendly"],
    [VG, GF, DF],
    55,
    true,
  ),
  slot(
    "chicken-tortilla-soup",
    "Chicken tortilla soup with black beans and corn, topped with crisp corn tortilla strips and avocado, no cheese",
    "mexican",
    "chicken",
    ["one_pot"],
    ["leftovers", "freezer_friendly"],
    [GF, DF],
    35,
    true,
  ),
  slot(
    "roasted-vegetable-quinoa-bowls",
    "Roasted vegetable quinoa bowls with a lemon and olive oil dressing",
    "mediterranean",
    "vegetables",
    ["sheet_pan"],
    ["leftovers"],
    [VG, GF, DF],
    35,
    true,
  ),
  slot(
    "lentil-sloppy-joes",
    "Lentil sloppy joes on buns with a tomato sauce",
    "american",
    "lentils",
    ["skillet"],
    ["kid_friendly"],
    [],
    30,
  ),
  slot(
    "black-bean-quesadillas",
    "Black bean and cheese quesadillas with salsa",
    "mexican",
    "beans",
    ["skillet"],
    ["kid_friendly", "pantry"],
    [],
    20,
  ),
];
