import { QueryClient } from "@tanstack/react-query";
import { persistQueryClientSave } from "@tanstack/react-query-persist-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistOptions, queryClient, shouldPersistQuery } from "./queryClient";

afterEach(() => {
  vi.useRealTimers();
});

describe("query cache persistence", () => {
  it("persists only successful queries that opt in", () => {
    const query = (status: "success" | "error" | "pending", persist?: boolean) =>
      ({ state: { status }, meta: persist === undefined ? undefined : { persist } }) as Parameters<
        typeof shouldPersistQuery
      >[0];

    expect(shouldPersistQuery(query("success", true))).toBe(true);
    expect(shouldPersistQuery(query("success"))).toBe(false);
    expect(shouldPersistQuery(query("success", false))).toBe(false);
    expect(shouldPersistQuery(query("error", true))).toBe(false);
    expect(shouldPersistQuery(query("pending", true))).toBe(false);
  });

  it("keeps restored queries for at least the persisted max age", () => {
    expect(queryClient.getDefaultOptions().queries?.gcTime).toBeGreaterThanOrEqual(
      persistOptions.maxAge ?? 0,
    );
  });

  it("writes only opted-in queries to storage", async () => {
    const client = new QueryClient();
    await client.prefetchQuery({
      queryKey: ["kept"],
      queryFn: () => ({ ok: true }),
      meta: { persist: true },
    });
    await client.prefetchQuery({ queryKey: ["dropped"], queryFn: () => ({ ok: true }) });

    // The persister throttles writes; advance past the throttle window.
    vi.useFakeTimers();
    await persistQueryClientSave({ ...persistOptions, queryClient: client });
    vi.advanceTimersByTime(1_000);
    const restored = await persistOptions.persister.restoreClient();

    expect(restored?.clientState.queries.map((q) => q.queryKey)).toEqual([["kept"]]);
  });
});
