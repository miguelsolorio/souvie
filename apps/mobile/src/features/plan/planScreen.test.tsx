// The week view in the two plan modes (WS04 follow-up: simple mode): which cells it draws, what its
// empty state says, and that "Generate list" does not depend on the mode. Rendered to markup with
// react-native stood in by src/testing. The grid itself is covered in WeekGrid.test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PlanScreen from "../../../app/(app)/plan/index";
import { byDay, planEntry } from "../../testing/planEntries";
import { renderScreen } from "../../testing/renderScreen";
import { GROCERY_LIST_ROUTE } from "./routes";

const h = vi.hoisted(() => ({
  params: { week: "2026-11-02" } as Record<string, string>,
  mode: "simple" as "simple" | "full",
  router: { push: vi.fn(), replace: vi.fn(), setParams: vi.fn(), back: vi.fn() },
  week: {
    householdId: "h1" as string | null,
    noHousehold: false,
    loading: false,
    weekLoading: false,
    offline: false,
    error: false,
    staleCopy: false,
    refreshing: false,
    refetch: vi.fn(),
    entries: [] as unknown[],
    byDay: {} as Record<string, unknown>,
  },
}));

vi.mock("react-native", async () => ({
  ...(await import("../../testing/reactNativeStub")),
  RefreshControl: () => null,
}));
vi.mock("react-native-safe-area-context", async () => {
  const { View } = await import("../../testing/reactNativeStub");
  return { SafeAreaView: View };
});
vi.mock("expo-router", async () => {
  const { createElement } = await import("react");
  const { View } = await import("../../testing/reactNativeStub");
  return {
    Redirect: ({ href }: { href: string }) => createElement(View, { testID: "redirect", href }),
    Stack: { Screen: () => null },
    useLocalSearchParams: () => h.params,
    useRouter: () => h.router,
  };
});
vi.mock("@mp/db", () => ({ usePlanMode: () => h.mode }));
vi.mock("./usePlanWeek", () => ({ usePlanWeek: () => h.week }));
vi.mock("./usePlanActions", () => ({ usePlanActions: () => ({}) }));
vi.mock("./EntrySheet", () => ({ EntrySheet: () => null }));
vi.mock("./PlanNotice", () => ({ PlanNoticeBar: () => null, SyncStatus: () => null }));

function show(mode: "simple" | "full", entries: ReturnType<typeof planEntry>[] = []) {
  h.mode = mode;
  h.week.entries = entries;
  h.week.byDay = byDay(entries);
  return renderScreen(<PlanScreen />);
}

const cellCount = (ids: string[]) => ids.filter((id) => /^slot-\d{4}-/.test(id)).length;

beforeEach(() => {
  vi.clearAllMocks();
  // Wednesday 4 November 2026, so "this week" is the one the tests open.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 4, 12, 0, 0));
  h.params = { week: "2026-11-02" };
  h.week.noHousehold = false;
  h.week.loading = false;
  h.week.weekLoading = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the week view", () => {
  it("draws one dinner cell a day in Just dinners mode", () => {
    const screen = show("simple");
    expect(cellCount(screen.ids)).toBe(7);
    expect(screen.has("slot-2026-11-04-dinner")).toBe(true);
    expect(screen.has("slot-2026-11-04-lunch")).toBe(false);
  });

  it("draws four cells a day in Every meal mode", () => {
    const screen = show("full");
    expect(cellCount(screen.ids)).toBe(28);
    expect(screen.has("slot-2026-11-04-lunch")).toBe(true);
  });

  it("asks for a dinner in an empty week in Just dinners mode, and opens the picker for dinner", () => {
    const screen = show("simple");
    expect(screen.has("plan-empty")).toBe(true);
    expect(screen.html).toContain("Pick a day below and add a dinner.");
    screen.press("plan-first-dinner");
    expect(h.router.push).toHaveBeenCalledWith("/plan/pick?date=2026-11-04&slot=dinner");
  });

  it("asks for a recipe in an empty week in Every meal mode", () => {
    const screen = show("full");
    expect(screen.html).toContain("Pick a day below and add a recipe.");
    expect(screen.html).not.toContain("add a dinner");
  });

  it("adds from a dinner cell with the dinner slot", () => {
    show("simple").press("add-2026-11-05-dinner");
    expect(h.router.push).toHaveBeenCalledWith("/plan/pick?date=2026-11-05&slot=dinner");
  });

  it("keeps a lunch left from Every meal mode under More meals, and the week is not empty", () => {
    const lunch = planEntry("l1", "2026-11-03", "lunch", "Leftover soup");
    const screen = show("simple", [lunch]);
    expect(screen.has("more-meals-2026-11-03")).toBe(true);
    expect(screen.has("plan-empty")).toBe(false);
    expect(cellCount(screen.ids)).toBe(7);
  });

  it("generates the list for the whole week, in either mode", () => {
    const lunch = planEntry("l1", "2026-11-03", "lunch", "Leftover soup");
    for (const mode of ["simple", "full"] as const) {
      h.router.push.mockClear();
      const screen = show(mode, [lunch]);
      expect(screen.props("generate-list").disabled).toBeFalsy();
      screen.press("generate-list");
      expect(h.router.push).toHaveBeenCalledWith(GROCERY_LIST_ROUTE);
    }
  });
});

describe("other states", () => {
  it("sends a person with no household to create one", () => {
    h.week.noHousehold = true;
    expect(show("simple").has("redirect")).toBe(true);
  });

  it("shows a loading screen, not an empty grid, while the household loads", () => {
    h.week.loading = true;
    expect(show("simple").has("week-grid")).toBe(false);
  });
});
