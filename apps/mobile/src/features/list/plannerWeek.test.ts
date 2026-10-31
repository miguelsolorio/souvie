import { describe, expect, it } from "vitest";
import { findLastRoute, plannerWeekFrom } from "./plannerWeek";

describe("plannerWeekFrom", () => {
  it("reads the week from the planner's route, however deep it sits", () => {
    const state = {
      routes: [
        {
          name: "(app)",
          state: {
            routes: [
              { name: "plan/index", params: { week: "2026-11-09" } },
              { name: "list/index" },
            ],
          },
        },
      ],
    };
    expect(plannerWeekFrom(state)).toBe("2026-11-09");
  });

  it("snaps a mid-week date to its Monday", () => {
    expect(
      plannerWeekFrom({ routes: [{ name: "plan/index", params: { week: "2026-11-12" } }] }),
    ).toBe("2026-11-09");
  });

  it("is null when the planner shows this week, is not in the stack, or has a bad param", () => {
    expect(plannerWeekFrom({ routes: [{ name: "plan/index" }] })).toBeNull();
    expect(plannerWeekFrom({ routes: [{ name: "list/index" }] })).toBeNull();
    expect(
      plannerWeekFrom({ routes: [{ name: "plan/index", params: { week: "someday" } }] }),
    ).toBeNull();
    expect(plannerWeekFrom({ routes: [{ name: "plan/index", params: { week: 7 } }] })).toBeNull();
    expect(plannerWeekFrom(undefined)).toBeNull();
  });

  it("takes the most recent planner route when there are two", () => {
    const state = {
      routes: [
        { name: "plan/index", params: { week: "2026-11-02" } },
        { name: "plan/index", params: { week: "2026-11-16" } },
      ],
    };
    expect(findLastRoute(state, "plan/index")?.params?.week).toBe("2026-11-16");
  });
});
