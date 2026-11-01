// Where the app sends its events: the success handlers of the mutations that make a plan and
// approve a run, and the planner's first manual entry. The mutations are captured through a mocked
// useMutation, so the handlers run without a device. Counts and enums only.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  cache: new Map<string, unknown>(),
  track: {
    planCreated: vi.fn(),
    runApproved: vi.fn(),
    listBuilt: vi.fn(),
    onboardingCompleted: vi.fn(),
  },
  upsertMutate: vi.fn(),
}));

vi.mock("react-native", () => import("../testing/reactNativeStub"));
vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: Record<string, unknown>) => {
    h.options.push(options);
    return { mutate: vi.fn(), mutateAsync: vi.fn() };
  },
  useQuery: () => ({}),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    getQueryData: (key: unknown[]) => h.cache.get(JSON.stringify(key)),
  }),
}));
vi.mock("@mp/db", () => ({
  useSupabase: () => ({}),
  useHousehold: () => ({ data: { id: "h1" } }),
  useProfile: () => ({ data: null }),
  useUpsertEntry: () => ({ mutate: h.upsertMutate }),
  useDeleteEntry: () => ({ mutate: vi.fn() }),
  newId: () => "new-id",
  planErrorMessage: () => "",
  fetchMealPlan: vi.fn(),
  fetchMealPlanEntries: vi.fn(),
}));
vi.mock("./track", () => ({ track: h.track }));
vi.mock("../features/plan/ids", () => ({}));
vi.mock("../features/plan/notice", () => ({ showPlanNotice: vi.fn() }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useSuggestWeek } from "../features/onboarding/useSuggestWeek";
import { usePlanActions } from "../features/plan/usePlanActions";
import { useApproveRun } from "../features/shopping/useShoppingRun";

beforeEach(() => {
  h.options.length = 0;
  h.cache.clear();
  for (const fn of Object.values(h.track)) fn.mockReset();
  h.upsertMutate.mockReset();
});

function inComponent<T>(hook: () => T): T {
  let value: T | undefined;
  function Probe() {
    value = hook();
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return value as T;
}

describe("plan_created from the model", () => {
  const response = (composedBy: string, entries: number) => ({
    ok: true,
    planId: "p1",
    composedBy,
    entries: Array.from({ length: entries }, () => ({})),
  });

  it("is sent for a draft the model or the ranking made", () => {
    inComponent(() => useSuggestWeek());
    const onSuccess = h.options[0]?.onSuccess as (r: unknown, i: unknown) => void;
    onSuccess(response("model", 5), { mode: "draft" });
    onSuccess(response("fallback", 4), { mode: "draft" });
    expect(h.track.planCreated.mock.calls).toEqual([
      [{ entries: 5, source: "ai" }],
      [{ entries: 4, source: "ai" }],
    ]);
  });

  it("is not sent for a draft that found the week's plan, or for a replace", () => {
    inComponent(() => useSuggestWeek());
    const onSuccess = h.options[0]?.onSuccess as (r: unknown, i: unknown) => void;
    onSuccess(response("existing", 5), { mode: "draft" });
    onSuccess(response("model", 5), { mode: "replace" });
    expect(h.track.planCreated).not.toHaveBeenCalled();
  });
});

describe("plan_created by hand", () => {
  const recipe = {
    id: "r1",
    title: "Soup",
    image_url: null,
    servings: 4,
    prep_min: 1,
    cook_min: 1,
  };

  it("is sent when the first entry creates the week's plan, and only then", () => {
    const actions = inComponent(() => usePlanActions("h1"));
    const add = (plan: unknown) =>
      actions.addRecipe({
        plan: plan as never,
        date: "2026-11-02",
        slot: "dinner",
        recipe: recipe as never,
        servings: 4,
        entries: [],
      });
    add(null);
    expect(h.track.planCreated).toHaveBeenCalledWith({ entries: 1, source: "manual" });
    h.track.planCreated.mockReset();
    add({ id: "plan-1" });
    expect(h.track.planCreated).not.toHaveBeenCalled();
    expect(h.upsertMutate).toHaveBeenCalledTimes(2);
  });
});

describe("run_approved", () => {
  const key = (runId: string) => JSON.stringify(["shopping-runs", "h1", runId]);

  it("is sent with the retailer and how many lines the person edited", () => {
    h.cache.set(key("run-1"), { id: "run-1", retailer: "kroger" });
    inComponent(() => useApproveRun("run-1"));
    const onSuccess = h.options[0]?.onSuccess as (r: unknown, a: unknown) => void;
    onSuccess(
      {},
      { items: [], draft: { a: { action: "remove" }, b: { action: "quantity", quantity: 2 } } },
    );
    expect(h.track.runApproved).toHaveBeenCalledWith({ retailer: "kroger", review_edits: 2 });
  });

  it("is sent with zero edits when the person approved as proposed", () => {
    h.cache.set(key("run-1"), { id: "run-1", retailer: "safeway" });
    inComponent(() => useApproveRun("run-1"));
    const onSuccess = h.options[0]?.onSuccess as (r: unknown, a: unknown) => void;
    onSuccess({}, { items: [], draft: {} });
    expect(h.track.runApproved).toHaveBeenCalledWith({ retailer: "safeway", review_edits: 0 });
  });

  it("is not sent when the run is not in the cache or its retailer is unknown", () => {
    inComponent(() => useApproveRun("run-1"));
    const onSuccess = h.options[0]?.onSuccess as (r: unknown, a: unknown) => void;
    onSuccess({}, { items: [], draft: {} });
    h.cache.set(key("run-1"), { id: "run-1", retailer: "instacart" });
    onSuccess({}, { items: [], draft: {} });
    expect(h.track.runApproved).not.toHaveBeenCalled();
  });
});
