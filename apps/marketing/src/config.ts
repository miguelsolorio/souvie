// Site-wide copy that more than one component needs. The name is chosen (Souvie, said
// "SOO-vee", human checkpoint 6, docs/08-brand.md §1). To change it, edit it here, in the two
// logo SVGs, and in src/assets/og.svg. See README.md.

export const site = {
  // Every place the page says the name reads it from here.
  name: "Souvie",
  headline: "Dinner, decided. Groceries, done.",
  description:
    "Souvie plans your household's week, builds one grocery list, and fills your carts on a schedule you pick. You review them and tap pay. Starting in Washington.",
  // Absolute URLs need MARKETING_SITE_URL at build time; see astro.config.mjs.
  ogImagePath: "/og.png",
} as const;

/** Stores named on the page, as text. No logos anywhere (Kroger brand rules). */
export const stores = ["QFC", "Fred Meyer", "Safeway", "Albertsons", "Costco"] as const;
