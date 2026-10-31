import { describe, expect, it } from "vitest";
import { buildList, planFingerprint } from "./aggregate.ts";
import {
  type FixtureItem,
  type FixtureLine,
  inputOf,
  type ListFixture,
  runFixture,
} from "./fixtures/harness.ts";
import { FIXTURES } from "./fixtures/index.ts";
import { DEFAULT_SECTION_ORDER } from "./sections.ts";
import { ItemDetail, itemDetailOf } from "./types.ts";

/** Checks a draft against a fixture's expectations. Quantities compare to 4 decimals. */
function check(name: string, fixture: ListFixture) {
  const { draft, ids } = runFixture(fixture);
  const { expect: want } = fixture;

  if (want.items) {
    expect(
      draft.items.map((item) => item.displayName),
      `${name}: item names in order`,
    ).toEqual(want.items.map((item) => item.name));
    want.items.forEach((wanted: FixtureItem, index: number) => {
      const got = draft.items[index];
      const label = `${name}: ${wanted.name}`;
      expect(got, label).toBeDefined();
      if (!got) return;
      if (wanted.qty !== undefined) expect(got.qty, `${label} qty`).toBe(wanted.qty);
      if (wanted.unit !== undefined) expect(got.unit, `${label} unit`).toBe(wanted.unit);
      if (wanted.section !== undefined)
        expect(got.section, `${label} section`).toBe(wanted.section);
      if (wanted.excluded !== undefined) {
        expect(got.excludedReason ?? null, `${label} excluded`).toBe(wanted.excluded);
      }
      if (wanted.attention !== undefined) {
        expect(got.needsAttention, `${label} needs attention`).toBe(wanted.attention);
      }
      if (wanted.qualifiers)
        expect(got.qualifiers, `${label} qualifiers`).toEqual(wanted.qualifiers);
      if (wanted.entries) {
        expect(
          got.sourceEntryIds.map((id) => ids.keyOf(id).replace("entry:", "")),
          `${label} entries`,
        ).toEqual(wanted.entries);
      }
      if (wanted.contributions) {
        expect(
          got.contributions.map((c) => ({
            entry: ids.keyOf(c.entryId).replace("entry:", ""),
            qty: c.qty,
            ...(wanted.contributions?.some((w) => w.unit !== undefined) ? { unit: c.unit } : {}),
          })),
          `${label} contributions`,
        ).toEqual(
          wanted.contributions.map((w) => ({
            entry: w.entry,
            qty: w.qty,
            ...(wanted.contributions?.some((x) => x.unit !== undefined)
              ? { unit: w.unit ?? null }
              : {}),
          })),
        );
        wanted.contributions.forEach((w, i) => {
          if (w.servings !== undefined) {
            expect(got.contributions[i]?.servings, `${label} servings of ${w.entry}`).toBe(
              w.servings,
            );
          }
        });
      }
      if (wanted.rounding !== undefined) {
        if (wanted.rounding === null) expect(got.rounding, `${label} rounding`).toBeUndefined();
        else {
          expect(got.rounding, `${label} rounding`).toMatchObject({
            ...wanted.rounding,
          });
        }
      }
    });
  }
  if (want.needsAttentionCount !== undefined) {
    expect(draft.needsAttentionCount, `${name}: needsAttentionCount`).toBe(
      want.needsAttentionCount,
    );
  }
  if (want.skipped) {
    expect(
      draft.skippedEntries.map((s) => ({
        entry: ids.keyOf(s.entryId).replace("entry:", ""),
        reason: s.reason,
      })),
    ).toEqual(want.skipped);
  }
  return draft;
}

describe("buildList fixtures", () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    it(`${name}: ${fixture.description.split(". ")[0]}`, () => {
      check(name, fixture);
    });
  }
});

