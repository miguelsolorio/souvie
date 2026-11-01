// The line-item golden set (WS15, docs/03-ai-design.md §10, risks R1 and R13): 100 grocery list
// lines, each with the product a shopper would expect at the store, checked against MockRetailer's
// fictional catalog (224 products, packages/retailers/src/mock/fixtures/products.json).
//
// The expectations were written from the catalog, not from what the matcher returned. A case passes
// when the matcher's pick is the first name or one of the few alternatives listed after it. An
// alternative is listed only where two products are the same thing to a cook (a 12 ct and an 18 ct
// carton of large eggs, a gala and a honeycrisp apple); a closer or cheaper pack is not one.
// Cases that expect nothing (`none`) are the wrong-product tests: an allergen the household has, a
// qualifier no product carries, and food the store does not sell. For those, picking any product is
// the failure.
//
// Names are checked against the catalog when this file loads (cases.test.ts), so a renamed fixture
// fails loudly instead of quietly passing.
import type { Allergen } from "@mp/core";

export interface Extra {
  /** Grams in one item, for a count line sold by weight ("6 bananas" against "1 lb"). */
  weightG?: number;
  /** Qualifiers the list carries ("gluten-free"): the product must say so too. */
  qualifiers?: string[];
  /** The household's allergies for this line. */
  allergies?: Allergen[];
  /** The recipe lines behind the amount, which carry a can's size. */
  rawTexts?: string[];
  /** Nothing should be picked: the line is unsafe, unqualified, or not sold here. */
  none?: true;
  /** A free-text line with no ontology match: the planner flags it and the model decides. */
  freeText?: true;
}

export type Row = [
  display: string,
  qty: number,
  unit: string,
  food: string,
  category: string,
  expect: string[],
  extra?: Extra,
];

const EGGS = [
  "Cedar Valley Farms Large Eggs",
  "Northfork Creamery Large Eggs",
  "Mock Market Cage Free Brown Eggs",
];

/**
 * Produce, dairy and eggs, meat and seafood, pantry, and frozen lines, then ten safety and gap
 * cases at the end. Exactly 100.
 *
 * One case is known to fail and stays in on purpose: "Apples" (li-002). The mock catalog's search
 * stems "apples" to "appl" and "apple" to "apple", so searching the ontology name "apple" finds the
 * apple cider vinegar and not the apples. The matcher is not at fault, and a real store's search is
 * fuzzier, but the case records what the mock does.
 */
