// Site-wide copy that more than one component needs. Change the name here (and in the two
// logo SVGs) when the name is chosen at human checkpoint 6. docs/08-brand.md §1.

export const site = {
  // Working name until checkpoint 6. Every place the page says the name reads it from here.
  name: "Meal Planner",
  headline: "Dinner, decided. Groceries, done.",
  description:
    "Meal Planner plans your household's week, builds one grocery list, and fills your carts on a schedule you pick. You review them and tap pay. Starting in Washington.",
  // Absolute URLs need MARKETING_SITE_URL at build time; see astro.config.mjs.
  ogImagePath: "/og.png",
} as const;

/** Stores named on the page, as text. No logos anywhere (Kroger and Instacart brand rules). */
export const stores = ["QFC", "Fred Meyer", "Safeway", "Albertsons", "Costco"] as const;
