// The History screen (WS12), rendered to markup with react-native stood in by
// src/testing/reactNativeStub.tsx and the data hooks mocked: what each tab shows for given data,
// the documented empty state, and what the pin toggle calls. See renderScreen.ts for what that can
// and cannot reach (one render, no effects).
import type { MealsCookedWeek, MostBoughtRow, SpendWeekRow } from "@mp/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HistoryRoute from "../../../app/(app)/history/index";
import { type RenderedScreen, renderScreen } from "../../testing/renderScreen";
import { NO_ORDERS_MESSAGE } from "./parts";

type Query<T> = { data: T | undefined; isPending: boolean; isError: boolean; refetch: () => void };

const h = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  router: { push: vi.fn() },
  meals: undefined as unknown,
  spend: undefined as unknown,
  orders: undefined as unknown,
  bought: undefined as unknown,
  pin: { mutate: vi.fn(), isPending: false, error: null as unknown },
}));

vi.mock("react-native", () => import("../../testing/reactNativeStub"));
vi.mock("react-native-safe-area-context", async () => {
  const { View } = await import("../../testing/reactNativeStub");
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  };
});
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => h.params,
  useRouter: () => h.router,
}));
vi.mock("@mp/db", () => ({
  useMealsCooked: () => h.meals,
  useSpendWeekly: () => h.spend,
  useOrders: () => h.orders,
  useMostBought: () => h.bought,
  usePinProduct: () => h.pin,
  orderErrorMessage: () => "Something went wrong. Try again.",
}));
// The follow-up banner has its own test; here it must not ask about anything.
vi.mock("./OrderPromptBanner", () => ({ OrderPromptBanner: () => null }));

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const ok = <T,>(data: T): Query<T> => ({
  data,
  isPending: false,
  isError: false,
  refetch: vi.fn(),
});
const pending = (): Query<never> => ({
  data: undefined,
  isPending: true,
  isError: false,
  refetch: vi.fn(),
});
const failed = (): Query<never> => ({
  data: undefined,
  isPending: false,
  isError: true,
  refetch: vi.fn(),
});

/** A date in the current device week, so "this week" is what the fixtures say it is. */
function thisMonday(): string {
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
}

const cookedWeek: MealsCookedWeek = {
  household_id: HOUSEHOLD,
  week_start: thisMonday(),
  cooked_count: 2,
  entries: [
    {
      id: uuid(1),
      date: thisMonday(),
      slot: "dinner",
      recipe_id: uuid(11),
      title: "Lemon chicken",
    },
    { id: uuid(2), date: thisMonday(), slot: "lunch", recipe_id: uuid(12), title: null },
  ],
};

const spendRows: SpendWeekRow[] = [
  {
    household_id: HOUSEHOLD,
    week_start: thisMonday(),
    retailer: "kroger",
    store_name: "Mock QFC Duvall",
    total_usd: 100,
    order_count: 1,
  },
  {
    household_id: HOUSEHOLD,
    week_start: thisMonday(),
    retailer: "kroger",
    store_name: "Mock QFC Redmond",
    total_usd: 65.5,
    order_count: 2,
  },
];

const order = {
  id: uuid(30),
  household_id: HOUSEHOLD,
  run_id: uuid(31),
  retailer: "kroger",
  retailer_order_id: null,
  modality: "pickup",
  slot_start: null,
  slot_end: null,
  total_usd: 100,
  status: "confirmed",
  confirmed_by: null,
  confirmed_at: new Date().toISOString(),
  notes: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  store_name: "Mock QFC Duvall",
};

const product = (n: number, over: Partial<MostBoughtRow> = {}): MostBoughtRow => ({
  household_id: HOUSEHOLD,
  retailer: "kroger",
  store_id: "MOCK0001",
  store_name: "Mock QFC Duvall",
  ingredient_id: uuid(40 + n),
  product_id: `P-${n}`,
  upc: null,
  product_name: `Product ${n}`,
  size: "1 gal",
  times_bought: 5 - n,
  units_bought: 5 - n,
  last_bought_at: "2026-11-09T09:00:00+00:00",
  pinned: false,
  ...over,
});

/** The stub's state type has no `checked`; a switch carries it all the same. */
const checked = (screen: RenderedScreen, testID: string) =>
  (screen.props(testID).accessibilityState as { checked?: boolean } | undefined)?.checked;

function show(tab?: string): RenderedScreen {
  h.params = tab ? { tab } : {};
  return renderScreen(<HistoryRoute />);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.meals = ok<MealsCookedWeek[]>([]);
  h.spend = ok<SpendWeekRow[]>([]);
  h.orders = ok([]);
  h.bought = ok<MostBoughtRow[]>([]);
  h.pin.error = null;
  h.pin.isPending = false;
});

describe("the tabs", () => {
  it("shows Meals, Spend and Most bought, and opens on Meals", () => {
    const screen = show();
    expect(screen.has("history-tab-meals")).toBe(true);
    expect(screen.has("history-tab-spend")).toBe(true);
    expect(screen.has("history-tab-bought")).toBe(true);
    expect(screen.props("history-tab-meals").accessibilityState?.selected).toBe(true);
    expect(screen.has("history-panel-meals")).toBe(true);
  });

  it("opens on the tab a ?tab= parameter names, and on Meals for anything else", () => {
    expect(show("spend").has("history-panel-spend")).toBe(true);
    expect(show("bought").has("history-panel-bought")).toBe(true);
    expect(show("nonsense").has("history-panel-meals")).toBe(true);
  });
});

