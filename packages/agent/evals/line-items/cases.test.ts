// The line-item golden set itself (WS15): a hundred cases, each naming products the catalog
// really has, a short explicit list of accepted alternatives, and the safety cases that expect
// nothing. And a check that the suite can fail: a matcher that picks the wrong product scores low.
import { MOCK_PRODUCTS } from "@mp/retailers/mock";
import { describe, expect, it } from "vitest";
import { ROWS } from "./cases.ts";
import { buildCases, RETAILERS, runRetailer, unknownProductNames } from "./run.ts";

const cases = buildCases();

describe("the line-item cases", () => {
  it("are exactly 100, with unique ids and display-name-and-allergy combinations", () => {
    expect(cases).toHaveLength(100);
    expect(new Set(cases.map((c) => c.id)).size).toBe(100);
    expect(
      new Set(
        cases.map((c) => `${c.display}|${c.allergies.join(",")}|${c.line.qualifiers.join(",")}`),
      ).size,
    ).toBe(100);
  });

  it("name only products the mock catalog has, once each", () => {
    expect(unknownProductNames(cases)).toEqual([]);
    const catalog = new Set(MOCK_PRODUCTS.map((p) => p.name));
    for (const c of cases)
      for (const name of c.accepted) expect(catalog.has(name), name).toBe(true);
  });

  it("keep the accepted alternatives small and explicit: at most three names a case", () => {
    for (const c of cases) expect(c.accepted.length, c.display).toBeLessThanOrEqual(3);
    const withAlternatives = cases.filter((c) => c.accepted.length > 1);
    expect(withAlternatives.length).toBeLessThanOrEqual(10);
  });

  it("include the wrong-product tests: allergen, qualifier and not-stocked cases expect nothing", () => {
    const none = cases.filter((c) => c.none);
    expect(none.length).toBeGreaterThanOrEqual(7);
    for (const c of none) expect(c.accepted, c.display).toEqual([]);
    expect(cases.some((c) => c.allergies.length > 0)).toBe(true);
    expect(cases.some((c) => c.line.qualifiers.length > 0)).toBe(true);
    expect(cases.some((c) => c.line.ingredient === null)).toBe(true);
  });

  it("two retailers, both with 100 cases", () => {
    expect(RETAILERS.map((r) => r.id)).toEqual(["kroger", "safeway"]);
    expect(ROWS).toHaveLength(100);
  });
});

describe("the suite can fail", () => {
  it("scores a wrong pick as a failure, and a pick where nothing is wanted as a failure", async () => {
    // The same cases with every expected product swapped for a product nobody would want.
    const wrong = cases.map((c) => ({
      ...c,
      accepted: c.none ? [] : ["Larkspur Kitchen Ketchup"],
      none: false,
    }));
    const result = await runRetailer(RETAILERS[0] as never, wrong);
    expect(result.score).toBeLessThan(10);
    expect(result.results.filter((r) => !r.pass).length).toBeGreaterThan(90);

    // And the safety cases flipped: expecting a product where the household's allergen rules it out.
    const unsafe = cases
      .filter((c) => c.none && c.allergies.length > 0)
      .map((c) => ({
        ...c,
        none: false,
        accepted: ["Northfork Creamery Unsalted Butter"],
      }));
    const flipped = await runRetailer(RETAILERS[0] as never, unsafe);
    expect(flipped.passed).toBe(0);
  });

  it("the shipped cases pass at both retailers, apart from the one recorded known failure", async () => {
    for (const setup of RETAILERS) {
      const result = await runRetailer(setup, cases);
      expect(result.score, setup.id).toBeGreaterThanOrEqual(90);
      expect(result.results.filter((r) => !r.pass).map((r) => r.id)).toEqual(["li-002"]);
    }
  });
});
