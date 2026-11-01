import { entryId, WEEK_DAYS } from "./fixtures/world";
import { openSignedIn, worldSupabase } from "./support/app";
import { watchConsoleErrors } from "./support/consoleErrors";
import { byTestId, focusedTestId } from "./support/helpers";
import { expect, test } from "./support/test";
import { PHONE } from "./support/viewports";

// WS13 acceptance criterion 3 (the seven-day row and drag-and-drop with a mouse) and the planner
// half of criterion 4 (keyboard). The signed-in household is fixtures/world.ts, answered by the
// fake Supabase, with the clock fixed to Wednesday 4 November 2026.

test.describe("planner at 1280 by 800", () => {
  test("shows all seven days in one row", async ({ page }, testInfo) => {
    const fake = worldSupabase();
    await openSignedIn(page, fake);
    const watch = watchConsoleErrors(page);
    await page.goto("/plan");

    const grid = byTestId(page, "week-grid");
    await expect(grid).toHaveAttribute("aria-label", "Week plan, seven columns");

    const boxes = [];
    for (const day of WEEK_DAYS) {
      const header = byTestId(page, `open-day-${day}`);
      await expect(header).toBeVisible();
      boxes.push(await header.boundingBox());
    }
    const [first, ...rest] = boxes;
    expect(first).not.toBeNull();
    for (const box of rest) {
      // The same row: one top edge. Left to right: each starts after the one before.
      expect(box?.y).toBeCloseTo(first?.y ?? -1, 0);
    }
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i]?.x ?? 0).toBeGreaterThan(boxes[i - 1]?.x ?? 0);
    }
    // All seven are inside the window without scrolling sideways.
    const last = boxes.at(-1);
    expect((last?.x ?? 0) + (last?.width ?? 0)).toBeLessThanOrEqual(1280);

    await testInfo.attach("planner-1280x800", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    expect(watch.errors()).toEqual([]);
    expect(fake.unhandled).toEqual([]);
  });

  test("drag-and-drop with a mouse moves a recipe to another day", async ({ page }) => {
    const fake = worldSupabase();
    await openSignedIn(page, fake);
    await page.goto("/plan");

    // Monday's dinner is Lemon chicken. Drop it on Friday's lunch.
    const chip = byTestId(page, `entry-${entryId(1)}`);
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("draggable", "true");
    await chip.dragTo(byTestId(page, "slot-2026-11-06-lunch"));

    // On screen at once: the meal left Monday and is in Friday's lunch cell.
    await expect(
      byTestId(page, "slot-2026-11-06-lunch").locator(`[data-testid="entry-${entryId(1)}"]`),
    ).toBeVisible();
    await expect(
      byTestId(page, "slot-2026-11-02-dinner").locator(`[data-testid="entry-${entryId(1)}"]`),
    ).toHaveCount(0);

    // And saved: one update to that entry, with only the columns that changed.
    await expect.poll(() => fake.writes("meal_plan_entries").length).toBe(1);
    const [write] = fake.writes("meal_plan_entries");
    expect(write?.method).toBe("PATCH");
    expect(write?.query.get("id")).toBe(`eq.${entryId(1)}`);
    expect(write?.body).toMatchObject({ date: "2026-11-06", slot: "lunch", position: 0 });
  });

  test("dropping a meal back where it came from changes nothing", async ({ page }) => {
    const fake = worldSupabase();
    await openSignedIn(page, fake);
    await page.goto("/plan");
    const chip = byTestId(page, `entry-${entryId(1)}`);
    await chip.dragTo(byTestId(page, "slot-2026-11-02-dinner"));
    await expect(chip).toBeVisible();
    expect(fake.writes("meal_plan_entries")).toHaveLength(0);
  });

  test("arrow keys move focus between days, and down a day's column", async ({ page }) => {
    await openSignedIn(page, worldSupabase());
    await page.goto("/plan");

    await byTestId(page, "open-day-2026-11-02").focus();
    await page.keyboard.press("ArrowRight");
    expect(await focusedTestId(page)).toBe("open-day-2026-11-03");
    await page.keyboard.press("ArrowRight");
    expect(await focusedTestId(page)).toBe("open-day-2026-11-04");
    await page.keyboard.press("ArrowLeft");
    expect(await focusedTestId(page)).toBe("open-day-2026-11-03");

    // Down Tuesday: breakfast Add, lunch Add, then the Veggie chili dinner.
    await page.keyboard.press("ArrowDown");
    expect(await focusedTestId(page)).toBe("add-2026-11-03-breakfast");
    await page.keyboard.press("ArrowDown");
    expect(await focusedTestId(page)).toBe("add-2026-11-03-lunch");
    await page.keyboard.press("ArrowDown");
    expect(await focusedTestId(page)).toBe(`entry-${entryId(2)}`);

    // Across the dinner row: Monday's Lemon chicken, then Wednesday's empty dinner slot.
    await page.keyboard.press("ArrowLeft");
    expect(await focusedTestId(page)).toBe(`entry-${entryId(1)}`);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    expect(await focusedTestId(page)).toBe("add-2026-11-04-dinner");
  });

  test("Enter opens a meal and Escape closes it again", async ({ page }) => {
    await openSignedIn(page, worldSupabase());
    await page.goto("/plan");

    await byTestId(page, `entry-${entryId(2)}`).focus();
    await page.keyboard.press("Enter");
    const sheet = byTestId(page, "entry-sheet");
    await expect(sheet).toBeVisible();
    // One dialog, named for the meal: not a dialog inside a dialog.
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(page.getByRole("dialog", { name: "Veggie chili" })).toBeVisible();
    // The dialog traps focus: it moves inside a moment after it opens, and Escape is read there.
    await expect
      .poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))))
      .toBe(true);

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  test("Tab reaches every control, and each one shows a focus ring", async ({ page }) => {
    await openSignedIn(page, worldSupabase());
    await page.goto("/plan");
    await expect(byTestId(page, "week-grid")).toBeVisible();

    const reached = new Set<string>();
    for (let presses = 0; presses < 90; presses++) {
      await page.keyboard.press("Tab");
      const stop = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        return {
          id: el.getAttribute("data-testid") ?? el.getAttribute("aria-label") ?? el.tagName,
          outlineStyle: style.outlineStyle,
          outlineWidth: Number.parseFloat(style.outlineWidth),
        };
      });
      if (!stop) break;
      // A visible ring: a solid outline at least 2px wide on whatever has focus.
      expect(stop.outlineStyle, stop.id).not.toBe("none");
      expect(stop.outlineWidth, stop.id).toBeGreaterThanOrEqual(2);
      reached.add(stop.id);
    }

    // The week's controls are all reachable: the week buttons, a day, a meal and an Add button.
    for (const id of [
      "week-previous",
      "week-next",
      "generate-list",
      "open-day-2026-11-02",
      `entry-${entryId(1)}`,
      "add-2026-11-02-breakfast",
      "add-2026-11-08-snack",
    ]) {
      expect(reached.has(id), `Tab never reached ${id}`).toBe(true);
    }
  });
});

test.describe("planner at 390 by 844 (the phone)", () => {
  test.use(PHONE);

  test("keeps the phone layout: one card per day, stacked, no drag layer", async ({
    page,
  }, testInfo) => {
    await openSignedIn(page, worldSupabase());
    await page.goto("/plan");

    const grid = byTestId(page, "week-grid");
    await expect(grid).toHaveAttribute("aria-label", "Week plan, one card per day");

    // Seven cards in one column, each below the one before, none wider than the window.
    const tops: number[] = [];
    for (const day of WEEK_DAYS) {
      const card = byTestId(page, `day-${day}`);
      const box = await card.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.width ?? 0).toBeLessThanOrEqual(390);
      tops.push(box?.y ?? 0);
    }
    for (let i = 1; i < tops.length; i++) {
      expect(tops[i] ?? 0).toBeGreaterThan(tops[i - 1] ?? 0);
    }

    // Nothing in the phone layout is draggable: that layer only mounts in the wide grid.
    await expect(page.locator('[draggable="true"]')).toHaveCount(0);

    await testInfo.attach("planner-390x844", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
});
