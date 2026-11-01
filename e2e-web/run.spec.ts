import { IDS } from "./fixtures/world";
import { openSignedIn, worldSupabase } from "./support/app";
import { watchConsoleErrors } from "./support/consoleErrors";
import { byTestId } from "./support/helpers";
import { expect, test } from "./support/test";
import { PHONE } from "./support/viewports";

// WS13: the run review screen is a table at the desktop breakpoint and cards on a phone.

const RUN_URL = `/shopping/${IDS.run}`;

test.describe("run review at 1280 by 800", () => {
  test("is a table: one header row, one row per line, columns that line up", async ({
    page,
  }, testInfo) => {
    const fake = worldSupabase();
    await openSignedIn(page, fake);
    const watch = watchConsoleErrors(page);
    await page.goto(RUN_URL);

    const cart = byTestId(page, "proposed-cart");
    await expect(cart).toBeVisible();
    await expect(cart).toHaveAttribute("role", "table");
    const headers = cart.getByRole("columnheader");
    await expect(headers).toHaveText([
      "On your list",
      "Product",
      "Size",
      "Quantity",
      "Price",
      "Line total",
      "Actions",
    ]);

    // Seven lines in the run, so seven line rows, plus the header row, plus a row for each
    // section heading and each line's flags or swap choices.
    await expect(byTestId(page, "run-item-0")).toBeVisible();
    await expect(byTestId(page, "run-item-6")).toBeVisible();
    expect(await cart.getByRole("row").count()).toBeGreaterThan(8);

    // The product column starts at the same x on every line, and under its header.
    const productHeader = await headers.nth(1).boundingBox();
    const first = await byTestId(page, "run-item-0").getByRole("cell").nth(1).boundingBox();
    const last = await byTestId(page, "run-item-6").getByRole("cell").nth(1).boundingBox();
    expect(Math.abs((first?.x ?? 0) - (productHeader?.x ?? 99))).toBeLessThan(1.5);
    expect(Math.abs((last?.x ?? 0) - (productHeader?.x ?? 99))).toBeLessThan(1.5);

    await testInfo.attach("run-1280x800", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    expect(watch.errors()).toEqual([]);
    expect(fake.unhandled).toEqual([]);
  });

  test("shows each line's product, size, quantity, price and total as the store returned them", async ({
    page,
  }) => {
    await openSignedIn(page, worldSupabase());
    await page.goto(RUN_URL);

    const chicken = byTestId(page, "run-item-2");
    await expect(chicken.getByRole("cell").nth(0)).toHaveText("Boneless skinless chicken thighs");
    await expect(chicken.getByRole("cell").nth(1)).toHaveText(
      "Mock Market Boneless Skinless Chicken Thighs",
    );
    await expect(chicken.getByRole("cell").nth(2)).toHaveText("1 lb");
    await expect(byTestId(page, "run-item-2-qty-value")).toHaveText("2");
    await expect(chicken.getByRole("cell").nth(4)).toHaveText("$3.42");
    await expect(chicken.getByRole("cell").nth(5)).toHaveText("$6.84");
  });

  test("a line can be removed and put back, and the subtotal follows", async ({ page }) => {
    await openSignedIn(page, worldSupabase());
    await page.goto(RUN_URL);

    const subtotal = byTestId(page, "run-subtotal");
    const before = await subtotal.innerText();
    await byTestId(page, "run-item-2-remove").click();
    await expect(subtotal).not.toHaveText(before);
    await expect(byTestId(page, "run-item-2-restore")).toBeVisible();

    await byTestId(page, "run-item-2-restore").click();
    await expect(subtotal).toHaveText(before);
  });

  test("a quantity can be raised with the stepper, and a swap chosen", async ({ page }) => {
    await openSignedIn(page, worldSupabase());
    await page.goto(RUN_URL);

    await byTestId(page, "run-item-0-qty-plus").click();
    await expect(byTestId(page, "run-item-0-qty-value")).toHaveText("2");

    const milk = byTestId(page, "run-item-3");
    await expect(milk.getByRole("cell").nth(1)).toHaveText("Northfork Creamery Whole Milk");
    await byTestId(page, "run-item-3-alt-0").click();
    await expect(milk.getByRole("cell").nth(1)).toHaveText("Northfork Creamery Organic Whole Milk");
  });

  test("a line with no product shows its flag and the products to pick from", async ({ page }) => {
    await openSignedIn(page, worldSupabase());
    await page.goto(RUN_URL);
    const penne = byTestId(page, "run-item-5");
    await expect(penne.getByText("No product chosen")).toBeVisible();
    await expect(penne.getByText(/No exact match/)).toBeVisible();
    await expect(byTestId(page, "run-item-5-alt-0")).toBeVisible();
  });

  test("Tab walks the table's controls row by row", async ({ page }) => {
    await openSignedIn(page, worldSupabase());
    await page.goto(RUN_URL);
    await expect(byTestId(page, "proposed-cart")).toBeVisible();

    const stops: string[] = [];
    for (let presses = 0; presses < 60; presses++) {
      await page.keyboard.press("Tab");
      const id = await page.evaluate(
        () => document.activeElement?.getAttribute("data-testid") ?? null,
      );
      if (!id) continue;
      if (stops.includes(id)) break;
      stops.push(id);
    }
    const at = (id: string) => {
      const index = stops.indexOf(id);
      expect(index, `Tab never reached ${id}`).toBeGreaterThanOrEqual(0);
      return index;
    };
    const order = [
      "run-approve",
      "run-item-0-qty-plus",
      "run-item-0-remove",
      "run-item-1-qty-plus",
      "run-item-1-remove",
      "run-item-3-qty-plus",
      "run-item-3-remove",
      "run-item-3-alt-0",
    ].map(at);
    // Each row's quantity and Remove come before the next row's; swap choices sit under their row.
    expect(order.slice(0, 5)).toEqual([...order.slice(0, 5)].sort((a, b) => a - b));
    expect(at("run-item-3-remove")).toBeLessThan(at("run-item-3-alt-0"));
  });
});

test.describe("run review at 390 by 844 (the phone)", () => {
  test.use(PHONE);

  test("keeps the cards: no table, each line a stacked card", async ({ page }, testInfo) => {
    await openSignedIn(page, worldSupabase());
    await page.goto(RUN_URL);

    const cart = byTestId(page, "proposed-cart");
    await expect(cart).toBeVisible();
    await expect(cart).not.toHaveAttribute("role", "table");
    await expect(page.getByRole("columnheader")).toHaveCount(0);
    await expect(byTestId(page, "cart-table-header")).toHaveCount(0);

    // Lines stack in one column, each as wide as the screen allows.
    const first = await byTestId(page, "run-item-0").boundingBox();
    const second = await byTestId(page, "run-item-1").boundingBox();
    expect(second?.y ?? 0).toBeGreaterThan(first?.y ?? 0);
    expect(Math.abs((second?.x ?? 0) - (first?.x ?? 99))).toBeLessThan(1);
    expect(first?.width ?? 0).toBeGreaterThan(300);
    expect(first?.width ?? 999).toBeLessThanOrEqual(390);

    await testInfo.attach("run-390x844", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  });
});
