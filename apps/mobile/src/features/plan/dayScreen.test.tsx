// The day screen in the two plan modes (WS04 follow-up: simple mode): Just dinners draws the dinner
// slot, Every meal draws all four, and a meal in a slot the mode does not draw waits under a
// collapsed "More meals" row. Rendered to markup with react-native stood in by src/testing.
import { MEAL_SLOTS } from "@mp/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DayScreen from "../../../app/(app)/plan/[date]";
import { byDay, planEntry } from "../../testing/planEntries";
import { type RenderedScreen, renderScreen } from "../../testing/renderScreen";

const h = vi.hoisted(() => ({
  params: { date: "2026-11-03" } as Record<string, string>,
  mode: "simple" as "simple" | "full",
  router: { push: vi.fn(), replace: vi.fn(), setParams: vi.fn(), back: vi.fn() },
  week: {
    householdId: "h1" as string | null,
    noHousehold: false,
    loading: false,
    weekLoading: false,
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
vi.mock("@mp/db", () => ({
  usePlanMode: () => h.mode,
  useRecipeImageUrl: () => null,
}));
vi.mock("./usePlanWeek", () => ({ usePlanWeek: () => h.week }));
vi.mock("./usePlanActions", () => ({ usePlanActions: () => ({}) }));
vi.mock("./EntrySheet", () => ({ EntrySheet: () => null }));
vi.mock("./PlanNotice", () => ({ PlanNoticeBar: () => null, SyncStatus: () => null }));

const DAY = "2026-11-03";
const dinner = planEntry("d1", DAY, "dinner", "Lemon chicken");
const lunch = planEntry("l1", DAY, "lunch", "Leftover soup");
const snack = planEntry("s1", DAY, "snack", "Apple slices");

function show(mode: "simple" | "full", entries: ReturnType<typeof planEntry>[] = []) {
  h.mode = mode;
  h.week.entries = entries;
  h.week.byDay = byDay(entries);
  return renderScreen(<DayScreen />);
}

/** The slot sections on screen, in order. */
const slotsShown = (screen: RenderedScreen) =>
  screen.ids.filter((id) => id.startsWith("day-slot-")).map((id) => id.replace("day-slot-", ""));

beforeEach(() => {
  vi.clearAllMocks();
  h.params = { date: DAY };
  h.week.noHousehold = false;
  h.week.loading = false;
  h.week.weekLoading = false;
});

describe("the slots the day screen draws", () => {
  it("is the dinner slot alone in Just dinners mode", () => {
    const screen = show("simple");
    expect(slotsShown(screen)).toEqual(["dinner"]);
    expect(screen.props(`add-${DAY}-dinner`).accessibilityLabel).toBe("Add dinner");
    for (const other of ["breakfast", "lunch", "snack"]) {
      expect(screen.has(`add-${DAY}-${other}`)).toBe(false);
    }
  });

  it("is all four, in the order a day reads, in Every meal mode", () => {
    const screen = show("full");
    expect(slotsShown(screen)).toEqual([...MEAL_SLOTS]);
  });

  it("adds a dinner for the day from the dinner slot", () => {
    const screen = show("simple");
    screen.press(`add-${DAY}-dinner`);
    expect(h.router.push).toHaveBeenCalledWith("/plan/pick?date=2026-11-03&slot=dinner");
  });

  it("shows a planned dinner as a card", () => {
    const screen = show("simple", [dinner]);
    expect(screen.has("entry-d1")).toBe(true);
    expect(screen.props(`add-${DAY}-dinner`).accessibilityLabel).toBe("Add another recipe");
  });
});

describe("the More meals row", () => {
  it("appears when the day has meals outside dinner, collapsed, with their count", () => {
    const screen = show("simple", [dinner, lunch, snack]);
    expect(screen.has(`more-meals-${DAY}`)).toBe(true);
    expect(screen.props(`more-meals-toggle-${DAY}`).accessibilityLabel).toBe(
      "2 more meals on Tuesday",
    );
    expect(screen.props(`more-meals-toggle-${DAY}`)["aria-expanded"]).toBe(false);
    // Collapsed: not hidden for good, just not drawn until opened. The dinner is unaffected.
    expect(screen.has(`more-meals-list-${DAY}`)).toBe(false);
    expect(screen.has("entry-l1")).toBe(false);
    expect(screen.has("entry-d1")).toBe(true);
  });

  it("does not appear for a day of dinners, or an empty day", () => {
    expect(show("simple", [dinner]).has(`more-meals-${DAY}`)).toBe(false);
    expect(show("simple").has(`more-meals-${DAY}`)).toBe(false);
  });

  it("does not appear for another day's meals", () => {
    const other = planEntry("l2", "2026-11-04", "lunch", "Salad");
    expect(show("simple", [other]).has(`more-meals-${DAY}`)).toBe(false);
  });

  it("does not appear in Every meal mode, where those meals have their own slots", () => {
    const screen = show("full", [dinner, lunch, snack]);
    expect(screen.has(`more-meals-${DAY}`)).toBe(false);
    expect(screen.has("entry-l1")).toBe(true);
    expect(screen.has("entry-s1")).toBe(true);
  });

  it("sits above the link back to the week", () => {
    const { ids } = show("simple", [lunch]);
    expect(ids.indexOf(`more-meals-${DAY}`)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(`more-meals-${DAY}`)).toBeLessThan(ids.indexOf("back-to-week"));
  });

  it("is not drawn while the week is still loading", () => {
    h.week.weekLoading = true;
    expect(show("simple", [lunch]).has(`more-meals-${DAY}`)).toBe(false);
  });
});

describe("other states", () => {
  it("sends a person with no household to create one", () => {
    h.week.noHousehold = true;
    expect(show("simple").has("redirect")).toBe(true);
  });

  it("sends a day that is not a date back to the plan", () => {
    h.params = { date: "someday" };
    expect(show("simple").props("redirect").href).toBe("/plan");
  });
});
