// One order's screen (WS12), rendered with react-native stood in and the hooks mocked: what it
// shows for given data and what its buttons send. One render, no effects (see renderScreen.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";
import OrderRoute from "../../../app/(app)/history/orders/[id]";
import { renderScreen } from "../../testing/renderScreen";

const ORDER = "52000000-0000-4000-8000-0000000000a1";

const h = vi.hoisted(() => ({
  params: { id: "52000000-0000-4000-8000-0000000000a1" },
  order: { data: undefined as unknown, isPending: false },
  lines: { data: [] as unknown[], isPending: false, isError: false },
  update: { mutate: vi.fn(), isPending: false, error: null as unknown, reset: vi.fn() },
  confirmAction: vi.fn(),
}));

vi.mock("react-native", () => import("../../testing/reactNativeStub"));
vi.mock("react-native-safe-area-context", async () => {
  const { View } = await import("../../testing/reactNativeStub");
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  };
});
vi.mock("expo-router", () => ({ useLocalSearchParams: () => h.params }));
vi.mock("@mp/db", () => ({
  useOrder: () => h.order,
  useOrderLines: () => h.lines,
  useUpdateOrder: () => h.update,
  arrivedStatus: (modality: string) => (modality === "delivery" ? "delivered" : "picked_up"),
  orderErrorMessage: () => "Something went wrong. Try again.",
}));
vi.mock("../../lib/confirm", () => ({ confirmAction: h.confirmAction }));

const local = (h24: number, min = 0) => new Date(2026, 10, 4, h24, min).toISOString();

const order = (over: Record<string, unknown> = {}) => ({
  id: ORDER,
  household_id: "0a000000-0000-4000-8000-00000000000a",
  run_id: "f2000000-0000-4000-8000-0000000000a1",
  retailer: "kroger",
  retailer_order_id: null,
  modality: "pickup",
  slot_start: null,
  slot_end: null,
  total_usd: 100,
  status: "confirmed",
  confirmed_by: null,
  confirmed_at: local(12),
  notes: null,
  created_at: local(12),
  updated_at: local(12),
  store_name: "Mock QFC Duvall",
  ...over,
});

const line = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  display_name: "Yellow onions",
  product_name: "Harbor Fields Yellow Onions",
  size: "3 lb bag",
  quantity: 2,
  unit_price_usd: 3.49,
  line_total_usd: 6.98,
  ...over,
});

function show(data: unknown) {
  h.order = { data, isPending: false };
  return renderScreen(<OrderRoute />);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.lines = { data: [], isPending: false, isError: false };
  h.update.isPending = false;
  h.update.error = null;
  h.confirmAction.mockResolvedValue(true);
});

describe("the order", () => {
  it("shows the store, the total, the status and how it is fulfilled", () => {
    const screen = show(order());
    expect(screen.html).toContain("Mock QFC Duvall");
    expect(screen.html).toContain("$100.00");
    expect(screen.html).toContain("Placed");
    expect(screen.html).toContain("Pickup");
    expect(screen.html).toContain("The total is what you entered.");
  });

  it("shows the window, the order number and the notes when there are some", () => {
    const screen = show(
      order({
        slot_start: local(16),
        slot_end: local(17),
        retailer_order_id: "KRG-0042",
        notes: "Left at the side door",
      }),
    );
    expect(screen.props("order-window").children).toBeDefined();
    expect(screen.html).toContain("Wed, Nov 4, 4:00 pm to 5:00 pm");
    expect(screen.html).toContain("KRG-0042");
    expect(screen.html).toContain("Left at the side door");
  });

  it("leaves out the window, order number and notes when there are none", () => {
    const screen = show(order());
    expect(screen.has("order-window")).toBe(false);
    expect(screen.has("order-number")).toBe(false);
    expect(screen.has("order-notes")).toBe(false);
  });

  it("says so when the order is not in the household", () => {
    const screen = show(null);
    expect(screen.has("order-missing")).toBe(true);
    expect(screen.html).toContain("This order is not in your household.");
  });
});