// The six cases of acceptance criterion 2, stated directly so a reader does not have to open a
// fixture to see what they promise.
describe("acceptance criterion 2", () => {
  it("two recipes each needing 1 cup diced onion make one item of 2 cups", () => {
    const { draft } = runFixture(FIXTURES["onion-two-recipes"] as ListFixture);
    expect(draft.items).toHaveLength(1);
    expect(draft.items[0]).toMatchObject({ displayName: "Yellow onion", qty: 2, unit: "cup" });
    expect(draft.items[0]?.contributions).toHaveLength(2);
  });

  it("scaling 4 servings to 6 scales quantities by 1.5", () => {
    const { draft } = runFixture(FIXTURES["scale-4-to-6"] as ListFixture);
    const carrot = draft.items.find((item) => item.displayName === "Carrot");
    expect(carrot?.qty).toBe(1.5);
    expect(carrot?.contributions[0]).toMatchObject({ servings: 6, recipeServings: 4, qty: 1.5 });
  });

  it("2 cloves garlic plus 1 head garlic is one item in heads, rounded up", () => {
    const { draft } = runFixture(FIXTURES["garlic-clove-and-head"] as ListFixture);
    expect(draft.items).toHaveLength(1);
    expect(draft.items[0]).toMatchObject({ displayName: "Garlic", qty: 2, unit: "head" });
    expect(draft.items[0]?.rounding).toMatchObject({ from: 12, to: 2, toUnit: "head" });
  });

  it("1 lb chicken thighs plus 8 oz chicken thighs is 1.5 lb", () => {
    const { draft } = runFixture(FIXTURES["chicken-lb-and-oz"] as ListFixture);
    expect(draft.items).toHaveLength(1);
    expect(draft.items[0]).toMatchObject({ displayName: "Chicken thigh", qty: 1.5, unit: "lb" });
  });

  it("a pantry have item is excluded with excludedReason pantry", () => {
    const { draft } = runFixture(FIXTURES["pantry-have"] as ListFixture);
    const breast = draft.items.find((item) => item.displayName === "Chicken breast");
    expect(breast?.excludedReason).toBe("pantry");
    expect(draft.items.filter((item) => item.excludedReason).length).toBeGreaterThan(1);
  });

  it("an unparsed line becomes a needsAttention item named by its raw text", () => {
    const { draft } = runFixture(FIXTURES["unparsed-line"] as ListFixture);
    const item = draft.items.find((i) => i.displayName === "1 handful frobnitz leaves");
    expect(item).toMatchObject({ needsAttention: true, ingredientId: null, section: "other" });
    expect(draft.needsAttentionCount).toBe(2);
  });

  it("items are grouped by section in the default order", () => {
    const { draft } = runFixture(FIXTURES["sections-default-order"] as ListFixture);
    const sections = draft.items.map((item) => item.section);
    expect(sections).toEqual([
      "produce",
      "bakery",
      "meat",
      "seafood",
      "dairy",
      "eggs",
      "pantry",
      "canned",
      "baking",
      "spices",
      "other",
    ]);
    const indexes = sections.map((s) => DEFAULT_SECTION_ORDER.indexOf(s as never));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });
});

