import type { SuggestPlanResponse } from "@mp/core";
import type { MpClient } from "@mp/db";
import { describe, expect, it, vi } from "vitest";
import { nextHref, previousHref } from "./onboardingState";
import {
  combineNotice,
  noticeFromParam,
  noticeText,
  RECHECK_STEPS,
  recheckPlans,
  recheckWeekStarts,
  shouldRecheckPlan,
  withNotice,
} from "./planRecheck";
import { suggestPlan } from "./suggestApi";

const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const RECIPE_ID = "22222222-2222-4222-8222-222222222222";

function planResponse(repaired?: { replaced: number; removed: number }): SuggestPlanResponse {
  return {
    ok: true,
    planId: PLAN_ID,
    entries: [
      { date: "2026-11-02", slot: "dinner", recipeId: RECIPE_ID, servings: 4, why: "Quick." },
    ],
    composedBy: "existing",
    ...(repaired ? { repaired } : {}),
  };
}

describe("when a re-check runs", () => {
  it("only after saving diets and allergies (3) or tastes (4), and only in edit mode", () => {
    expect(RECHECK_STEPS).toEqual([3, 4]);
    expect(shouldRecheckPlan(3, true)).toBe(true);
    expect(shouldRecheckPlan(4, true)).toBe(true);
    for (const step of [1, 2, 5, 6, 7, 8])
      expect(shouldRecheckPlan(step, true), `${step}`).toBe(false);
    // First-time onboarding has no plan to check yet.
    expect(shouldRecheckPlan(3, false)).toBe(false);
    expect(shouldRecheckPlan(4, false)).toBe(false);
  });

  it("checks this week and the coming week, from any day", () => {
    // 2026-11-04 is a Wednesday: this week starts Monday the 2nd, the coming week on the 9th.
    expect(recheckWeekStarts(new Date(2026, 10, 4, 15))).toEqual(["2026-11-02", "2026-11-09"]);
    // On a Monday this week is today.
    expect(recheckWeekStarts(new Date(2026, 10, 2, 0, 30))).toEqual(["2026-11-02", "2026-11-09"]);
    // Sunday night is still the old week (the device's own clock decides).
    expect(recheckWeekStarts(new Date(2026, 10, 8, 23, 30))).toEqual(["2026-11-02", "2026-11-09"]);
  });
});

describe("recheckPlans", () => {
  it("calls draft for both weeks when both have dinners, and adds up what changed", async () => {
    const draft = vi.fn(async (weekStart: string) =>
      planResponse(
        weekStart === "2026-11-02" ? { replaced: 1, removed: 0 } : { replaced: 0, removed: 2 },
      ),
    );
    const result = await recheckPlans(
      { hasDinners: async () => true, draft },
      new Date(2026, 10, 4),
    );
    expect(draft.mock.calls.map((call) => call[0])).toEqual(["2026-11-02", "2026-11-09"]);
    expect(result).toEqual({
      notice: "updated",
      checked: ["2026-11-02", "2026-11-09"],
      replaced: 1,
      removed: 2,
    });
  });

  it("says the plan already fits when nothing changed", async () => {
    const result = await recheckPlans(
      { hasDinners: async () => true, draft: async () => planResponse() },
      new Date(2026, 10, 4),
    );
    expect(result).toMatchObject({ notice: "same", replaced: 0, removed: 0 });
  });

  it("leaves a week with no dinners alone: draft there would plan a whole new week", async () => {
    const draft = vi.fn(async () => planResponse());
    const result = await recheckPlans(
      { hasDinners: async (weekStart) => weekStart === "2026-11-09", draft },
      new Date(2026, 10, 4),
    );
    expect(draft).toHaveBeenCalledTimes(1);
    expect(draft).toHaveBeenCalledWith("2026-11-09");
    expect(result.checked).toEqual(["2026-11-09"]);
    const none = await recheckPlans(
      { hasDinners: async () => false, draft },
      new Date(2026, 10, 4),
    );
    expect(none).toEqual({ notice: "same", checked: [], replaced: 0, removed: 0 });
    expect(draft).toHaveBeenCalledTimes(1);
  });

  it("stops and throws when a call fails, so the person can retry", async () => {
    const draft = vi
      .fn<(weekStart: string) => Promise<SuggestPlanResponse>>()
      .mockResolvedValueOnce(planResponse())
      .mockRejectedValueOnce(new Error("offline"));
    await expect(
      recheckPlans({ hasDinners: async () => true, draft }, new Date(2026, 10, 4)),
    ).rejects.toThrow("offline");
    expect(draft).toHaveBeenCalledTimes(2);
  });

  it("sends the request the hook sends: suggest, mode draft, one Monday per call", async () => {
    // usePlanRecheck passes `mutateAsync({ mode: "draft", weekStart })`, which becomes suggestPlan
    // with the household id. Run that same call against a recording client.
    const invoke = vi.fn(async (_name: string, _options: { body: unknown }) => ({
      data: planResponse({ replaced: 1, removed: 0 }),
      error: null,
    }));
    const client = { functions: { invoke } } as unknown as MpClient;
    const result = await recheckPlans(
      {
        hasDinners: async () => true,
        draft: (weekStart) => suggestPlan(client, { householdId: "h-1", weekStart, mode: "draft" }),
      },
      new Date(2026, 10, 4),
    );
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls.map((call) => call[0])).toEqual(["suggest", "suggest"]);
    expect(invoke.mock.calls.map((call) => call[1].body)).toEqual([
      { householdId: "h-1", weekStart: "2026-11-02", mode: "draft" },
      { householdId: "h-1", weekStart: "2026-11-09", mode: "draft" },
    ]);
    // The response's `repaired` survives parsing and drives the notice.
    expect(result).toMatchObject({ notice: "updated", replaced: 2, removed: 0 });
  });
});

describe("the result line and how it travels", () => {
  it("has one line for each result", () => {
    expect(noticeText("updated")).toBe("Your week was updated.");
    expect(noticeText("same")).toBe("Your plan already fits.");
  });

  it("reads only a known notice from the URL", () => {
    expect(noticeFromParam("updated")).toBe("updated");
    expect(noticeFromParam(["same"])).toBe("same");
    expect(noticeFromParam("<b>hi</b>")).toBeNull();
    expect(noticeFromParam(undefined)).toBeNull();
  });

  it("never lets a later 'same' hide an earlier 'updated'", () => {
    expect(combineNotice("updated", "same")).toBe("updated");
    expect(combineNotice("same", "updated")).toBe("updated");
    expect(combineNotice(null, "same")).toBe("same");
    expect(combineNotice("same", null)).toBe("same");
    expect(combineNotice(null, null)).toBeNull();
  });

  it("adds the notice to an href with or without a query", () => {
    expect(withNotice("/household/settings", "updated")).toBe("/household/settings?notice=updated");
    expect(withNotice("/04-dislikes-cuisines?edit=1", "same")).toBe(
      "/04-dislikes-cuisines?edit=1&notice=same",
    );
    expect(withNotice("/household/settings", null)).toBe("/household/settings");
  });

  it("rides the edit walk to settings, and is not added outside edit mode", () => {
    expect(nextHref(3, true, "updated")).toBe("/04-dislikes-cuisines?edit=1&notice=updated");
    expect(nextHref(6, true, "updated")).toBe("/household/settings?notice=updated");
    expect(previousHref(4, true, "same")).toBe("/03-diets-allergies?edit=1&notice=same");
    expect(previousHref(2, true, "same")).toBe("/household/settings?notice=same");
    expect(nextHref(3, false, "updated")).toBe("/04-dislikes-cuisines");
  });
});
