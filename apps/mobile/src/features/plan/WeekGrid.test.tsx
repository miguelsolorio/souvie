// The week grid in the two plan modes (WS04 follow-up: simple mode). Rendered to markup with
// react-native stood in by src/testing/reactNativeStub.tsx, so these tests cover which cells the
// grid draws for given entries and what its buttons call. The grid is drawn twice: as day cards at
// a phone's width, and as seven columns at a desktop's.
import { MEAL_SLOTS, weekDates } from "@mp/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { byDay, planEntry } from "../../testing/planEntries";
import { type RenderedScreen, renderScreen } from "../../testing/renderScreen";
import { WeekGrid } from "./WeekGrid";

const h = vi.hoisted(() => ({ width: 390 }));

vi.mock("react-native", async () => ({
  ...(await import("../../testing/reactNativeStub")),
  useWindowDimensions: () => ({ width: h.width, height: 844, scale: 1, fontScale: 1 }),
}));

const WEEK = "2026-11-02";
const DAYS = weekDates(WEEK);
const TODAY = "2026-11-03";

const onAdd = vi.fn();
const onOpenEntry = vi.fn();
const onOpenDay = vi.fn();

function grid(mode: "simple" | "full", entries: ReturnType<typeof planEntry>[] = []) {
  return renderScreen(
    <WeekGrid
      weekStart={WEEK}
      mode={mode}
      byDay={byDay(entries)}
      today={TODAY}
      onAdd={onAdd}
      onOpenEntry={onOpenEntry}
      onOpenDay={onOpenDay}
    />,
  );
}

/** The slot cells drawn, as "date:slot", in the order they appear. */
const cells = (screen: RenderedScreen) =>
  screen.ids
    .filter((id) => id.startsWith("slot-2026"))
    .map((id) => id.replace(/^slot-/, ""))
    .map((id) => `${id.slice(0, 10)}:${id.slice(11)}`);

/** The days that have a "More meals" row. */
const moreMealsDays = (screen: RenderedScreen) =>
  screen.ids
    .filter((id) => id.startsWith("more-meals-2026"))
    .map((id) => id.replace("more-meals-", ""));

beforeEach(() => {
  vi.clearAllMocks();
  h.width = 390;
});

describe("on a phone", () => {
  it("draws one dinner cell a day in Just dinners mode", () => {
    const screen = grid("simple");
    expect(cells(screen)).toEqual(DAYS.map((date) => `${date}:dinner`));
    for (const date of DAYS) {
      expect(screen.has(`add-${date}-dinner`)).toBe(true);
      for (const other of ["breakfast", "lunch", "snack"]) {
        expect(screen.has(`slot-${date}-${other}`)).toBe(false);
        expect(screen.has(`add-${date}-${other}`)).toBe(false);
      }
    }
  });

  it("draws breakfast, lunch, dinner and snack for every day in Every meal mode", () => {
    const screen = grid("full");
    expect(cells(screen)).toEqual(
      DAYS.flatMap((date) => MEAL_SLOTS.map((slot) => `${date}:${slot}`)),
    );
    expect(cells(screen)).toHaveLength(28);
  });

  it("adds a dinner from the one cell", () => {
    const screen = grid("simple");
    screen.press("add-2026-11-04-dinner");
    expect(onAdd).toHaveBeenCalledWith("2026-11-04", "dinner");
  });

  it("shows a planned dinner in its cell and opens it", () => {
    const screen = grid("simple", [planEntry("e1", "2026-11-03", "dinner", "Lemon chicken")]);
    expect(screen.html).toContain("Lemon chicken");
    screen.press("entry-e1");
    expect(onOpenEntry).toHaveBeenCalledWith(expect.objectContaining({ id: "e1" }));
  });

  it("still opens a day from its header", () => {
    grid("simple").press("open-day-2026-11-05");
    expect(onOpenDay).toHaveBeenCalledWith("2026-11-05");
  });
});

