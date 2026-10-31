import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIST_ROUTE } from "../list/routes";
import { clearPlanNotice, getPlanNotice, NOTICE_DURATION_MS, showPlanNotice } from "./notice";
import {
  afterRecipeSaved,
  dayRoute,
  GROCERY_LIST_PENDING_HINT,
  GROCERY_LIST_ROUTE,
  NEW_RECIPE_ROUTE,
  newRecipeFromPickerRoute,
  parsePickerReturn,
  pickRoute,
  planRoute,
  recipeRoute,
} from "./routes";

describe("routes", () => {
  it("builds the week, day, picker and recipe routes from the brief", () => {
    expect(planRoute()).toBe("/plan");
    expect(planRoute("2026-11-02")).toBe("/plan?week=2026-11-02");
    expect(dayRoute("2026-11-03")).toBe("/plan/2026-11-03");
    expect(pickRoute({ date: "2026-11-03", slot: "dinner" })).toBe(
      "/plan/pick?date=2026-11-03&slot=dinner",
    );
    expect(pickRoute({ date: "2026-11-03", slot: "lunch", entry: "abc" })).toBe(
      "/plan/pick?date=2026-11-03&slot=lunch&entry=abc",
    );
    expect(recipeRoute("r1")).toBe("/recipes/r1");
  });

  it("sends Generate list to the grocery list screen WS05 provides", () => {
    // The list screen builds the list on arrival when the week has none: one tap, as the brief says.
    expect(GROCERY_LIST_ROUTE).toBe(`${LIST_ROUTE}?build=1`);
    expect(GROCERY_LIST_PENDING_HINT.length).toBeGreaterThan(0);
  });
});

describe("recipe entry points in the picker", () => {
  const target = { date: "2026-11-03", slot: "dinner" as const };

  it("opens the picker on a just-added recipe", () => {
    expect(pickRoute({ ...target, added: "r9" })).toBe(
      "/plan/pick?date=2026-11-03&slot=dinner&added=r9",
    );
    expect(pickRoute({ ...target, entry: "e1", added: "r9" })).toBe(
      "/plan/pick?date=2026-11-03&slot=dinner&entry=e1&added=r9",
    );
  });

  it("sends the picker's date, slot and swap target along to the add-recipe screen", () => {
    expect(NEW_RECIPE_ROUTE).toBe("/recipes/new");
    expect(newRecipeFromPickerRoute(target)).toBe(
      "/recipes/new?returnTo=pick&date=2026-11-03&slot=dinner",
    );
    expect(newRecipeFromPickerRoute({ ...target, slot: "lunch", entry: "e1" })).toBe(
      "/recipes/new?returnTo=pick&date=2026-11-03&slot=lunch&entry=e1",
    );
  });

  it("reads those params back into the picker's target", () => {
    expect(parsePickerReturn({ returnTo: "pick", date: "2026-11-03", slot: "dinner" })).toEqual(
      target,
    );
    expect(
      parsePickerReturn({ returnTo: "pick", date: "2026-11-03", slot: "snack", entry: "e1" }),
    ).toEqual({ date: "2026-11-03", slot: "snack", entry: "e1" });
    // An empty entry is no entry.
    expect(
      parsePickerReturn({ returnTo: "pick", date: "2026-11-03", slot: "dinner", entry: "" }),
    ).toEqual(target);
  });

  it("treats a missing or malformed return target as coming from somewhere else", () => {
    const ok = { returnTo: "pick", date: "2026-11-03", slot: "dinner" };
    expect(parsePickerReturn({})).toBeNull();
    expect(parsePickerReturn({ ...ok, returnTo: undefined })).toBeNull();
    expect(parsePickerReturn({ ...ok, returnTo: "day" })).toBeNull();
    expect(parsePickerReturn({ ...ok, date: undefined })).toBeNull();
    expect(parsePickerReturn({ ...ok, date: "next tuesday" })).toBeNull();
    expect(parsePickerReturn({ ...ok, date: "2026-02-31" })).toBeNull();
    expect(parsePickerReturn({ ...ok, slot: "brunch" })).toBeNull();
    expect(parsePickerReturn({ ...ok, slot: undefined })).toBeNull();
    // A repeated param arrives as an array: not a date, so not a return target.
    expect(parsePickerReturn({ ...ok, date: ["2026-11-03", "2026-11-04"] })).toBeNull();
  });

  it("round-trips: what the picker sends is what the add-recipe screen reads", () => {
    for (const entry of [undefined, "9a2b7c1e-0000-4000-8000-000000000001"]) {
      const sent = { date: "2026-12-31", slot: "breakfast" as const, entry };
      const url = new URL(newRecipeFromPickerRoute(sent), "https://app.test");
      const params = Object.fromEntries(url.searchParams);
      expect(url.pathname).toBe(NEW_RECIPE_ROUTE);
      expect(parsePickerReturn(params)).toEqual(
        entry ? sent : { date: sent.date, slot: sent.slot },
      );
    }
  });

  describe("after a recipe is saved", () => {
    it("goes back to the picker it came from, same date, slot and swap target", () => {
      expect(afterRecipeSaved("r9", target)).toEqual({
        action: "dismissTo",
        href: "/plan/pick?date=2026-11-03&slot=dinner&added=r9",
      });
      expect(afterRecipeSaved("r9", { ...target, entry: "e1" })).toEqual({
        action: "dismissTo",
        href: "/plan/pick?date=2026-11-03&slot=dinner&entry=e1&added=r9",
      });
    });

    it("opens the recipe's own page for anyone who did not come from the picker", () => {
      // The Recipes tab, a share, a deep link: unchanged from before the picker had the control.
      expect(afterRecipeSaved("r9", null)).toEqual({ action: "replace", href: "/recipes/r9" });
      expect(afterRecipeSaved("r9", undefined)).toEqual({ action: "replace", href: "/recipes/r9" });
      expect(afterRecipeSaved("r9", parsePickerReturn({ date: "2026-11-03" }))).toEqual({
        action: "replace",
        href: recipeRoute("r9"),
      });
    });
  });
});

describe("plan notice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearPlanNotice();
  });
  afterEach(() => {
    clearPlanNotice();
    vi.useRealTimers();
  });

  it("shows a message and clears it by itself", () => {
    showPlanNotice("That change was not saved.");
    expect(getPlanNotice().message).toBe("That change was not saved.");
    vi.advanceTimersByTime(NOTICE_DURATION_MS + 1);
    expect(getPlanNotice().message).toBeNull();
  });

  it("restarts the timer for a newer message and counts each one", () => {
    showPlanNotice("first");
    const firstId = getPlanNotice().id;
    vi.advanceTimersByTime(NOTICE_DURATION_MS - 100);
    showPlanNotice("second");
    expect(getPlanNotice().id).toBeGreaterThan(firstId);
    vi.advanceTimersByTime(NOTICE_DURATION_MS - 100);
    expect(getPlanNotice().message).toBe("second");
    vi.advanceTimersByTime(200);
    expect(getPlanNotice().message).toBeNull();
  });

  it("can be dismissed", () => {
    showPlanNotice("x");
    clearPlanNotice();
    expect(getPlanNotice().message).toBeNull();
  });
});
