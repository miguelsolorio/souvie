// The dev-only AI cost screen (WS15): the views as tables, their numbers formatted, and the route
// gated to development builds.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderScreen } from "../testing/renderScreen";
import {
  type AiCosts,
  fetchAiCosts,
  formatLatency,
  formatPercent,
  formatSilence,
  formatUsd,
  totalsByDay,
} from "./aiCosts";

vi.mock("react-native", () => import("../testing/reactNativeStub"));
vi.mock("react-native-safe-area-context", async () => {
  const { View } = await import("../testing/reactNativeStub");
  return { SafeAreaView: View };
});

const h = vi.hoisted(() => ({
  costs: {
    data: undefined as unknown,
    isPending: false,
    isError: false,
    error: null as Error | null,
  },
}));
vi.mock("@mp/db", () => ({
  useHousehold: () => ({ data: { id: "h1" } }),
  useSupabase: () => ({}),
}));
vi.mock("expo-router", async () => {
  const { createElement } = await import("react");
  const { View } = await import("../testing/reactNativeStub");
  return {
    Redirect: ({ href }: { href: string }) => createElement(View, { testID: "redirect", href }),
  };
});
vi.mock("../features/auth/SessionGuard", () => ({
  SessionGuard: ({ children }: { children: unknown }) => children,
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => h.costs }));

import AiCostsScreen from "../../app/(dev)/ai-costs";
import { AiCostTables } from "./AiCostTables";

const COSTS: AiCosts = {
  daily: [
    {
      household_id: "h1",
      day: "2026-10-31",
      kind: "agent_step",
      model: "claude-sonnet-5-5",
      cost_usd: 0.0123,
      calls: 4,
    },
    {
      household_id: "h1",
      day: "2026-10-31",
      kind: "parse_ingredients",
      model: "claude-haiku-5-5",
      cost_usd: 0.0007,
      calls: 3,
    },
    {
      household_id: "h1",
      day: "2026-10-30",
      kind: "suggest",
      model: "claude-sonnet-5-5",
      cost_usd: 0.05,
      calls: 1,
    },
  ],
  byPrompt: [
    { prompt_version: "agent-system.v1", calls: 4, avg_latency_ms: 2750.4, error_rate: 0.25 },
    { prompt_version: null, calls: 1, avg_latency_ms: null, error_rate: null },
  ],
  stalled: [],
};

describe("formatting", () => {
  it("shows dollars to four places, percents to one, and a missing number as n/a", () => {
    expect(formatUsd(0.0123)).toBe("$0.0123");
    expect(formatUsd(0)).toBe("$0.0000");
    expect(formatPercent(0.0833)).toBe("8.3%");
    expect(formatPercent(null)).toBe("n/a");
    expect(formatLatency(2750.4)).toBe("2750 ms");
    expect(formatLatency(null)).toBe("n/a");
    expect(formatSilence(660)).toBe("11 min");
    expect(formatSilence(3 * 3600 + 5 * 60)).toBe("3 h 5 min");
  });

  it("totals the daily rows per day, newest first", () => {
    const totals = totalsByDay(COSTS.daily);
    expect(totals.map((t) => t.day)).toEqual(["2026-10-31", "2026-10-30"]);
    expect(totals[0]?.costUsd).toBeCloseTo(0.013, 6);
    expect(totals[0]?.calls).toBe(7);
  });
});