describe("in seven columns", () => {
  beforeEach(() => {
    h.width = 1280;
  });

  it("draws one row, dinner, in Just dinners mode", () => {
    const screen = grid("simple");
    expect(screen.has("week-grid")).toBe(true);
    expect(screen.ids.filter((id) => id.startsWith("slot-row-"))).toEqual(["slot-row-dinner"]);
    expect(cells(screen)).toHaveLength(7);
  });

  it("draws four rows, in the order a day reads, in Every meal mode", () => {
    const screen = grid("full");
    expect(screen.ids.filter((id) => id.startsWith("slot-row-"))).toEqual([
      "slot-row-breakfast",
      "slot-row-lunch",
      "slot-row-dinner",
      "slot-row-snack",
    ]);
    expect(cells(screen)).toHaveLength(28);
  });

  it("adds a meal row only for a week that has meals outside the mode", () => {
    expect(grid("simple").has("more-meals-row")).toBe(false);
    const lunch = planEntry("e2", "2026-11-04", "lunch", "Leftover soup");
    const screen = grid("simple", [lunch]);
    expect(screen.has("more-meals-row")).toBe(true);
    expect(moreMealsDays(screen)).toEqual(["2026-11-04"]);
  });
});

describe("the More meals row", () => {
  const lunch = planEntry("e2", "2026-11-03", "lunch", "Leftover soup");
  const snack = planEntry("e3", "2026-11-03", "snack", "Apple slices");
  const breakfast = planEntry("e4", "2026-11-05", "breakfast", "Oatmeal");
  const dinner = planEntry("e1", "2026-11-03", "dinner", "Lemon chicken");

  it("appears for each day with a meal outside dinner, and only for those days", () => {
    const screen = grid("simple", [dinner, lunch, snack, breakfast]);
    expect(moreMealsDays(screen)).toEqual(["2026-11-03", "2026-11-05"]);
  });

  it("does not appear for a week of dinners", () => {
    const screen = grid("simple", [
      dinner,
      planEntry("e5", "2026-11-04", "dinner", "Tacos"),
      planEntry("e6", "2026-11-04", "dinner", "Rice", { position: 1 }),
    ]);
    expect(moreMealsDays(screen)).toEqual([]);
    expect(screen.html).not.toContain("More meals");
  });

  it("does not appear for an empty week", () => {
    expect(moreMealsDays(grid("simple"))).toEqual([]);
  });

  it("does not appear in Every meal mode: those meals have their own cells", () => {
    const screen = grid("full", [dinner, lunch, snack, breakfast]);
    expect(moreMealsDays(screen)).toEqual([]);
    expect(screen.html).not.toContain("More meals");
    expect(screen.html).toContain("Leftover soup");
    expect(screen.html).toContain("Apple slices");
    expect(screen.html).toContain("Oatmeal");
  });

  it("starts collapsed, says how many meals are inside, and keeps them out of the dinner cell", () => {
    const screen = grid("simple", [dinner, lunch, snack]);
    expect(screen.has("more-meals-2026-11-03")).toBe(true);
    expect(screen.props("more-meals-toggle-2026-11-03")["aria-expanded"]).toBe(false);
    expect(screen.props("more-meals-toggle-2026-11-03").accessibilityLabel).toBe(
      "2 more meals on Tuesday",
    );
    expect(screen.html).toContain("More meals");
    // Collapsed: the meals are not drawn yet, and nothing was added to the dinner cell.
    expect(screen.has("more-meals-list-2026-11-03")).toBe(false);
    expect(screen.has("entry-e2")).toBe(false);
    expect(screen.has("slot-2026-11-03-lunch")).toBe(false);
    // The dinner is where it always was.
    expect(screen.has("entry-e1")).toBe(true);
  });

  it("says one meal in the singular", () => {
    const screen = grid("simple", [breakfast]);
    expect(screen.props("more-meals-toggle-2026-11-05").accessibilityLabel).toBe(
      "1 more meal on Thursday",
    );
  });
});
