// The household the browser tests sign in as: one owner, one planned week, one grocery list, one
// shopping run waiting for review. All invented. The clock is fixed to Wednesday 4 November 2026
// (support/app.ts), so "this week" is Monday 2 November to Sunday 8 November.

import type { FakeRow } from "../support/fakeSupabase";

export const NOW = new Date("2026-11-04T17:00:00.000Z");
export const WEEK_START = "2026-11-02";
export const WEEK_DAYS = [
  "2026-11-02",
  "2026-11-03",
  "2026-11-04",
  "2026-11-05",
  "2026-11-06",
  "2026-11-07",
  "2026-11-08",
] as const;

const STAMP = "2026-10-30T12:00:00.000Z";

export const IDS = {
  user: "11111111-1111-4111-8111-111111111111",
  household: "22222222-2222-4222-8222-222222222222",
  plan: "33333333-3333-4333-8333-333333333333",
  list: "44444444-4444-4444-8444-444444444444",
  run: "55555555-5555-4555-8555-555555555555",
} as const;

const uuid = (prefix: string, n: number) =>
  `${prefix}${String(n).padStart(7, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;

export const USER = {
  id: IDS.user,
  email: "cook@example.test",
} as const;

export const HOUSEHOLD: FakeRow = {
  id: IDS.household,
  name: "The Test Kitchen",
  zip: "98019",
  default_connection_id: null,
  created_by: IDS.user,
  created_at: STAMP,
  updated_at: STAMP,
  deleted_at: null,
  plan_mode: "full",
};

export const RECIPES = [
  { n: 1, title: "Lemon chicken with rice" },
  { n: 2, title: "Veggie chili" },
  { n: 3, title: "Tomato soup" },
  { n: 4, title: "Pasta primavera" },
  { n: 5, title: "Fish tacos" },
].map(({ n, title }) => ({
  id: uuid("a", n),
  title,
  image_url: null,
  servings: 4,
  prep_min: 15,
  cook_min: 30,
  deleted_at: null,
}));

function entry(n: number, date: string, slot: string, recipeIndex: number): FakeRow {
  return {
    id: uuid("e", n),
    plan_id: IDS.plan,
    household_id: IDS.household,
    date,
    slot,
    recipe_id: RECIPES[recipeIndex]?.id,
    servings: 4,
    status: "planned",
    notes: null,
    position: 0,
    created_at: `2026-10-30T12:00:0${n}.000Z`,
    updated_at: STAMP,
    why: null,
    recipes: RECIPES[recipeIndex],
  };
}

/** Five meals over the week: Monday dinner, Tuesday dinner, Wednesday lunch, Thursday dinner, Friday dinner. */
export const ENTRIES: FakeRow[] = [
  entry(1, "2026-11-02", "dinner", 0),
  entry(2, "2026-11-03", "dinner", 1),
  entry(3, "2026-11-04", "lunch", 2),
  entry(4, "2026-11-05", "dinner", 3),
  entry(5, "2026-11-06", "dinner", 4),
];

export const entryId = (n: number) => uuid("e", n);

function item(
  n: number,
  section: string,
  name: string,
  qty: number | null,
  unit: string | null,
  extra: FakeRow = {},
): FakeRow {
  return {
    id: uuid("c", n),
    list_id: IDS.list,
    household_id: IDS.household,
    ingredient_id: null,
    display_name: name,
    qty,
    unit,
    source_entry_ids: [],
    section,
    checked: false,
    checked_by: null,
    checked_at: null,
    excluded_reason: null,
    needs_attention: false,
    is_manual: false,
    position: n,
    qualifiers: [],
    edited: false,
    detail: { contributions: [] },
    created_at: STAMP,
    updated_at: STAMP,
    ...extra,
  };
}

export const itemId = (n: number) => uuid("c", n);

export const LIST_ITEMS: FakeRow[] = [
  item(1, "produce", "Yellow onions", 3, null),
  item(2, "produce", "Lemons", 4, null),
  item(3, "produce", "Garlic", 2, "head"),
  item(4, "produce", "Roma tomatoes", 6, null, { checked: true }),
  item(5, "dairy", "Whole milk", 1, "gal"),
  item(6, "dairy", "Cheddar", 8, "oz"),
  item(7, "meat", "Chicken thighs", 2, "lb"),
  item(8, "meat", "Ground turkey", 1, "lb"),
  item(9, "pantry", "Long grain rice", 2, "cup"),
  item(10, "pantry", "Black beans", 2, "can"),
  item(11, "pantry", "Penne", 1, "lb"),
  item(12, "bakery", "Corn tortillas", 12, null),
  item(13, "pantry", "Olive oil", 1, "bottle", { excluded_reason: "pantry" }),
  item(14, "pantry", "Paprika", 1, "jar", { excluded_reason: "manual" }),
];

export const LIST: FakeRow = {
  id: IDS.list,
  household_id: IDS.household,
  plan_id: IDS.plan,
  name: "Groceries, Nov 2 to Nov 8",
  status: "active",
  built_at: STAMP,
  plan_version: 1,
  plan_fingerprint: null,
  section_order: null,
  created_at: STAMP,
  updated_at: STAMP,
  deleted_at: null,
};

export const PLAN: FakeRow = {
  id: IDS.plan,
  household_id: IDS.household,
  week_start: WEEK_START,
  created_at: STAMP,
  updated_at: STAMP,
};

export const PROFILE: FakeRow = {
  user_id: IDS.user,
  display_name: "Test Cook",
  avatar_url: null,
  preferences: {},
  // The last onboarding screen is done, so the gate lets the person into the app.
  onboarding_step: 8,
  costco_member: false,
  created_at: STAMP,
  updated_at: STAMP,
};

// --- a shopping run waiting for review ---------------------------------------------------------

function runLine(
  position: number,
  section: string,
  display: string,
  product: [string, string, number, number] | null,
  extra: FakeRow = {},
): FakeRow {
  const [name, size, price, qty] = product ?? ["", "", 0, 0];
  return {
    id: uuid("d", position),
    household_id: IDS.household,
    run_id: IDS.run,
    position,
    display_name: display,
    section,
    product_id: product ? `00990${position}` : null,
    upc: null,
    product_name: product ? name : null,
    size: product ? size : null,
    qty: product ? qty : null,
    unit_price_usd: product ? price : null,
    line_total_usd: product ? Math.round(price * qty * 100) / 100 : null,
    status: product ? "matched" : "unmatched",
    alternatives: null,
    user_decision: null,
    flags: [],
    reason: null,
    cart_qty: 0,
    delta_result: null,
    ...extra,
  };
}

export const RUN: FakeRow = {
  id: IDS.run,
  household_id: IDS.household,
  list_id: IDS.list,
  retailer: "kroger",
  store_name: "Mock QFC Duvall",
  trigger: "manual",
  status: "needs_review",
  cart_snapshot: {
    storeName: "Mock QFC Duvall",
    summary: "7 of 8 lines matched. One needs your pick.",
    itemCount: 8,
    matchedCount: 7,
    needsReviewCount: 1,
    subtotalUsd: 26.4,
    flags: [],
  },
  subtotal_usd: 26.4,
  transcript: [],
  error: null,
  progress: null,
  approved_at: null,
  policy: { budget_cap_usd: 150, per_item_ceiling_usd: 15 },
  started_at: STAMP,
  finished_at: null,
  created_at: STAMP,
};

export const RUN_ITEMS: FakeRow[] = [
  runLine(0, "produce", "Yellow onions", ["Harbor Fields Yellow Onions", "3 lb bag", 3.63, 1]),
  runLine(1, "produce", "Garlic", ["Garlic", "3 ct", 1.93, 1]),
  runLine(2, "meat", "Boneless skinless chicken thighs", [
    "Mock Market Boneless Skinless Chicken Thighs",
    "1 lb",
    3.42,
    2,
  ]),
  runLine(3, "dairy", "Whole milk", ["Northfork Creamery Whole Milk", "1 gal", 4.43, 1], {
    alternatives: [
      {
        product_id: "0099020000004",
        upc: null,
        name: "Northfork Creamery Organic Whole Milk",
        size: "1/2 gal",
        price: 5.16,
        qty: 2,
      },
    ],
  }),
  runLine(4, "pantry", "Chicken broth", ["Puget Pantry Chicken Broth", "32 fl oz", 2.26, 1]),
  runLine(5, "pantry", "Penne (gluten-free)", null, {
    flags: [
      {
        kind: "qualifier",
        detail: "No product here says gluten-free. Pick one yourself or leave it out.",
      },
    ],
    alternatives: [
      {
        product_id: "0099040000019",
        upc: null,
        name: "Mock Market Penne Rigate",
        size: "16 oz",
        price: 1.52,
        qty: 1,
      },
    ],
  }),
  runLine(6, "frozen", "Vanilla ice cream", [
    "Puget Pantry Vanilla Ice Cream",
    "48 fl oz",
    3.95,
    1,
  ]),
];