describe("AiCostTables", () => {
  it("renders spend per day, the prompt table and the empty stalled list", () => {
    const screen = renderScreen(<AiCostTables costs={COSTS} />);
    expect(screen.has("day-2026-10-31")).toBe(true);
    expect(screen.html).toContain("$0.0130");
    expect(screen.html).toContain("agent-system.v1");
    expect(screen.html).toContain("25.0%");
    expect(screen.html).toContain("(none)");
    expect(screen.has("no-stalled")).toBe(true);
  });

  it("lists a run with no heartbeat", () => {
    const run = {
      run_id: "5a000000-0000-4000-8000-0000000000a1",
      household_id: "h1",
      retailer: "kroger",
      status: "running",
      silent_seconds: 780,
    };
    const screen = renderScreen(<AiCostTables costs={{ ...COSTS, stalled: [run] }} />);
    expect(screen.has("stalled-5a000000-0000-4000-8000-0000000000a1")).toBe(true);
    expect(screen.html).toContain("13 min");
    expect(screen.has("no-stalled")).toBe(false);
  });

  it("says so when there are no calls yet", () => {
    const screen = renderScreen(<AiCostTables costs={{ daily: [], byPrompt: [], stalled: [] }} />);
    expect(screen.html).toContain("No model calls yet.");
  });
});

describe("the route", () => {
  beforeEach(() => {
    h.costs = { data: COSTS, isPending: false, isError: false, error: null };
  });

  it("shows the tables in a development build", () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    const screen = renderScreen(<AiCostsScreen />);
    expect(screen.html).toContain("AI costs");
    expect(screen.has("day-2026-10-31")).toBe(true);
  });

  it("sends a release build home", () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
    const screen = renderScreen(<AiCostsScreen />);
    expect(screen.has("redirect")).toBe(true);
    expect(screen.html).not.toContain("AI costs");
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
  });

  it("shows the error when the views cannot be read", () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    h.costs = {
      data: undefined,
      isPending: false,
      isError: true,
      error: new Error("v_ai_cost_daily: permission denied"),
    };
    const screen = renderScreen(<AiCostsScreen />);
    expect(screen.html).toContain("permission denied");
  });
});

describe("fetchAiCosts", () => {
  function fakeClient(rows: Record<string, unknown[] | { error: string }>) {
    const calls: Array<{
      view: string;
      columns: string;
      order: string;
      ascending: boolean;
      limit: number;
    }> = [];
    const client = {
      from: (view: string) => ({
        select: (columns: string) => ({
          order: (order: string, options: { ascending: boolean }) => ({
            limit: async (limit: number) => {
              calls.push({ view, columns, order, ascending: options.ascending, limit });
              const result = rows[view];
              return !result || Array.isArray(result)
                ? { data: result ?? [], error: null }
                : { data: null, error: { message: result.error } };
            },
          }),
        }),
      }),
    };
    return { client: client as never, calls };
  }

  it("reads the three views and turns numeric strings into numbers", async () => {
    const { client, calls } = fakeClient({
      v_ai_cost_daily: [
        {
          household_id: "h1",
          day: "2026-10-31",
          kind: "agent_step",
          model: "m",
          cost_usd: "0.0123",
          calls: "4",
        },
      ],
      v_ai_cost_by_prompt: [
        { prompt_version: "a.v1", calls: 2, avg_latency_ms: "100.5", error_rate: "0.5000" },
      ],
      v_runs_stalled: [
        {
          run_id: "r1",
          household_id: "h1",
          retailer: "kroger",
          status: "running",
          silent_seconds: "700",
        },
      ],
    });
    const costs = await fetchAiCosts(client);
    expect(costs.daily[0]).toMatchObject({ cost_usd: 0.0123, calls: 4 });
    expect(costs.byPrompt[0]).toMatchObject({ avg_latency_ms: 100.5, error_rate: 0.5 });
    expect(costs.stalled[0]?.silent_seconds).toBe(700);
    expect(calls.map((c) => c.view).sort()).toEqual([
      "v_ai_cost_by_prompt",
      "v_ai_cost_daily",
      "v_runs_stalled",
    ]);
    expect(calls.find((c) => c.view === "v_ai_cost_daily")).toMatchObject({
      order: "day",
      ascending: false,
    });
  });

  it("names the view that failed", async () => {
    const { client } = fakeClient({ v_ai_cost_daily: { error: "permission denied" } });
    await expect(fetchAiCosts(client)).rejects.toThrow("v_ai_cost_daily: permission denied");
  });
});