describe("the items", () => {
  it("lists what the cart held, in the retailer's own words, with the store's amounts", () => {
    h.lines = {
      data: [
        line("l1"),
        line("l2", {
          product_name: null,
          unit_price_usd: null,
          line_total_usd: null,
          size: null,
          quantity: 1,
        }),
      ],
      isPending: false,
      isError: false,
    };
    const screen = show(order());
    expect(screen.has("order-line-l1")).toBe(true);
    expect(screen.html).toContain("Harbor Fields Yellow Onions");
    expect(screen.html).toContain("3 lb bag");
    expect(screen.html).toContain("$3.49");
    expect(screen.html).toContain("$6.98");
    // A line with no product name falls back to the list line's name.
    expect(screen.html).toContain("Yellow onions");
    expect(screen.html).toContain("Prices are the store&#x27;s, before tax and fees.");
  });

  it("says when the items are no longer stored", () => {
    const screen = show(order());
    expect(screen.has("order-lines-empty")).toBe(true);
    expect(screen.html).toContain("The items for this order are no longer stored.");
  });

  it("does not claim they are gone while loading or after a failure", () => {
    h.lines = { data: [], isPending: true, isError: false };
    expect(show(order()).has("order-lines-empty")).toBe(false);
    h.lines = { data: [], isPending: false, isError: true };
    const screen = show(order());
    expect(screen.has("order-lines-empty")).toBe(false);
    expect(screen.html).toContain("Could not load the items.");
  });
});

describe("the actions", () => {
  it("marks a placed pickup as picked up", () => {
    const screen = show(order());
    expect(screen.props("order-arrived").accessibilityLabel).toBe("Mark as picked up");
    screen.press("order-arrived");
    expect(h.update.mutate).toHaveBeenCalledWith({ status: "picked_up" });
    expect(screen.has("order-restore")).toBe(false);
  });

  it("marks a placed delivery as delivered", () => {
    const screen = show(order({ modality: "delivery" }));
    expect(screen.props("order-arrived").accessibilityLabel).toBe("Mark as delivered");
    screen.press("order-arrived");
    expect(h.update.mutate).toHaveBeenCalledWith({ status: "delivered" });
  });

  it("undoes an arrival", () => {
    const screen = show(order({ status: "picked_up" }));
    expect(screen.has("order-arrived")).toBe(false);
    screen.press("order-restore");
    expect(h.update.mutate).toHaveBeenCalledWith({ status: "confirmed" });
  });

  it("asks before it cancels, says it does not touch the store, and then cancels", async () => {
    const screen = show(order());
    screen.press("order-cancel");
    expect(h.confirmAction).toHaveBeenCalledTimes(1);
    const asked = h.confirmAction.mock.calls[0]?.[0] as { message: string };
    expect(asked.message).toContain("does not cancel anything at the store");
    await Promise.resolve();
    await Promise.resolve();
    expect(h.update.mutate).toHaveBeenCalledWith({ status: "cancelled" });
  });

  it("does not cancel when the person says no", async () => {
    h.confirmAction.mockResolvedValue(false);
    show(order()).press("order-cancel");
    await Promise.resolve();
    await Promise.resolve();
    expect(h.update.mutate).not.toHaveBeenCalled();
  });

  it("restores a cancelled order and offers no second cancel", () => {
    const screen = show(order({ status: "cancelled" }));
    expect(screen.has("order-cancel")).toBe(false);
    expect(screen.props("order-restore").accessibilityLabel).toBe("Restore this order");
    screen.press("order-restore");
    expect(h.update.mutate).toHaveBeenCalledWith({ status: "confirmed" });
  });

  it("offers to edit the details", () => {
    expect(show(order()).has("order-edit")).toBe(true);
  });

  it("shows a refused change in words", () => {
    h.update.error = new Error("x");
    expect(show(order()).html).toContain("Something went wrong. Try again.");
  });
});