export const ROWS: readonly Row[] = [
  // Produce
  ["Bananas", 6, "each", "banana", "produce", ["Harbor Fields Bananas"], { weightG: 118 }],
  [
    "Apples",
    4,
    "each",
    "apple",
    "produce",
    ["Cedar Valley Farms Gala Apples", "Honeycrisp Apples"],
    { weightG: 180 },
  ],
  [
    "Yellow onions",
    3,
    "each",
    "yellow onion",
    "produce",
    ["Harbor Fields Yellow Onions"],
    { weightG: 150 },
  ],
  ["Garlic", 1, "head", "garlic", "produce", ["Garlic"]],
  ["Russet potatoes", 3, "lb", "russet potato", "produce", ["Harbor Fields Russet Potatoes"]],
  ["Sweet potatoes", 2, "lb", "sweet potato", "produce", ["Cedar Valley Farms Sweet Potatoes"]],
  ["Carrots", 2, "lb", "carrot", "produce", ["Carrots"]],
  ["Roma tomatoes", 2, "lb", "roma tomato", "produce", ["Cedar Valley Farms Roma Tomatoes"]],
  ["Cherry tomatoes", 10, "oz", "cherry tomato", "produce", ["Cherry Tomatoes"]],
  [
    "Green bell pepper",
    2,
    "each",
    "green bell pepper",
    "produce",
    ["Harbor Fields Green Bell Pepper"],
    { weightG: 160 },
  ],
  ["Jalapeno peppers", 0.5, "lb", "jalapeno", "produce", ["Jalapeno Peppers"]],
  ["Broccoli", 1, "lb", "broccoli", "produce", ["Harbor Fields Broccoli Crowns"]],
  ["Baby spinach", 5, "oz", "baby spinach", "produce", ["Baby Spinach"]],
  ["Cucumber", 2, "each", "cucumber", "produce", ["English Cucumber"]],
  ["Zucchini", 1.5, "lb", "zucchini", "produce", ["Harbor Fields Zucchini"]],
  ["Lemons", 3, "each", "lemon", "produce", ["Lemons"], { weightG: 58 }],
  [
    "Avocados",
    3,
    "each",
    "avocado",
    "produce",
    ["Cedar Valley Farms Avocados", "Hass Avocados"],
    { weightG: 170 },
  ],
  ["Cilantro", 1, "bunch", "cilantro", "produce", ["Harbor Fields Cilantro"]],
  ["Fresh ginger", 3, "oz", "ginger", "produce", ["Cedar Valley Farms Ginger Root"]],
  [
    "Mushrooms",
    8,
    "oz",
    "mushroom",
    "produce",
    ["White Mushrooms", "Harbor Fields Cremini Mushrooms"],
  ],
  ["Green beans", 1, "lb", "green bean", "produce", ["Cedar Valley Farms Green Beans"]],

  // Dairy and eggs
  ["Whole milk", 1, "gallon", "whole milk", "dairy", ["Northfork Creamery Whole Milk"]],
  ["2% milk", 1, "gallon", "2% milk", "dairy", ["Mock Market 2% Reduced Fat Milk"]],
  ["Oat milk", 8, "cup", "oat milk", "dairy", ["Northfork Creamery Oat Milk"]],
  [
    "Unsweetened almond milk",
    4,
    "cup",
    "unsweetened almond milk",
    "dairy",
    ["Cedar Valley Farms Unsweetened Almond Milk"],
  ],
  ["Heavy cream", 1, "cup", "heavy cream", "dairy", ["Mock Market Heavy Whipping Cream"]],
  ["Unsalted butter", 8, "oz", "unsalted butter", "dairy", ["Northfork Creamery Unsalted Butter"]],
  ["Large eggs", 12, "each", "egg", "eggs", EGGS, { weightG: 50 }],
  [
    "Sharp cheddar",
    8,
    "oz",
    "cheddar cheese",
    "dairy",
    ["Cedar Valley Farms Sharp Cheddar Cheese"],
  ],
  [
    "Shredded mozzarella",
    8,
    "oz",
    "mozzarella",
    "dairy",
    ["Northfork Creamery Shredded Mozzarella"],
  ],
  ["Parmesan", 4, "oz", "parmesan", "dairy", ["Cedar Valley Farms Grated Parmesan"]],
  ["Feta", 6, "oz", "feta", "dairy", ["Mock Market Feta Crumbles"]],
  ["Sour cream", 16, "oz", "sour cream", "dairy", ["Northfork Creamery Sour Cream"]],
  ["Plain Greek yogurt", 32, "oz", "greek yogurt", "dairy", ["Mock Market Plain Greek Yogurt"]],
  ["Buttermilk", 1, "cup", "buttermilk", "dairy", ["Northfork Creamery Buttermilk"]],

  // Meat and seafood
  [
    "Boneless skinless chicken breasts",
    2,
    "lb",
    "chicken breast",
    "meat",
    ["Puget Butcher Co. Boneless Skinless Chicken Breasts"],
  ],
  [
    "Boneless skinless chicken thighs",
    1.5,
    "lb",
    "chicken thigh",
    "meat",
    ["Mock Market Boneless Skinless Chicken Thighs"],
  ],
  [
    "Bone-in chicken thighs",
    2,
    "lb",
    "chicken thigh",
    "meat",
    ["Harbor Fields Bone-In Chicken Thighs"],
  ],
  [
    "Chicken drumsticks",
    2,
    "lb",
    "chicken drumstick",
    "meat",
    ["Puget Butcher Co. Chicken Drumsticks"],
  ],
  ["Chicken wings", 2, "lb", "chicken wing", "meat", ["Harbor Fields Chicken Wings"]],
  ["Ground chicken", 1, "lb", "ground chicken", "meat", ["Puget Butcher Co. Ground Chicken"]],
  ["Ground turkey", 1, "lb", "ground turkey", "meat", ["Mock Market Ground Turkey 93% Lean"]],
  [
    "Ground beef",
    1,
    "lb",
    "ground beef",
    "meat",
    ["Harbor Fields 80% Lean Ground Beef", "Puget Butcher Co. 93% Lean Ground Beef"],
  ],
  ["Beef chuck roast", 3, "lb", "beef chuck roast", "meat", ["Mock Market Beef Chuck Roast"]],
  ["Beef stew meat", 1.5, "lb", "beef stew meat", "meat", ["Harbor Fields Beef Stew Meat"]],
  ["Flank steak", 1.5, "lb", "flank steak", "meat", ["Puget Butcher Co. Flank Steak"]],
  ["Ribeye steak", 1.5, "lb", "ribeye steak", "meat", ["Mock Market Ribeye Steak"]],
  ["Pork tenderloin", 1.5, "lb", "pork tenderloin", "meat", ["Puget Butcher Co. Pork Tenderloin"]],
  ["Boneless pork chops", 2, "lb", "pork chop", "meat", ["Mock Market Boneless Pork Chops"]],
  ["Bacon", 16, "oz", "bacon", "meat", ["Mock Market Thick Cut Bacon"]],
  [
    "Salmon fillet",
    1.5,
    "lb",
    "salmon fillet",
    "seafood",
    ["Puget Butcher Co. Atlantic Salmon Fillet", "Mock Market Sockeye Salmon Fillet"],
  ],
  ["Cod fillet", 1, "lb", "cod fillet", "seafood", ["Harbor Fields Cod Fillet"]],
  ["Raw shrimp", 1, "lb", "raw shrimp", "seafood", ["Mock Market Raw Shrimp 31-40 ct"]],

  // Pantry
  [
    "All-purpose flour",
    2.5,
    "lb",
    "all purpose flour",
    "baking",
    ["Mock Market All Purpose Flour"],
  ],
  ["Granulated sugar", 2, "lb", "granulated sugar", "baking", ["Puget Pantry Granulated Sugar"]],
  [
    "Light brown sugar",
    1,
    "lb",
    "light brown sugar",
    "baking",
    ["Larkspur Kitchen Light Brown Sugar"],
  ],
  ["Baking soda", 1, "each", "baking soda", "baking", ["Mock Market Baking Soda"]],
  ["Baking powder", 1, "each", "baking powder", "baking", ["Puget Pantry Baking Powder"]],
  ["Kosher salt", 1, "each", "kosher salt", "spices", ["Larkspur Kitchen Kosher Salt"]],
  ["Black pepper", 1, "each", "black pepper", "spices", ["Mock Market Ground Black Pepper"]],
  [
    "Extra virgin olive oil",
    16.9,
    "fl_oz",
    "extra virgin olive oil",
    "pantry",
    ["Puget Pantry Extra Virgin Olive Oil"],
  ],
  ["Canola oil", 48, "fl_oz", "canola oil", "pantry", ["Larkspur Kitchen Canola Oil"]],
  [
    "Apple cider vinegar",
    16,
    "fl_oz",
    "apple cider vinegar",
    "pantry",
    ["Puget Pantry Apple Cider Vinegar"],
  ],
  [
    "Balsamic vinegar",
    8,
    "fl_oz",
    "balsamic vinegar",
    "pantry",
    ["Larkspur Kitchen Balsamic Vinegar"],
  ],
  ["Soy sauce", 8, "fl_oz", "soy sauce", "international", ["Mock Market Low Sodium Soy Sauce"]],
  [
    "Long grain white rice",
    2,
    "lb",
    "long grain white rice",
    "pantry",
    ["Puget Pantry Long Grain White Rice"],
  ],
  ["Jasmine rice", 2, "lb", "jasmine rice", "pantry", ["Larkspur Kitchen Jasmine Rice"]],
  ["Brown rice", 1, "lb", "brown rice", "pantry", ["Mock Market Brown Rice"]],
  ["Quinoa", 8, "oz", "quinoa", "pantry", ["Puget Pantry Quinoa"]],
  ["Spaghetti", 16, "oz", "spaghetti", "pantry", ["Larkspur Kitchen Spaghetti"]],
  ["Penne", 16, "oz", "penne", "pantry", ["Mock Market Penne Rigate"]],
  ["Elbow macaroni", 16, "oz", "elbow macaroni", "pantry", ["Puget Pantry Elbow Macaroni"]],
  ["Marinara sauce", 24, "oz", "marinara sauce", "canned", ["Mock Market Marinara Sauce"]],
  [
    "Diced tomatoes",
    2,
    "can",
    "diced tomatoes",
    "canned",
    ["Puget Pantry Diced Tomatoes"],
    { rawTexts: ["2 (14.5 oz) cans diced tomatoes"] },
  ],
  [
    "Crushed tomatoes",
    1,
    "can",
    "crushed tomatoes",
    "canned",
    ["Larkspur Kitchen Crushed Tomatoes"],
    { rawTexts: ["1 (28 oz) can crushed tomatoes"] },
  ],
  ["Tomato paste", 6, "oz", "tomato paste", "canned", ["Mock Market Tomato Paste"]],
  [
    "Chicken broth",
    4,
    "cup",
    "chicken broth",
    "pantry",
    ["Puget Pantry Chicken Broth", "Larkspur Kitchen Low Sodium Chicken Broth"],
  ],
  ["Vegetable broth", 4, "cup", "vegetable broth", "pantry", ["Mock Market Vegetable Broth"]],
  [
    "Black beans",
    1,
    "can",
    "black beans",
    "canned",
    ["Puget Pantry Black Beans"],
    { rawTexts: ["1 (15 oz) can black beans"] },
  ],
  ["Coconut milk", 13.5, "fl_oz", "coconut milk", "canned", ["Puget Pantry Coconut Milk"]],
  ["Peanut butter", 16, "oz", "peanut butter", "pantry", ["Larkspur Kitchen Creamy Peanut Butter"]],
  ["Honey", 12, "oz", "honey", "pantry", ["Puget Pantry Honey"]],
  ["Rolled oats", 42, "oz", "rolled oats", "pantry", ["Mock Market Old Fashioned Oats"]],
  ["Flour tortillas", 10, "each", "flour tortilla", "bakery", ["Mock Market Flour Tortillas"]],
  ["Ground cumin", 2, "oz", "ground cumin", "spices", ["Mock Market Ground Cumin"]],

  // Frozen
  ["Frozen peas", 12, "oz", "frozen peas", "frozen", ["Glacier Table Frozen Peas"]],
  ["Frozen corn", 12, "oz", "frozen corn", "frozen", ["Mock Market Frozen Corn"]],
  ["Frozen spinach", 12, "oz", "frozen spinach", "frozen", ["Mock Market Frozen Spinach"]],
  [
    "Frozen mixed vegetables",
    16,
    "oz",
    "frozen mixed vegetables",
    "frozen",
    ["Glacier Table Frozen Mixed Vegetables"],
  ],
  [
    "Vanilla ice cream",
    48,
    "fl_oz",
    "vanilla ice cream",
    "frozen",
    ["Puget Pantry Vanilla Ice Cream"],
  ],

  // Safety and gaps (R1, R4, R13): the right answer is a product the household can eat, or nothing
  ["Unsalted butter", 8, "oz", "unsalted butter", "dairy", [], { allergies: ["milk"], none: true }],
  ["Peanut butter", 16, "oz", "peanut butter", "pantry", [], { allergies: ["peanut"], none: true }],
  [
    "Oat milk",
    8,
    "cup",
    "oat milk",
    "dairy",
    ["Northfork Creamery Oat Milk"],
    { allergies: ["milk"] },
  ],
  ["Raw shrimp", 1, "lb", "raw shrimp", "seafood", [], { allergies: ["shellfish"], none: true }],
  ["Soy sauce", 8, "fl_oz", "soy sauce", "international", [], { allergies: ["soy"], none: true }],
  [
    "Penne (gluten-free)",
    16,
    "oz",
    "penne",
    "pantry",
    [],
    { qualifiers: ["gluten-free"], none: true },
  ],
  [
    "Low sodium chicken broth",
    4,
    "cup",
    "chicken broth",
    "pantry",
    ["Larkspur Kitchen Low Sodium Chicken Broth"],
    { qualifiers: ["low-sodium"] },
  ],
  ["Saffron threads", 1, "each", "saffron", "spices", [], { none: true }],
  ["Fresh lemongrass", 2, "each", "lemongrass", "produce", [], { none: true }],
  [
    "vanilla ice cream for dessert",
    1,
    "each",
    "",
    "frozen",
    ["Puget Pantry Vanilla Ice Cream"],
    { freeText: true },
  ],
];
