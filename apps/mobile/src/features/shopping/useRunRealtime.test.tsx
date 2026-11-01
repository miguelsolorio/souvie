// useRunRealtime (WS09 hook; the WS09 review found only the pure overlayRun was tested): a Realtime
// change is laid over the cached run key by key, so a payload that leaves out a large unchanged
// column (Postgres can omit it) keeps the cached value, and the lines are refetched only when the
// status moved.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const RUN = "5a000000-0000-4000-8000-0000000000a1";
const OTHER_RUN = "5a000000-0000-4000-8000-0000000000a2";

const h = vi.hoisted(() => ({
  household: { data: { id: "0a000000-0000-4000-8000-00000000000a" } as { id: string } | undefined },
  channels: [] as Array<{
    name: string;
    filter: Record<string, unknown>;
    handler: (payload: unknown) => void;
    removed: boolean;
  }>,
}));

vi.mock("@mp/db", () => ({
  useHousehold: () => h.household,
  useSupabase: () => ({
    channel: (name: string) => {
      const channel = {
        name,
        filter: {} as Record<string, unknown>,
        handler: (_payload: unknown) => {},
        removed: false,
      };
      h.channels.push(channel);
      const api = {
        on: (_type: string, filter: Record<string, unknown>, handler: (p: unknown) => void) => {
          channel.filter = filter;
          channel.handler = handler;
          return api;
        },
        subscribe: () => channel,
      };
      return api;
    },
    removeChannel: (channel: { removed: boolean }) => {
      channel.removed = true;
      return Promise.resolve("ok");
    },
  }),
}));

import type { ShoppingRun } from "./logic";
import { runChannelName, useRunRealtime } from "./useRunRealtime";
import { shoppingRunItemsKey, shoppingRunKey, shoppingRunsKey } from "./useShoppingRun";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function cachedRun(over: Partial<ShoppingRun> = {}): ShoppingRun {
  return {
    id: RUN,
    household_id: HOUSEHOLD,
    list_id: "9a000000-0000-4000-8000-0000000000a1",
    retailer: "kroger",
    store_name: "QFC Duvall",
    trigger: "manual",
    status: "running",
    cart_snapshot: { summary: "kept summary", handoffUrl: "https://example.test/checkout" },
    subtotal_usd: 64.3,
    transcript: [
      {
        ts: "2026-10-31T16:00:05.000Z",
        tool: "search_products",
        by: "host",
        output_summary: "3",
        ok: true,
      },
    ],
    error: null,
    progress: { phase: "searching", done: 3, total: 12 },
    approved_at: null,
    policy: null,
    started_at: "2026-10-31T16:00:00.000Z",
    finished_at: null,
    created_at: "2026-10-31T15:59:00.000Z",
    ...over,
  };
}

let queryClient: QueryClient;
let renderer: ReactTestRenderer | null = null;

function Probe() {
  useRunRealtime();
  return null;
}

function mount() {
  act(() => {
    renderer = create(
      createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)),
    );
  });
}

function fire(row: Record<string, unknown> | undefined, eventType = "UPDATE") {
  const channel = h.channels.at(-1);
  if (!channel) throw new Error("not subscribed");
  act(() => channel.handler({ eventType, new: row }));
}

const cachedOne = () =>
  queryClient.getQueryData<ShoppingRun | null>(shoppingRunKey(HOUSEHOLD, RUN));
const cachedList = () => queryClient.getQueryData<ShoppingRun[]>(shoppingRunsKey(HOUSEHOLD));

beforeEach(() => {
  h.channels = [];
  h.household = { data: { id: HOUSEHOLD } };
  renderer = null;
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  queryClient.setQueryData(shoppingRunKey(HOUSEHOLD, RUN), cachedRun());
  queryClient.setQueryData(shoppingRunsKey(HOUSEHOLD), [cachedRun({ transcript: [] })]);
});

