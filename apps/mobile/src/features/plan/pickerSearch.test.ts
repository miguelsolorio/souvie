import type { RecipeSummary } from "@mp/db";
import { describe, expect, it } from "vitest";
import { byTitle, initialTab, pickerRecipes, recipeWithId, searchRecipes } from "./pickerSearch";

const recipe = (id: string, title: string, over: Partial<RecipeSummary> = {}): RecipeSummary => ({
  id,
  household_id: "h1",
  title,
  description: null,
  image_url: null,
  source_type: "manual",
  source_url: null,
  servings: 4,
  prep_min: 10,
  cook_min: 20,
  tags: [],
  cuisine: null,
  created_at: "2026-10-30T12:00:00.000Z",
  ...over,
});

const lemon = recipe("r1", "Lemon chicken", { cuisine: "Mediterranean", tags: ["weeknight"] });
const curry = recipe("r2", "Green curry", { cuisine: "Thai" });
const chili = recipe("r3", "Chicken chili", { source_url: "https://www.example.com/chili" });
const soup = recipe("r4", "Tomato soup");
const all = [lemon, curry, chili, soup];

describe("searchRecipes", () => {
  it("returns everything for an empty query", () => {
    expect(searchRecipes(all, "")).toEqual(all);
    expect(searchRecipes(all, "   ")).toEqual(all);
  });

  it("matches by title, ignoring case", () => {
    expect(searchRecipes(all, "CURRY").map((r) => r.id)).toEqual(["r2"]);
  });

  it("needs every word", () => {
    expect(searchRecipes(all, "chicken lemon").map((r) => r.id)).toEqual(["r1"]);
    expect(searchRecipes(all, "chicken soup")).toEqual([]);
  });

  it("puts titles that start with the word before titles that merely contain it", () => {
    expect(searchRecipes(all, "chicken").map((r) => r.id)).toEqual(["r3", "r1"]);
  });

  it("falls back to cuisine, tags, and source domain after the title matches", () => {
    expect(searchRecipes(all, "thai").map((r) => r.id)).toEqual(["r2"]);
    expect(searchRecipes(all, "weeknight").map((r) => r.id)).toEqual(["r1"]);
    expect(searchRecipes(all, "example.com").map((r) => r.id)).toEqual(["r3"]);
    // "mediterranean" is only in the cuisine; "chicken" in the title: still one hit.
    expect(searchRecipes(all, "chicken mediterranean").map((r) => r.id)).toEqual(["r1"]);
  });

  it("keeps the list's order between equal matches", () => {
    const a = recipe("a", "Rice bowl one");
    const b = recipe("b", "Rice bowl two");
    expect(searchRecipes([b, a], "rice").map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("pickerRecipes", () => {
  const base = { recipes: all, query: "", recentIds: ["r4", "r1", "gone"], favoriteIds: ["r2"] };

  it("shows recent recipes in the order they were planned, skipping ones that are gone", () => {
    expect(pickerRecipes({ ...base, tab: "recent" }).map((r) => r.id)).toEqual(["r4", "r1"]);
  });

  it("shows favorites", () => {
    expect(pickerRecipes({ ...base, tab: "favorites" }).map((r) => r.id)).toEqual(["r2"]);
  });

  it("shows all recipes A to Z", () => {
    expect(pickerRecipes({ ...base, tab: "all" }).map((r) => r.title)).toEqual([
      "Chicken chili",
      "Green curry",
      "Lemon chicken",
      "Tomato soup",
    ]);
    expect(byTitle([soup, lemon]).map((r) => r.id)).toEqual(["r1", "r4"]);
  });

  it("searches every recipe whatever the tab", () => {
    expect(pickerRecipes({ ...base, tab: "favorites", query: "soup" }).map((r) => r.id)).toEqual([
      "r4",
    ]);
  });

  describe("a recipe the person just added", () => {
    const fresh = recipe("r9", "Zucchini fritters");

    it("goes first under All and leaves the rest A to Z", () => {
      const ids = pickerRecipes({
        ...base,
        recipes: [...all, fresh],
        tab: "all",
        firstId: "r9",
      }).map((r) => r.id);
      expect(ids).toEqual(["r9", "r3", "r2", "r1", "r4"]);
    });

    it("is listed once, and A to Z again without it", () => {
      const withFresh = { ...base, recipes: [...all, fresh], tab: "all" as const };
      expect(
        pickerRecipes({ ...withFresh, firstId: "r9" }).filter((r) => r.id === "r9"),
      ).toHaveLength(1);
      expect(pickerRecipes({ ...withFresh, firstId: null }).map((r) => r.id)).toEqual([
        "r3",
        "r2",
        "r1",
        "r4",
        "r9",
      ]);
    });

    it("changes nothing for an id the list does not hold, or on the other tabs, or in a search", () => {
      const plain = pickerRecipes({ ...base, tab: "all" }).map((r) => r.id);
      expect(pickerRecipes({ ...base, tab: "all", firstId: "nope" }).map((r) => r.id)).toEqual(
        plain,
      );
      expect(pickerRecipes({ ...base, tab: "recent", firstId: "r2" }).map((r) => r.id)).toEqual([
        "r4",
        "r1",
      ]);
      expect(
        pickerRecipes({ ...base, tab: "all", query: "chicken", firstId: "r4" }).map((r) => r.id),
      ).toEqual(["r3", "r1"]);
    });
  });

  describe("catalog recipes", () => {
    // The starter catalog: household_id is null. The picker does not look at the owner, so
    // whatever useRecipes returns is listed, searchable and pickable.
    const catalog = recipe("c1", "Sheet-pan salmon", {
      household_id: null,
      source_type: "ai",
      tags: ["weeknight"],
    });
    const withCatalog = [...all, catalog];
    const args = { recipes: withCatalog, query: "", recentIds: [], favoriteIds: [] };

    it("are listed under All with the household's own", () => {
      expect(pickerRecipes({ ...args, tab: "all" }).map((r) => r.id)).toEqual([
        "r3",
        "r2",
        "r1",
        "c1",
        "r4",
      ]);
    });

    it("are found by search, and picked by id like any other recipe", () => {
      expect(pickerRecipes({ ...args, tab: "recent", query: "salmon" }).map((r) => r.id)).toEqual([
        "c1",
      ]);
      expect(recipeWithId(withCatalog, "c1")).toBe(catalog);
    });

    it("show under Recent once planned", () => {
      const recentIds = ["c1", "r2"];
      expect(pickerRecipes({ ...args, tab: "recent", recentIds }).map((r) => r.id)).toEqual([
        "c1",
        "r2",
      ]);
    });
  });
});

describe("initialTab", () => {
  it("opens on Recent when the household has planned something before", () => {
    expect(initialTab(["r4", "r1"])).toBe("recent");
  });

  it("opens on All when nothing was planned before", () => {
    expect(initialTab([])).toBe("all");
  });

  it("counts only recent recipes the list still holds", () => {
    expect(initialTab(["gone"], all)).toBe("all");
    expect(initialTab(["gone", "r2"], all)).toBe("recent");
    expect(initialTab(["r2"], [])).toBe("all");
    expect(initialTab([], all)).toBe("all");
  });
});

describe("recipeWithId", () => {
  it("finds a recipe by id", () => {
    expect(recipeWithId(all, "r3")).toBe(chili);
  });

  it("is null for no id, or one the list does not hold yet", () => {
    expect(recipeWithId(all, null)).toBeNull();
    expect(recipeWithId(all, undefined)).toBeNull();
    expect(recipeWithId(all, "")).toBeNull();
    expect(recipeWithId(all, "new")).toBeNull();
  });
});

describe("search speed (acceptance criterion 8)", () => {
  const WORDS = [
    "lemon",
    "garlic",
    "chicken",
    "beef",
    "pasta",
    "curry",
    "salad",
    "soup",
    "taco",
    "rice",
  ];
  const fixture = Array.from({ length: 200 }, (_, i) =>
    recipe(`id-${i}`, `${WORDS[i % 10]} ${WORDS[(i * 7) % 10]} number ${i}`, {
      cuisine: i % 3 === 0 ? "Italian" : "Thai",
      tags: ["weeknight", i % 2 ? "quick" : "slow"],
      source_url: i % 4 === 0 ? `https://site${i}.example.com/r` : null,
    }),
  );

  it("filters a 200 recipe fixture by title well inside 300 ms", () => {
    const timings: number[] = [];
    let hits = 0;
    for (const query of ["l", "le", "lem", "lemo", "lemon", "lemon chicken", "taco rice", "zzz"]) {
      const start = performance.now();
      const result = pickerRecipes({
        recipes: fixture,
        tab: "all",
        query,
        recentIds: [],
        favoriteIds: [],
      });
      timings.push(performance.now() - start);
      hits += result.length;
    }
    const slowest = Math.max(...timings);
    console.log(
      `picker search, 200 recipes: ${timings.length} queries, slowest ${slowest.toFixed(2)} ms, results ${hits}`,
    );
    expect(hits).toBeGreaterThan(0);
    expect(slowest).toBeLessThan(300);
  });
});
