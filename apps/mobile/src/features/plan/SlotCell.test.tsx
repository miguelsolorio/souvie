// The "More meals" disclosure and the chip it holds (WS04 follow-up: simple mode). The harness
// renders once and runs no effects, so the tapped state is not reachable here: the collapsed state
// is covered with the week grid, and the open state through `defaultOpen`.
import { describe, expect, it, vi } from "vitest";
import { planEntry } from "../../testing/planEntries";
import { renderScreen } from "../../testing/renderScreen";
import { EntryChip, MoreMeals } from "./SlotCell";

vi.mock("react-native", () => import("../../testing/reactNativeStub"));

const lunch = planEntry("e2", "2026-11-03", "lunch", "Leftover soup");
const snack = planEntry("e3", "2026-11-03", "snack", "Apple slices", { status: "skipped" });

describe("MoreMeals", () => {
  it("is collapsed by default and draws only the row", () => {
    const screen = renderScreen(
      <MoreMeals date="2026-11-03" count={2}>
        <EntryChip entry={lunch} onOpen={vi.fn()} slotLabel="Lunch" />
      </MoreMeals>,
    );
    expect(screen.has("more-meals-toggle-2026-11-03")).toBe(true);
    expect(screen.props("more-meals-toggle-2026-11-03")["aria-expanded"]).toBe(false);
    expect(screen.props("more-meals-toggle-2026-11-03").accessibilityHint).toBe("Shows them");
    expect(screen.has("more-meals-list-2026-11-03")).toBe(false);
    expect(screen.has("entry-e2")).toBe(false);
  });

  it("opens to the meals, each named by its slot, and each can be opened", () => {
    const onOpen = vi.fn();
    const screen = renderScreen(
      <MoreMeals date="2026-11-03" count={2} defaultOpen>
        <EntryChip entry={lunch} onOpen={onOpen} slotLabel="Lunch" />
        <EntryChip entry={snack} onOpen={onOpen} slotLabel="Snack" />
      </MoreMeals>,
    );
    expect(screen.props("more-meals-toggle-2026-11-03")["aria-expanded"]).toBe(true);
    expect(screen.props("more-meals-toggle-2026-11-03").accessibilityHint).toBe("Hides them");
    expect(screen.has("more-meals-list-2026-11-03")).toBe(true);
    expect(screen.html).toContain("Lunch");
    expect(screen.html).toContain("Leftover soup");
    expect(screen.html).toContain("Snack");
    expect(screen.html).toContain("Apple slices");
    expect(screen.props("entry-e2").accessibilityLabel).toBe("Lunch, Leftover soup, 4 servings");
    expect(screen.props("entry-e3").accessibilityLabel).toBe(
      "Snack, Apple slices, 4 servings, skipped",
    );

    screen.press("entry-e3");
    expect(onOpen).toHaveBeenCalledWith(snack);
  });
});

describe("EntryChip", () => {
  it("has no slot name when it sits in its own slot", () => {
    const screen = renderScreen(<EntryChip entry={lunch} onOpen={vi.fn()} />);
    expect(screen.props("entry-e2").accessibilityLabel).toBe("Leftover soup, 4 servings");
    expect(screen.html).not.toContain("Lunch");
  });
});
