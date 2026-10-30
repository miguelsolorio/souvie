import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPlanNotice, getPlanNotice, NOTICE_DURATION_MS, showPlanNotice } from "./notice";
import {
  dayRoute,
  GROCERY_LIST_PENDING_HINT,
  GROCERY_LIST_ROUTE,
  pickRoute,
  planRoute,
  recipeRoute,
} from "./routes";
import { getEntryWhy, setEntryWhy } from "./why";

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

  it("leaves Generate list disabled, with a reason, until WS05 provides a route", () => {
    expect(GROCERY_LIST_ROUTE).toBeNull();
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

describe("why this", () => {
  it("keeps a trimmed reason per entry and drops it when emptied", () => {
    setEntryWhy("e1", "  Uses the leftover lemons  ");
    expect(getEntryWhy("e1")).toBe("Uses the leftover lemons");
    setEntryWhy("e1", "   ");
    expect(getEntryWhy("e1")).toBeUndefined();
    setEntryWhy("e2", "a reason");
    setEntryWhy("e2", null);
    expect(getEntryWhy("e2")).toBeUndefined();
  });
});
