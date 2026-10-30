import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertEntryOptions } from "../hooks/useUpsertEntry";
import { mealPlanEntriesKey, mealPlanKey, planWritesPending } from "../planning";
import { fakeClient } from "../testing/fakeClient";
import {
  acquirePlanChannel,
  PLAN_REALTIME_DEBOUNCE_MS,
  planChannelName,
  subscribePlanChanges,
} from "./planning";

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const OTHER = "0b000000-0000-4000-8000-00000000000b";
const PLAN = "ca000000-0000-4000-8000-0000000000a1";
const WEEK = "2026-11-02";

function setup() {
  const { client, channels } = fakeClient();
  const queryClient = new QueryClient();
  queryClient.setQueryData(mealPlanKey(HOUSEHOLD, WEEK), null);
  queryClient.setQueryData(mealPlanEntriesKey(HOUSEHOLD, PLAN), []);
  queryClient.setQueryData(mealPlanKey(OTHER, WEEK), null);
  const stale = (key: readonly unknown[]) => queryClient.getQueryState(key)?.isInvalidated === true;
  return { client, channels, queryClient, stale };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("subscribePlanChanges", () => {
  it("listens to the household's entries and plans, filtered by household_id", () => {
    const { client, channels, queryClient } = setup();
    subscribePlanChanges(client, queryClient, HOUSEHOLD);
    expect(channels).toHaveLength(1);
    expect(channels[0]?.name).toBe(planChannelName(HOUSEHOLD));
    expect(channels[0]?.name).toBe(`plan:${HOUSEHOLD}`);
    expect(channels[0]?.handlers.map((h) => [h.type, h.filter])).toEqual([
      [
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "meal_plan_entries",
          filter: `household_id=eq.${HOUSEHOLD}`,
        },
      ],
      [
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "meal_plans",
          filter: `household_id=eq.${HOUSEHOLD}`,
        },
      ],
    ]);
  });

  it("invalidates the household's plan queries when a remote change arrives, and no one else's", async () => {
    const { client, channels, queryClient, stale } = setup();
    subscribePlanChanges(client, queryClient, HOUSEHOLD);
    channels[0]?.handlers[0]?.callback({ eventType: "INSERT" });
    expect(stale(mealPlanKey(HOUSEHOLD, WEEK))).toBe(false); // waits out the debounce
    await vi.advanceTimersByTimeAsync(PLAN_REALTIME_DEBOUNCE_MS);
    expect(stale(mealPlanKey(HOUSEHOLD, WEEK))).toBe(true);
    expect(stale(mealPlanEntriesKey(HOUSEHOLD, PLAN))).toBe(true);
    expect(stale(mealPlanKey(OTHER, WEEK))).toBe(false);
  });

  it("collapses a burst of changes into one invalidation", async () => {
    const { client, channels, queryClient } = setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    subscribePlanChanges(client, queryClient, HOUSEHOLD);
    for (let i = 0; i < 7; i++) channels[0]?.handlers[0]?.callback({ eventType: "INSERT" });
    channels[0]?.handlers[1]?.callback({ eventType: "INSERT" });
    await vi.advanceTimersByTimeAsync(PLAN_REALTIME_DEBOUNCE_MS * 4);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["meal-plan", HOUSEHOLD] });
  });

  it("fetches fresh data whenever the channel joins or rejoins", async () => {
    const { client, channels, queryClient } = setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const statuses: string[] = [];
    subscribePlanChanges(client, queryClient, HOUSEHOLD, { onStatus: (s) => statuses.push(s) });
    channels[0]?.statusCallback?.("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(PLAN_REALTIME_DEBOUNCE_MS);
    expect(invalidate).toHaveBeenCalledTimes(1);

    channels[0]?.statusCallback?.("CLOSED");
    await vi.advanceTimersByTimeAsync(PLAN_REALTIME_DEBOUNCE_MS);
    expect(invalidate).toHaveBeenCalledTimes(1); // a drop alone fetches nothing

    channels[0]?.statusCallback?.("SUBSCRIBED"); // the phone is back online
    await vi.advanceTimersByTimeAsync(PLAN_REALTIME_DEBOUNCE_MS);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual(["SUBSCRIBED", "CLOSED", "SUBSCRIBED"]);
  });

  it("waits out this device's own pending saves instead of refetching over them", async () => {
    const { client, server, channels } = fakeClient();
    const queryClient = new QueryClient();
    let release: () => void = () => {};
    server.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    subscribePlanChanges(client, queryClient, HOUSEHOLD);

    // A save is in flight (it will answer when the gate opens).
    const save = new MutationObserver(queryClient, upsertEntryOptions(client, queryClient)).mutate({
      mode: "edit",
      id: "ea000000-0000-4000-8000-0000000000a1",
      householdId: HOUSEHOLD,
      planId: PLAN,
      patch: { servings: 5 },
    });
    save.catch(() => undefined); // the entry is not on this fake server, so the save ends in not_found
    await vi.advanceTimersByTimeAsync(10);
    expect(planWritesPending(queryClient)).toBe(1);

    channels[0]?.handlers[0]?.callback({ eventType: "UPDATE" }); // the echo of our own write
    await vi.advanceTimersByTimeAsync(PLAN_REALTIME_DEBOUNCE_MS * 2);
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["meal-plan", HOUSEHOLD] });

    release();
    await vi.advanceTimersByTimeAsync(50);
    expect(planWritesPending(queryClient)).toBe(0);

    channels[0]?.handlers[0]?.callback({ eventType: "UPDATE" }); // a change by someone else
    await vi.advanceTimersByTimeAsync(PLAN_REALTIME_DEBOUNCE_MS * 2);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["meal-plan", HOUSEHOLD] });
  });

  it("stops: removes the channel and ignores events that were already scheduled", async () => {
    const { client, channels, queryClient } = setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const stop = subscribePlanChanges(client, queryClient, HOUSEHOLD);
    channels[0]?.handlers[0]?.callback({ eventType: "UPDATE" });
    stop();
    await vi.advanceTimersByTimeAsync(PLAN_REALTIME_DEBOUNCE_MS * 2);
    expect(channels[0]?.removed).toBe(true);
    expect(invalidate).not.toHaveBeenCalled();
    channels[0]?.handlers[0]?.callback({ eventType: "UPDATE" });
    await vi.advanceTimersByTimeAsync(PLAN_REALTIME_DEBOUNCE_MS * 2);
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("acquirePlanChannel", () => {
  it("shares one channel between screens and closes it with the last one", () => {
    const { client, channels, queryClient } = setup();
    const releaseWeek = acquirePlanChannel(client, queryClient, HOUSEHOLD);
    const releaseDay = acquirePlanChannel(client, queryClient, HOUSEHOLD);
    expect(channels).toHaveLength(1);
    releaseWeek();
    expect(channels[0]?.removed).toBe(false);
    releaseDay();
    expect(channels[0]?.removed).toBe(true);
  });

  it("releasing twice does not close a channel someone else still holds", () => {
    const { client, channels, queryClient } = setup();
    const first = acquirePlanChannel(client, queryClient, HOUSEHOLD);
    const second = acquirePlanChannel(client, queryClient, HOUSEHOLD);
    first();
    first();
    expect(channels[0]?.removed).toBe(false);
    second();
    expect(channels[0]?.removed).toBe(true);
  });

  it("opens a new channel after the last holder left, and one per household", () => {
    const { client, channels, queryClient } = setup();
    acquirePlanChannel(client, queryClient, HOUSEHOLD)();
    acquirePlanChannel(client, queryClient, HOUSEHOLD);
    acquirePlanChannel(client, queryClient, OTHER);
    expect(channels.map((c) => c.name)).toEqual([
      `plan:${HOUSEHOLD}`,
      `plan:${HOUSEHOLD}`,
      `plan:${OTHER}`,
    ]);
  });
});
