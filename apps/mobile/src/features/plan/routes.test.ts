import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIST_ROUTE } from "../list/routes";
import { clearPlanNotice, getPlanNotice, NOTICE_DURATION_MS, showPlanNotice } from "./notice";
import {
  dayRoute,
  GROCERY_LIST_PENDING_HINT,
  GROCERY_LIST_ROUTE,
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
