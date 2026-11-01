// Just dinners mode changes what the planner draws, not what the plan holds. "Generate list" reads
// every entry of the week whatever its slot (the list-build function selects by plan and
// household, not by slot), so a lunch left over from Every meal mode, or added by a housemate
// before the switch, is still on the list. This builds a simple-mode week with a stray lunch
// through the same buildList the function runs, and shows the planner reaches that lunch too.
import {
  buildList,
  groupEntries,
  type Ingredient,
  type ListEntry,
  type ListIngredientLine,
  type ListRecipe,
  type MealPlanEntry,
} from "@mp/core";
import { describe, expect, it } from "vitest";
import { moreMealsOf } from "./mode";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const ingredient = (n: number, name: string, category: Ingredient["category"]): Ingredient => ({
  id: id(n),
  name,
  plural: null,
  category,
  defaultUnit: "each",
  densityGPerMl: null,
  typicalUnitWeightG: null,
  usdaFdcId: null,
  isStapleDefault: false,
});

const LEMON = ingredient(1, "lemon", "produce");
const CHICKEN = ingredient(2, "chicken thigh", "meat");
const BREAD = ingredient(3, "sourdough bread", "bakery");
const SOUP = ingredient(4, "tomato soup", "canned");

const line = (n: number, ing: Ingredient, qty: number, unit: string): ListIngredientLine => ({
  id: id(100 + n),
  position: 0,
  raw_text: `${qty} ${unit} ${ing.name}`,
  qty,
  unit,
  ingredient_id: ing.id,
  prep_note: null,
  optional: false,
});

const recipe = (n: number, title: string, lines: ListIngredientLine[]): ListRecipe => ({
  id: id(200 + n),
  title,
  servings: 4,
  deleted_at: null,
  ingredients: lines,
});

const SHEET_PAN = recipe(1, "Sheet-pan lemon chicken", [
  line(1, CHICKEN, 2, "lb"),
  line(2, LEMON, 2, "each"),
]);
const TOMATO_SOUP = recipe(2, "Tomato soup and toast", [
  line(3, SOUP, 1, "each"),
  line(4, BREAD, 1, "each"),
]);

const entry = (n: number, date: string, slot: ListEntry["slot"], r: ListRecipe): ListEntry => ({
  id: id(300 + n),
  recipe_id: r.id,
  servings: 4,
  status: "planned",
  date,
  slot,
  position: 0,
});

const DINNERS = [
  entry(1, "2026-11-02", "dinner", SHEET_PAN),
  entry(2, "2026-11-04", "dinner", SHEET_PAN),
];
// The stray: a lunch on Tuesday, in a week a Just dinners household is planning.
const STRAY_LUNCH = entry(3, "2026-11-03", "lunch", TOMATO_SOUP);

const ingredients = new Map([LEMON, CHICKEN, BREAD, SOUP].map((ing) => [ing.id, ing]));

function listFor(entries: ListEntry[]) {
  return buildList({ entries, recipes: [SHEET_PAN, TOMATO_SOUP], ingredients, pantry: [] });
}

const names = (draft: ReturnType<typeof listFor>) => draft.items.map((item) => item.displayName);

describe("a Just dinners week with a stray lunch", () => {
  it("builds a list with the dinners' items and the lunch's items", () => {
    const draft = listFor([...DINNERS, STRAY_LUNCH]);
    expect(names(draft)).toEqual(
      expect.arrayContaining(["Chicken thigh", "Lemon", "Tomato soup", "Sourdough bread"]),
    );
    expect(draft.skippedEntries).toEqual([]);
  });

  it("credits the lunch entry for its items", () => {
    const draft = listFor([...DINNERS, STRAY_LUNCH]);
    const soup = draft.items.find((item) => item.displayName === "Tomato soup");
    expect(soup?.sourceEntryIds).toEqual([STRAY_LUNCH.id]);
    // The dinners are unchanged: both Monday's and Wednesday's chicken, one item.
    const chicken = draft.items.find((item) => item.displayName === "Chicken thigh");
    expect(chicken?.sourceEntryIds).toEqual([DINNERS[0]?.id, DINNERS[1]?.id]);
  });

  it("does not need the lunch to be in a slot the mode draws", () => {
    // Same list whichever slot the extra meal sits in: only what is planned matters.
    const withoutLunch = names(listFor(DINNERS));
    for (const slot of ["breakfast", "lunch", "snack"] as const) {
      const stray = { ...STRAY_LUNCH, slot };
      const withStray = names(listFor([...DINNERS, stray]));
      expect(withStray).toEqual(expect.arrayContaining(["Tomato soup", "Sourdough bread"]));
      expect(withoutLunch).not.toContain("Tomato soup");
    }
  });

  it("is a bigger list than the dinners alone, so the lunch is not dropped", () => {
    expect(listFor([...DINNERS, STRAY_LUNCH]).items.length).toBe(listFor(DINNERS).items.length + 2);
  });

  it("is the same lunch the planner keeps under More meals for that day", () => {
    const asPlanned = [...DINNERS, STRAY_LUNCH].map((e) => ({
      ...e,
      plan_id: id(900),
      household_id: id(901),
      recipe_id: e.recipe_id,
      notes: null,
      created_at: "2026-10-31T12:00:00.000+00:00",
      updated_at: "2026-10-31T12:00:00.000+00:00",
      why: null,
    })) satisfies MealPlanEntry[];
    const week = groupEntries(asPlanned);

    expect(moreMealsOf(week["2026-11-03"], "simple").map((e) => e.id)).toEqual([STRAY_LUNCH.id]);
    // The dinner days have nothing extra, and Every meal mode draws the lunch in its own slot.
    expect(moreMealsOf(week["2026-11-02"], "simple")).toEqual([]);
    expect(moreMealsOf(week["2026-11-03"], "full")).toEqual([]);
  });
});