describe("a week of five dinners (acceptance criterion 3)", () => {
  const fixture = FIXTURES["week-of-five-dinners"] as ListFixture;

  it("flags exactly the lines the parser left unplaced", () => {
    const unplaced = fixture.recipes.flatMap((r) => r.lines).filter((l) => l.ingredient === null);
    const { draft } = runFixture(fixture);
    expect(unplaced.length).toBeGreaterThan(0);
    expect(draft.needsAttentionCount).toBe(unplaced.length);
    expect(
      draft.items
        .filter((i) => i.needsAttention)
        .map((i) => i.displayName)
        .sort(),
    ).toEqual(unplaced.map((l) => l.text).sort());
  });

  it("builds in well under two seconds", () => {
    const input = inputOf(fixture);
    const started = Date.now();
    buildList(input);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("covers every placed ingredient exactly once and loses no entry", () => {
    const { draft } = runFixture(fixture);
    const keys = draft.items
      .filter((i) => i.ingredientId)
      .map((i) => `${i.ingredientId}|${i.qualifiers}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of fixture.entries) {
      expect(draft.items.some((i) => i.contributions.length > 0)).toBe(true);
      expect(entry.id).toBeTruthy();
    }
    expect(draft.skippedEntries).toEqual([]);
  });
});

describe("what a draft promises", () => {
  const fixtures = Object.entries(FIXTURES);

  it("is the same for the same input, and leaves the input alone", () => {
    for (const [, fixture] of fixtures) {
      const input = inputOf(fixture);
      const before = JSON.stringify(input, (_k, v) => (v instanceof Map ? [...v] : v));
      const first = buildList(input);
      const second = buildList(input);
      expect(second).toEqual(first);
      expect(JSON.stringify(input, (_k, v) => (v instanceof Map ? [...v] : v))).toBe(before);
    }
  });

  it("numbers positions 0..n-1 in item order", () => {
    for (const [, fixture] of fixtures) {
      const { draft } = runFixture(fixture);
      expect(draft.items.map((i) => i.position)).toEqual(draft.items.map((_, i) => i));
    }
  });

  it("writes a detail value the database schema accepts, with a uuid for every entry", () => {
    for (const [name, fixture] of fixtures) {
      const { draft } = runFixture(fixture);
      for (const item of draft.items) {
        const detail = ItemDetail.safeParse(itemDetailOf(item));
        expect(detail.success, `${name}: ${item.displayName}`).toBe(true);
      }
    }
  });

  it("never loses a line: every recipe line shows up in some item's contributions", () => {
    for (const [name, fixture] of fixtures) {
      const { draft } = runFixture(fixture);
      const skipped = new Set(
        fixture.entries.filter((e) => (e.status ?? "planned") === "skipped").map((e) => e.recipe),
      );
      const deleted = new Set(fixture.recipes.filter((r) => r.deleted).map((r) => r.id));
      const shown = new Set(draft.items.flatMap((i) => i.contributions.flatMap((c) => c.rawTexts)));
      for (const entry of fixture.entries) {
        const recipe = fixture.recipes.find((r) => r.id === entry.recipe);
        if (!recipe || skipped.has(recipe.id) || deleted.has(recipe.id)) continue;
        for (const line of recipe.lines) {
          expect(shown.has(line.text), `${name}: "${line.text}" is on the list`).toBe(true);
        }
      }
    }
  });
});

describe("options", () => {
  const fixture = FIXTURES["garlic-clove-and-head"] as ListFixture;

  it("roundUp false leaves the summed quantity in the working unit", () => {
    const input = inputOf({ ...fixture, options: { roundUp: false } });
    const draft = buildList(input);
    expect(draft.items[0]).toMatchObject({ qty: 12, unit: "clove" });
    expect(draft.items[0]?.rounding).toBeUndefined();
  });

  it("a household section order is honored and the rest follow the default", () => {
    const { draft } = runFixture(FIXTURES["sections-household-order"] as ListFixture);
    expect(draft.sectionOrder.slice(0, 4)).toEqual(["meat", "produce", "seafood", "bakery"]);
    expect(draft.sectionOrder).toHaveLength(16);
  });
});

describe("amounts", () => {
  const base = (lines: FixtureLine[]): ListFixture => ({
    description: "inline",
    recipes: [{ id: "r", title: "R", servings: 4, lines }],
    entries: [{ id: "e", recipe: "r", servings: 4 }],
    expect: {},
  });

  it("uses the upper bound of a range and keeps a unit it does not know as a separate flagged item", () => {
    const { draft } = runFixture(
      base([
        { text: "1-2 cups spinach", qty: 1, qtyMax: 2, unit: "cup", ingredient: "spinach" },
        { text: "2 knobs ginger", qty: 2, unit: "knob", ingredient: "ginger" },
        { text: "1 tbsp ginger", qty: 1, unit: "tbsp", ingredient: "ginger" },
      ]),
    );
    expect(draft.items.find((i) => i.displayName === "Spinach")?.qty).toBe(2);
    const ginger = draft.items.filter((i) => i.displayName === "Ginger");
    expect(ginger).toHaveLength(2);
    expect(ginger.every((i) => i.needsAttention)).toBe(true);
    expect(ginger.map((i) => i.attention).sort()).toEqual(["mixed_units", "unknown_unit"]);
    expect(ginger.find((i) => i.unit === "knob")?.qty).toBe(2);
  });

  it("treats a bare number as a count", () => {
    const { draft } = runFixture(
      base([{ text: "3 carrots", qty: 3, unit: null, ingredient: "carrot" }]),
    );
    expect(draft.items[0]).toMatchObject({ qty: 3, unit: "each" });
  });

  it("keeps size words from inflating a count: 2 large and 1 medium onion is 3", () => {
    const { draft } = runFixture(
      base([
        { text: "2 large onions", qty: 2, unit: "large", ingredient: "yellow onion" },
        { text: "1 medium onion", qty: 1, unit: "medium", ingredient: "yellow onion" },
      ]),
    );
    expect(draft.items).toHaveLength(1);
    expect(draft.items[0]).toMatchObject({ qty: 3, unit: "each", needsAttention: false });
  });

  it("an entry planned twice counts twice", () => {
    const fixture: ListFixture = {
      description: "inline",
      recipes: [
        {
          id: "r",
          title: "Tacos",
          servings: 4,
          lines: [{ text: "1 lb ground beef", qty: 1, unit: "lb", ingredient: "ground beef" }],
        },
      ],
      entries: [
        { id: "mon", recipe: "r", servings: 4 },
        { id: "thu", recipe: "r", servings: 4 },
      ],
      expect: {},
    };
    const { draft } = runFixture(fixture);
    expect(draft.items[0]).toMatchObject({ qty: 2, unit: "lb" });
    expect(draft.items[0]?.contributions).toHaveLength(2);
    expect(draft.items[0]?.sourceEntryIds).toHaveLength(2);
  });
});

describe("planFingerprint", () => {
  const entries = [
    { id: "b", recipe_id: "r2", servings: 4, status: "planned" },
    { id: "a", recipe_id: "r1", servings: 2, status: "planned" },
  ];

  it("is 64 hex characters and ignores the order of the entries", () => {
    const first = planFingerprint(entries);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(planFingerprint([...entries].reverse())).toBe(first);
  });

  it("changes when an entry is added, removed, swapped, rescaled, or marked", () => {
    const base = planFingerprint(entries);
    const [b, a] = entries as [(typeof entries)[0], (typeof entries)[0]];
    expect(
      planFingerprint([...entries, { id: "c", recipe_id: "r3", servings: 4, status: "planned" }]),
    ).not.toBe(base);
    expect(planFingerprint([a])).not.toBe(base);
    expect(planFingerprint([{ ...b, recipe_id: "r9" }, a])).not.toBe(base);
    expect(planFingerprint([{ ...b, servings: 5 }, a])).not.toBe(base);
    expect(planFingerprint([{ ...b, status: "skipped" }, a])).not.toBe(base);
  });

  it("agrees between the database's numeric text and a phone's number", () => {
    const fromDatabase = planFingerprint([
      { id: "a", recipe_id: "r1", servings: "4.0", status: "planned" },
      { id: "b", recipe_id: "r2", servings: "2.5", status: "cooked" },
    ]);
    const fromPhone = planFingerprint([
      { id: "b", recipe_id: "r2", servings: 2.5, status: "cooked" },
      { id: "a", recipe_id: "r1", servings: 4, status: "planned" },
    ]);
    expect(fromPhone).toBe(fromDatabase);
  });

  it("is a fixed value for a fixed plan, so a server and a phone cannot drift apart", () => {
    expect(
      planFingerprint([
        {
          id: "11111111-1111-4111-8111-111111111111",
          recipe_id: "22222222-2222-4222-8222-222222222222",
          servings: 4,
          status: "planned",
        },
      ]),
    ).toBe("e1e3d5fada7f0ef6cdb713b909010fca757b169b92b08d1576728dc308453a1a");
  });
});
