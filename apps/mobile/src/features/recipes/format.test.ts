import type { RecipeSummary } from "@mp/db";
import { describe, expect, it } from "vitest";
import {
  filterRecipes,
  formatMinutes,
  formatServings,
  groupIngredientLines,
  numberSteps,
  summaryLine,
  totalMinutes,
} from "./format";

const summary = (over: Partial<RecipeSummary> = {}): RecipeSummary => ({
  id: "r1",
  household_id: "h1",
  visibility: "household",
  title: "Lemon Chicken",
  description: null,
  image_url: null,
  source_type: "url",
  source_url: "https://www.seriouseats.com/lemon-chicken",
  servings: 4,
  prep_min: 10,
  cook_min: 35,
  tags: ["dinner", "chicken"],
  cuisine: "american",
  created_at: "2026-10-30T07:12:14.123456+00:00",
  ...over,
});

describe("formatting", () => {
  it("formats servings", () => {
    expect(formatServings(4)).toBe("4 servings");
    expect(formatServings(1)).toBe("1 serving");
    expect(formatServings(1.5)).toBe("1.5 servings");
    expect(formatServings(0)).toBeNull();
    expect(formatServings(null)).toBeNull();
  });

  it("formats minutes", () => {
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(60)).toBe("1 hr");
    expect(formatMinutes(75)).toBe("1 hr 15 min");
    expect(formatMinutes(0)).toBeNull();
    expect(formatMinutes(null)).toBeNull();
  });

  it("adds prep and cook", () => {
    expect(totalMinutes(10, 35)).toBe(45);
    expect(totalMinutes(null, 20)).toBe(20);
    expect(totalMinutes(null, null)).toBeNull();
  });

  it("builds the list line with the source domain", () => {
    expect(summaryLine(summary())).toBe("4 servings · 45 min · seriouseats.com");
    expect(
      summaryLine(summary({ servings: null, prep_min: null, cook_min: null, source_url: null })),
    ).toBe("");
  });
});

describe("filterRecipes", () => {
  const all = [
    summary({ id: "1", title: "Lemon Chicken" }),
    summary({ id: "2", title: "Beef Stew", tags: ["winter"], cuisine: "irish", source_url: null }),
    summary({
      id: "3",
      title: "Pancakes",
      tags: ["breakfast"],
      cuisine: null,
      source_url: "https://tasty.co/x",
    }),
  ];

  it("returns everything for an empty query", () => {
    expect(filterRecipes(all, "  ")).toHaveLength(3);
  });

  it("matches title, tag, cuisine, and source domain, needing every word", () => {
    expect(filterRecipes(all, "chicken").map((r) => r.id)).toEqual(["1"]);
    expect(filterRecipes(all, "WINTER").map((r) => r.id)).toEqual(["2"]);
    expect(filterRecipes(all, "irish stew").map((r) => r.id)).toEqual(["2"]);
    expect(filterRecipes(all, "tasty.co").map((r) => r.id)).toEqual(["3"]);
    expect(filterRecipes(all, "chicken stew")).toEqual([]);
  });
});

describe("groupIngredientLines", () => {
  it("splits lines into runs that share a heading, keeping order and a stable key", () => {
    const lines = [
      { id: "a", group_name: null },
      { id: "b", group_name: "Sauce" },
      { id: "c", group_name: "Sauce" },
      { id: "d", group_name: null },
      { id: "e", group_name: " " },
    ];
    const groups = groupIngredientLines(lines);
    expect(groups.map((g) => [g.key, g.name, g.lines.map((l) => l.id)])).toEqual([
      ["a", null, ["a"]],
      ["b", "Sauce", ["b", "c"]],
      ["d", null, ["d", "e"]],
    ]);
  });

  it("numbers steps from 1", () => {
    expect(numberSteps(["a", "b"])).toEqual([
      { n: 1, text: "a" },
      { n: 2, text: "b" },
    ]);
  });
});
