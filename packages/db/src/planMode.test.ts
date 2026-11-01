// The cache side of switching how much a household plans (useSetPlanMode): the planner and the
// settings screen show the new mode at once, and a refused write puts the old one back.
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { ActiveHousehold } from "./hooks/useHousehold";
import { householdQueryKey } from "./hooks/useHousehold";
import {
  patchActiveHouseholds,
  restoreActiveHouseholds,
  setPlanModeOptions,
  withPlanMode,
} from "./hooks/useSetPlanMode";
import { fakeClient } from "./testing/fakeClient";

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

// The mutation as TanStack Query runs it, without React: setPlanModeOptions through a
// MutationObserver against the in-memory client. Each of the three behaviors has a test that goes
// red when that behavior is removed: the optimistic patch, the rollback in onError, and the
// invalidation in onSettled.
describe("setPlanModeOptions", () => {
  const USER = "a1111111-1111-4111-8111-111111111111";
  const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
  const input = { householdId: HOUSEHOLD, mode: "full" } as const;

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const until = async (check: () => boolean, label: string) => {
    for (let i = 0; i < 200; i++) {
      if (check()) return;
      await tick();
    }
    throw new Error(`timed out waiting for ${label}`);
  };

  /** A client, a cache that holds the household, and the server's copy of its row. */
  function world(opts: { serverHasRow?: boolean } = {}) {
    const { client, server } = fakeClient();
    server.tables.households =
      opts.serverHasRow === false ? [] : [{ id: HOUSEHOLD, plan_mode: "simple" }];
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(householdQueryKey(USER), household({ id: HOUSEHOLD }));
    const cachedMode = () =>
      queryClient.getQueryData<ActiveHousehold>(householdQueryKey(USER))?.plan_mode;
    const stale = () => queryClient.getQueryState(householdQueryKey(USER))?.isInvalidated;
    const observer = new MutationObserver(queryClient, setPlanModeOptions(client, queryClient));
    return { client, server, queryClient, cachedMode, stale, observer };
  }

  it("writes plan_mode to the household row and keeps the new mode in the cache", async () => {
    const { server, cachedMode, observer } = world();
    await observer.mutate(input);
    expect(server.tables.households?.[0]?.plan_mode).toBe("full");
    expect(server.requests("households", "update")[0]?.payload).toEqual({ plan_mode: "full" });
    expect(cachedMode()).toBe("full");
  });

  it("shows the new mode in the cache while the write is still on its way", async () => {
    const { server, cachedMode, observer } = world();
    let release: () => void = () => undefined;
    server.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    expect(cachedMode()).toBe("simple");

    const pending = observer.mutate(input);
    await until(() => cachedMode() === "full", "the optimistic patch");
    // The server has not heard yet: the screen is ahead of it, which is the point.
    expect(server.tables.households?.[0]?.plan_mode).toBe("simple");

    release();
    await pending;
    expect(server.tables.households?.[0]?.plan_mode).toBe("full");
    expect(cachedMode()).toBe("full");
  });

  it("puts the old mode back when the server refuses: a member or outsider updates zero rows", async () => {
    // Row Level Security hides the household's row from the update: zero rows, not an error.
    const { server, cachedMode, observer } = world({ serverHasRow: false });
    await expect(observer.mutate(input)).rejects.toMatchObject({ code: "not_owner" });
    expect(server.requests("households", "update")).toHaveLength(1);
    expect(cachedMode()).toBe("simple");
  });

  it("puts the old mode back when the request itself fails", async () => {
    const { server, cachedMode, observer } = world();
    server.failures = [{ message: "permission denied", code: "42501", status: 403 }];
    await expect(observer.mutate(input)).rejects.toThrow();
    expect(server.tables.households?.[0]?.plan_mode).toBe("simple");
    expect(cachedMode()).toBe("simple");
  });

  it("marks the household stale once the write has succeeded", async () => {
    const { stale, observer } = world();
    expect(stale()).toBe(false);
    await observer.mutate(input);
    expect(stale()).toBe(true);
  });

  it("marks the household stale once the write has been refused, so the next read asks the server", async () => {
    const { stale, observer } = world({ serverHasRow: false });
    expect(stale()).toBe(false);
    await expect(observer.mutate(input)).rejects.toThrow();
    expect(stale()).toBe(true);
  });

  it("leaves another household's cached copy alone", async () => {
    const { queryClient, observer } = world();
    queryClient.setQueryData(householdQueryKey("u2"), household({ id: "someone-else" }));
    await observer.mutate(input);
    expect(queryClient.getQueryData<ActiveHousehold>(householdQueryKey("u2"))?.plan_mode).toBe(
      "simple",
    );
  });
});
