// The in-app follow-up to "Did you place this order?" (WS12): it waits two hours, stops after a
// week, skips a run that has an order, and "Not now" hides it on this device.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { kvStorage } from "../../lib/storage";
import { renderScreen } from "../../testing/renderScreen";
import { OrderPromptBanner } from "./OrderPromptBanner";
import { readDismissed } from "./promptDismissals";

const h = vi.hoisted(() => ({
  runs: { data: undefined as unknown },
  orders: { data: undefined as unknown },
  runForOrder: { data: undefined as unknown },
  asked: [] as unknown[],
}));

vi.mock("react-native", () => import("../../testing/reactNativeStub"));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock("../shopping/useShoppingRun", () => ({ useShoppingRuns: () => h.runs }));
vi.mock("@mp/db", () => ({
  useOrders: () => h.orders,
  useRunForOrder: (runId: unknown) => {
    h.asked.push(runId);
    return h.runForOrder;
  },
  useConfirmOrder: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null }),
  orderErrorMessage: () => "",
}));

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const run = (id: string, hours: number, over: Record<string, unknown> = {}) => ({
  id,
  status: "cart_ready",
  retailer: "kroger",
  store_name: "Mock QFC Duvall",
  approved_at: hoursAgo(hours + 1),
  finished_at: hoursAgo(hours),
  created_at: hoursAgo(hours + 2),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  kvStorage.removeItem("mp-order-prompt-dismissed");
  h.asked = [];
  h.runs = { data: [run("r1", 3)] };
  h.orders = { data: [] };
  h.runForOrder = {
    data: {
      id: "r1",
      status: "cart_ready",
      retailer: "kroger",
      store_name: "Mock QFC Duvall",
      subtotal_usd: 98,
      approved_at: hoursAgo(4),
      finished_at: hoursAgo(3),
      modality: "pickup",
    },
  };
});

describe("the follow-up banner", () => {
  it("asks about a cart that has been ready for two hours or more", () => {
    const screen = renderScreen(<OrderPromptBanner />);
    expect(screen.has("order-banner")).toBe(true);
    expect(screen.html).toContain("Did you place your Mock QFC Duvall order?");
    expect(screen.html).toContain("Your cart was ready 3 hours ago.");
    expect(h.asked).toContain("r1");
  });

  it("waits until the two hours are up", () => {
    h.runs = { data: [run("r1", 1)] };
    expect(renderScreen(<OrderPromptBanner />).has("order-banner")).toBe(false);
  });

  it("stops asking after a week", () => {
    h.runs = { data: [run("r1", 24 * 8)] };
    expect(renderScreen(<OrderPromptBanner />).has("order-banner")).toBe(false);
  });

  it("does not ask about a run that already has an order", () => {
    h.orders = { data: [{ run_id: "r1" }] };
    expect(renderScreen(<OrderPromptBanner />).has("order-banner")).toBe(false);
  });

  it("says nothing until both the runs and the orders are known", () => {
    h.orders = { data: undefined };
    expect(renderScreen(<OrderPromptBanner />).has("order-banner")).toBe(false);
    h.orders = { data: [] };
    h.runs = { data: undefined };
    expect(renderScreen(<OrderPromptBanner />).has("order-banner")).toBe(false);
  });

  it("ignores runs that are not ready, or were never approved", () => {
    h.runs = {
      data: [run("a", 3, { status: "running" }), run("b", 3, { approved_at: null })],
    };
    expect(renderScreen(<OrderPromptBanner />).has("order-banner")).toBe(false);
  });

  it("hides on this device when 'Not now' is tapped, and stays hidden for that run", () => {
    const screen = renderScreen(<OrderPromptBanner />);
    screen.press("order-banner-dismiss");
    expect(readDismissed(kvStorage)).toEqual(["r1"]);
    expect(renderScreen(<OrderPromptBanner />).has("order-banner")).toBe(false);
  });

  it("asks about the next run once one is dismissed", () => {
    h.runs = { data: [run("older", 30), run("newer", 3)] };
    renderScreen(<OrderPromptBanner />).press("order-banner-dismiss");
    expect(readDismissed(kvStorage)).toEqual(["newer"]);
    h.asked = [];
    expect(renderScreen(<OrderPromptBanner />).has("order-banner")).toBe(true);
    expect(h.asked).toContain("older");
  });

  it("holds its 'Yes' button until the run's details are in", () => {
    h.runForOrder = { data: undefined };
    const screen = renderScreen(<OrderPromptBanner />);
    expect(
      screen.props("order-banner-yes").disabled ||
        screen.props("order-banner-yes").accessibilityState?.disabled,
    ).toBeTruthy();
  });

  it("opens the confirmation sheet when the run's details are in", () => {
    const screen = renderScreen(<OrderPromptBanner />);
    expect(screen.props("order-banner-yes").accessibilityState?.disabled).toBeFalsy();
  });
});
