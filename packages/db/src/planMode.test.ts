// The cache side of switching how much a household plans (useSetPlanMode): the planner and the
// settings screen show the new mode at once, and a refused write puts the old one back.
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { ActiveHousehold } from "./hooks/useHousehold";
import { householdQueryKey } from "./hooks/useHousehold";
import {
  patchActiveHouseholds,
  restoreActiveHouseholds,
  withPlanMode,
} from "./hooks/useSetPlanMode";

const household = (over: Partial<ActiveHousehold> = {}): ActiveHousehold => ({
  id: "h1",
  name: "Our kitchen",
  zip: null,
  default_connection_id: null,
  created_by: null,
  created_at: "2026-10-31T12:00:00.000+00:00",
  updated_at: "2026-10-31T12:00:00.000+00:00",
  deleted_at: null,
  plan_mode: "simple",
  role: "owner",
  ...over,
});

describe("withPlanMode", () => {
  it("changes the mode of the household it is for", () => {
    expect(withPlanMode(household(), "h1", "full")).toMatchObject({ id: "h1", plan_mode: "full" });
  });

  it("leaves another household, or none, alone", () => {
    const other = household({ id: "h2" });
    expect(withPlanMode(other, "h1", "full")).toBe(other);
    expect(withPlanMode(null, "h1", "full")).toBeNull();
    expect(withPlanMode(undefined, "h1", "full")).toBeUndefined();
  });

  it("returns the same object when nothing changes, so nothing re-renders", () => {
    const same = household({ plan_mode: "full" });
    expect(withPlanMode(same, "h1", "full")).toBe(same);
  });
});

describe("the cached household around a write", () => {
  it("shows the new mode at once and restores the old one when the write fails", () => {
    const queryClient = new QueryClient();
    const key = householdQueryKey("u1");
    queryClient.setQueryData(key, household());

    const previous = patchActiveHouseholds(queryClient, { householdId: "h1", mode: "full" });
    expect(queryClient.getQueryData<ActiveHousehold>(key)?.plan_mode).toBe("full");

    restoreActiveHouseholds(queryClient, previous);
    expect(queryClient.getQueryData<ActiveHousehold>(key)?.plan_mode).toBe("simple");
  });

  it("touches only the household that was written", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(householdQueryKey("u1"), household({ id: "h1" }));
    queryClient.setQueryData(householdQueryKey("u2"), household({ id: "h2" }));

    patchActiveHouseholds(queryClient, { householdId: "h1", mode: "full" });
    expect(queryClient.getQueryData<ActiveHousehold>(householdQueryKey("u1"))?.plan_mode).toBe(
      "full",
    );
    expect(queryClient.getQueryData<ActiveHousehold>(householdQueryKey("u2"))?.plan_mode).toBe(
      "simple",
    );
  });

  it("does not invent a household when none is cached", () => {
    const queryClient = new QueryClient();
    const previous = patchActiveHouseholds(queryClient, { householdId: "h1", mode: "full" });
    expect(previous).toEqual([]);
    expect(queryClient.getQueryData(householdQueryKey("u1"))).toBeUndefined();
  });
});