describe("useRunRealtime", () => {
  it("subscribes to this household's runs under its own filter, and unsubscribes on unmount", () => {
    mount();
    expect(h.channels).toHaveLength(1);
    expect(h.channels[0]?.name).toBe(runChannelName(HOUSEHOLD));
    expect(h.channels[0]?.filter).toEqual({
      event: "*",
      schema: "public",
      table: "shopping_runs",
      filter: `household_id=eq.${HOUSEHOLD}`,
    });
    act(() => renderer?.unmount());
    expect(h.channels[0]?.removed).toBe(true);
  });

  it("does not subscribe before the household is known", () => {
    h.household = { data: undefined as unknown as { id: string } };
    mount();
    expect(h.channels).toHaveLength(0);
  });

  it("keeps the transcript, the snapshot and the subtotal a payload leaves out", () => {
    mount();
    fire({ id: RUN, household_id: HOUSEHOLD, status: "cart_ready", heartbeat_at: null });
    const run = cachedOne();
    expect(run?.status).toBe("cart_ready");
    expect(run?.transcript).toHaveLength(1);
    expect(run?.cart_snapshot).toEqual({
      summary: "kept summary",
      handoffUrl: "https://example.test/checkout",
    });
    expect(run?.subtotal_usd).toBe(64.3);
    expect(run?.progress).toEqual({ phase: "searching", done: 3, total: 12 });
  });

  it("takes a column the payload does carry, even when it is null or empty", () => {
    mount();
    fire({
      id: RUN,
      status: "cart_ready",
      subtotal_usd: "60.10",
      cart_snapshot: null,
      transcript: [],
      progress: { phase: "done", done: 12, total: 12 },
    });
    const run = cachedOne();
    expect(run?.subtotal_usd).toBe(60.1);
    expect(run?.cart_snapshot).toBeNull();
    expect(run?.transcript).toEqual([]);
    expect(run?.progress).toEqual({ phase: "done", done: 12, total: 12 });
  });

  it("lays the change over the run in the list too, without carrying a transcript there", () => {
    mount();
    fire({
      id: RUN,
      status: "needs_review",
      transcript: [{ ts: "t", tool: "x", by: "host", output_summary: "s", ok: true }],
    });
    expect(cachedList()?.[0]?.status).toBe("needs_review");
    expect(cachedList()?.[0]?.transcript).toEqual([]);
    expect(cachedList()?.[0]?.cart_snapshot).toEqual({
      summary: "kept summary",
      handoffUrl: "https://example.test/checkout",
    });
  });

  it("refetches the run's lines when the status moved, and not for a heartbeat or progress update", () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    mount();
    fire({ id: RUN, status: "running", heartbeat_at: "2026-10-31T16:00:30.000Z" });
    fire({ id: RUN, status: "running", progress: { phase: "searching", done: 4, total: 12 } });
    expect(spy).not.toHaveBeenCalled();
    fire({ id: RUN, status: "needs_review" });
    expect(spy).toHaveBeenCalledWith({ queryKey: shoppingRunItemsKey(HOUSEHOLD, RUN) });
  });

  it("adds a run it has not seen to the front of the list and fetches its lines", () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    mount();
    fire(
      {
        id: OTHER_RUN,
        household_id: HOUSEHOLD,
        status: "queued",
        trigger: "scheduled",
        subtotal_usd: null,
        transcript: [],
      },
      "INSERT",
    );
    expect(cachedList()?.map((r) => r.id)).toEqual([OTHER_RUN, RUN]);
    expect(cachedList()?.[0]?.trigger).toBe("scheduled");
    expect(
      queryClient.getQueryData<ShoppingRun | null>(shoppingRunKey(HOUSEHOLD, OTHER_RUN))?.status,
    ).toBe("queued");
    expect(spy).toHaveBeenCalledWith({ queryKey: shoppingRunItemsKey(HOUSEHOLD, OTHER_RUN) });
  });

  it("refetches the list when a payload carries no run", () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    mount();
    fire(undefined, "DELETE");
    expect(spy).toHaveBeenCalledWith({ queryKey: shoppingRunsKey(HOUSEHOLD) });
  });
});
