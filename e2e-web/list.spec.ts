import { itemId } from "./fixtures/world";
import { openSignedIn, worldSupabase } from "./support/app";
import { watchConsoleErrors } from "./support/consoleErrors";
import { byTestId, tabOrder } from "./support/helpers";
import { expect, test } from "./support/test";
import { PHONE } from "./support/viewports";

// WS13 acceptance criterion 4: at 1280 by 800 the grocery list is two panes, Enter checks an item,
// Escape closes a sheet, and Tab reaches every control in order. Then the phone layout, unchanged.

test.describe("grocery list at 1280 by 800", () => {
  test("is two panes: store sections on the left, items on the right", async ({
    page,
  }, testInfo) => {
    const fake = worldSupabase();
    await openSignedIn(page, fake);
    const watch = watchConsoleErrors(page);
    await page.goto("/list");

    await expect(byTestId(page, "list-two-pane")).toBeVisible();
    const nav = await byTestId(page, "list-pane-nav").boundingBox();
    const items = await byTestId(page, "list-pane-items").boundingBox();
    expect(nav).not.toBeNull();
    expect(items).not.toBeNull();
    // Side by side: the section pane ends before the item pane starts, and they share a top edge.
    expect((nav?.x ?? 0) + (nav?.width ?? 0)).toBeLessThanOrEqual(items?.x ?? 0);
    expect(Math.abs((nav?.y ?? 0) - (items?.y ?? 99))).toBeLessThan(8);

    // The left pane names every section that has something to buy, in store order.
    const tabs = byTestId(page, "list-pane-nav").getByRole("tab");
    await expect(tabs).toHaveText([
      /^All items/,
      /^Produce/,
      /^Bakery/,
      /^Meat/,
      /^Dairy/,
      /^Pantry/,
      /^Already have/,
      /^Removed/,
    ]);
    await expect(byTestId(page, "list-pane-all")).toHaveAttribute("aria-selected", "true");
    await expect(byTestId(page, "section-produce")).toBeVisible();
    await expect(byTestId(page, `item-${itemId(1)}`)).toBeVisible();

    await testInfo.attach("list-1280x800", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    expect(watch.errors()).toEqual([]);
    expect(fake.unhandled).toEqual([]);
  });

  test("choosing a section shows only its items", async ({ page }) => {
    await openSignedIn(page, worldSupabase());
    await page.goto("/list");

    await byTestId(page, "list-pane-section:dairy").click();
    await expect(byTestId(page, "list-pane-section:dairy")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(byTestId(page, "section-dairy")).toBeVisible();
    await expect(byTestId(page, `item-${itemId(5)}`)).toBeVisible();
    await expect(byTestId(page, "section-produce")).toHaveCount(0);
    await expect(byTestId(page, `item-${itemId(1)}`)).toHaveCount(0);

    // "Already have" opens expanded in its own pane, with its "I'm out" button.
    await byTestId(page, "list-pane-have").click();
    await expect(byTestId(page, `item-${itemId(13)}`)).toBeVisible();
    await expect(byTestId(page, `item-${itemId(13)}-action`)).toBeVisible();

    await byTestId(page, "list-pane-all").click();
    await expect(byTestId(page, "section-produce")).toBeVisible();
  });

  test("Enter checks an item off", async ({ page }) => {
    const fake = worldSupabase();
    await openSignedIn(page, fake);
    await page.goto("/list");

    const row = byTestId(page, `item-${itemId(1)}`);
    await expect(row).toHaveAttribute("aria-checked", "false");
    await expect(byTestId(page, "list-progress")).toHaveText("1 of 12 done");

    await row.focus();
    await page.keyboard.press("Enter");
    await expect(row).toHaveAttribute("aria-checked", "true");
    await expect(byTestId(page, "list-progress")).toHaveText("2 of 12 done");

    // Saved: one update to that item.
    await expect
      .poll(() =>
        fake.writes("grocery_list_items").some((w) => w.query.get("id") === `eq.${itemId(1)}`),
      )
      .toBe(true);

    // And Enter again puts it back.
    await page.keyboard.press("Enter");
    await expect(row).toHaveAttribute("aria-checked", "false");
  });

  test("Space checks an item off too", async ({ page }) => {
    await openSignedIn(page, worldSupabase());
    await page.goto("/list");
    const row = byTestId(page, `item-${itemId(2)}`);
    await row.focus();
    await page.keyboard.press("Space");
    await expect(row).toHaveAttribute("aria-checked", "true");
  });

  test("Escape closes an open sheet", async ({ page }) => {
    await openSignedIn(page, worldSupabase());
    await page.goto("/list");

    await byTestId(page, `item-${itemId(1)}-info`).click();
    const why = byTestId(page, "why-sheet");
    await expect(why).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))))
      .toBe(true);
    await page.keyboard.press("Escape");
    await expect(why).toBeHidden();

    // The aisle order sheet, opened from the keyboard.
    await byTestId(page, "list-aisle-order").focus();
    await page.keyboard.press("Enter");
    const order = byTestId(page, "section-order-sheet");
    await expect(order).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))))
      .toBe(true);
    await page.keyboard.press("Escape");
    await expect(order).toBeHidden();
  });

  test("Tab reaches every control, left pane before right, add bar last", async ({ page }) => {
    await openSignedIn(page, worldSupabase());
    await page.goto("/list");
    await expect(byTestId(page, "list-two-pane")).toBeVisible();

    const order = await tabOrder(page, 140);
    const at = (id: string) => {
      const index = order.indexOf(id);
      expect(index, `Tab never reached ${id}`).toBeGreaterThanOrEqual(0);
      return index;
    };
    const sequence = [
      "list-week-previous",
      "list-week-next",
      "list-pane-all",
      "list-pane-section:produce",
      "list-pane-removed",
      "list-rebuild-anyway",
      "list-aisle-order",
      "list-pantry",
      "list-mark-shopped",
      `item-${itemId(1)}`,
      `item-${itemId(1)}-info`,
      `item-${itemId(12)}`,
      "add-item-input",
    ].map(at);
    expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
  });
});

test.describe("grocery list at 390 by 844 (the phone)", () => {
  test.use(PHONE);

  test("keeps the single column: no panes, every section stacked", async ({ page }, testInfo) => {
    await openSignedIn(page, worldSupabase());
    await page.goto("/list");

    await expect(byTestId(page, "section-produce")).toBeVisible();
    await expect(byTestId(page, "list-two-pane")).toHaveCount(0);
    await expect(byTestId(page, "list-pane-nav")).toHaveCount(0);
    // Sections run down one column.
    const produce = await byTestId(page, "section-produce").boundingBox();
    const dairy = await byTestId(page, "section-dairy").boundingBox();
    expect(dairy?.y ?? 0).toBeGreaterThan(produce?.y ?? 0);
    expect(Math.abs((dairy?.x ?? 0) - (produce?.x ?? 99))).toBeLessThan(1);
    // The three rows of buttons are where they were: under the sections, not in a side pane.
    await expect(byTestId(page, "list-aisle-order")).toBeVisible();

    await testInfo.attach("list-390x844", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });

  test("a sheet is still a bottom sheet on a phone", async ({ page }) => {
    await openSignedIn(page, worldSupabase());
    await page.goto("/list");
    await byTestId(page, `item-${itemId(1)}-info`).click();
    const sheet = byTestId(page, "why-sheet");
    await expect(sheet).toBeVisible();
    const box = await sheet.boundingBox();
    // Full width and resting on the bottom edge: the phone's sheet, not the desktop dialog.
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(388);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeGreaterThanOrEqual(840);
  });
});