describe("Meals", () => {
  it("shows the cooked meals by day, with this week's count and the streak", () => {
    h.meals = ok([cookedWeek]);
    const screen = show("meals");
    expect(screen.has("meals-tab")).toBe(true);
    expect(screen.html).toContain("Lemon chicken");
    expect(screen.html).toContain("Cooked this week");
    expect(screen.has(`meals-week-${thisMonday()}`)).toBe(true);
    expect(screen.has(`meal-${uuid(1)}`)).toBe(true);
    // A recipe that is gone still gets a row, not a hole.
    expect(screen.html).toContain("Recipe unavailable");
    expect(screen.html).toContain("This week");
  });

  it("says what to do when nothing is cooked", () => {
    const screen = show("meals");
    expect(screen.has("meals-empty")).toBe(true);
    expect(screen.html).toContain("Mark a meal as cooked");
  });

  it("shows a spinner while loading and an error with a retry when it fails", () => {
    h.meals = pending();
    expect(show("meals").has("history-loading")).toBe(true);
    h.meals = failed();
    const screen = show("meals");
    expect(screen.has("history-error")).toBe(true);
    expect(screen.html).toContain("Could not load your cooked meals.");
  });
});

describe("Spend", () => {
  it("shows the week's total, a bar per store, and the orders", () => {
    h.spend = ok(spendRows);
    h.orders = ok([order]);
    const screen = show("spend");
    expect(screen.has("spend-tab")).toBe(true);
    expect(screen.html).toContain("$165.50");
    expect(screen.has(`spend-week-${thisMonday()}`)).toBe(true);
    expect(screen.html).toContain("Mock QFC Duvall");
    expect(screen.html).toContain("Mock QFC Redmond");
    expect(screen.html).toContain("2 orders");
    expect(screen.has(`order-row-${order.id}`)).toBe(true);
  });

  it("lists the biggest store of a week first", () => {
    h.spend = ok([...spendRows].reverse());
    h.orders = ok([]);
    const { ids } = show("spend");
    const stores = ids.filter((id) => id.startsWith(`spend-${thisMonday()}-`));
    expect(stores[0]).toContain("Duvall");
    expect(stores[1]).toContain("Redmond");
  });

  it("opens an order when its row is tapped", () => {
    h.spend = ok(spendRows);
    h.orders = ok([order]);
    show("spend").press(`order-row-${order.id}`);
    expect(h.router.push).toHaveBeenCalledWith(`/history/orders/${order.id}`);
  });

  it("marks a cancelled order and keeps it out of the bars' story", () => {
    h.spend = ok(spendRows);
    h.orders = ok([{ ...order, status: "cancelled" }]);
    const screen = show("spend");
    expect(screen.html).toContain("Cancelled");
  });

  it("shows the documented empty state when there are no orders", () => {
    const screen = show("spend");
    expect(screen.has("spend-empty")).toBe(true);
    expect(screen.html).toContain(NO_ORDERS_MESSAGE);
    expect(NO_ORDERS_MESSAGE).toBe(
      "Orders appear here after you confirm a shopping run. Stores do not share order history with apps yet.",
    );
  });

  it("shows an error with a retry when a query fails", () => {
    h.spend = failed();
    expect(show("spend").has("history-error")).toBe(true);
  });
});

describe("Most bought", () => {
  it("lists the products with how many times, the store, and a pin toggle", () => {
    h.bought = ok([product(1), product(2, { pinned: true })]);
    const screen = show("bought");
    expect(screen.has("bought-tab")).toBe(true);
    expect(screen.html).toContain("Product 1");
    expect(screen.html).toContain("Bought 4 times");
    expect(screen.html).toContain("Mock QFC Duvall");
    expect(checked(screen, "pin-P-1")).toBe(false);
    expect(checked(screen, "pin-P-2")).toBe(true);
    expect(screen.props("pin-P-2").accessibilityLabel).toBe("Unpin Product 2");
  });

  it("never shows a price", () => {
    h.bought = ok([product(1)]);
    expect(show("bought").html).not.toMatch(/\$\d/);
  });

  it("pins an unpinned product and unpins a pinned one", () => {
    const one = product(1);
    const two = product(2, { pinned: true });
    h.bought = ok([one, two]);
    const screen = show("bought");
    screen.press("pin-P-1");
    expect(h.pin.mutate).toHaveBeenLastCalledWith({ row: one, pinned: true });
    screen.press("pin-P-2");
    expect(h.pin.mutate).toHaveBeenLastCalledWith({ row: two, pinned: false });
  });

  it("offers no toggle for a line typed in by hand, which has no ingredient to pin to", () => {
    h.bought = ok([product(1, { ingredient_id: null })]);
    const screen = show("bought");
    expect(screen.has("bought-P-1")).toBe(true);
    expect(screen.has("pin-P-1")).toBe(false);
  });

  it("shows the documented empty state when there is nothing", () => {
    const screen = show("bought");
    expect(screen.has("bought-empty")).toBe(true);
    expect(screen.html).toContain(NO_ORDERS_MESSAGE);
  });

  it("shows a refused pin in words", () => {
    h.bought = ok([product(1)]);
    h.pin.error = new Error("x");
    expect(show("bought").html).toContain("Something went wrong. Try again.");
  });
});
