import AxeBuilder from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import { entryId, IDS, itemId } from "./fixtures/world";
import { openSignedIn, openSignedOut, worldSupabase } from "./support/app";
import { byTestId } from "./support/helpers";
import { expect, test } from "./support/test";
import { PHONE } from "./support/viewports";

// WS13 acceptance criterion 4: an axe-core pass. Every rule axe runs by default is on, none is
// switched off, and any violation of any impact (critical, serious, moderate or minor) fails the
// test. Each screen is checked at the desktop size, the planner and the list also with a sheet
// open, and the planner once more at a phone's width.

async function scan(page: Page, name: string, testInfo: TestInfo) {
  const results = await new AxeBuilder({ page }).analyze();
  await testInfo.attach(`axe-${name}`, {
    body: JSON.stringify(
      {
        passes: results.passes.length,
        incomplete: results.incomplete.map((v) => v.id),
        violations: results.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.map((n) => n.target),
        })),
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  return results.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help} -> ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
  );
}

test.describe("axe-core at 1280 by 800", () => {
  test("sign-in", async ({ page }, testInfo) => {
    await openSignedOut(page, worldSupabase());
    await page.goto("/sign-in");
    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
    expect(await scan(page, "sign-in", testInfo)).toEqual([]);
  });

  test("planner", async ({ page }, testInfo) => {
    await openSignedIn(page, worldSupabase());
    await page.goto("/plan");
    await expect(byTestId(page, "week-grid")).toBeVisible();
    expect(await scan(page, "planner", testInfo)).toEqual([]);
  });

  test("planner with a meal open", async ({ page }, testInfo) => {
    await openSignedIn(page, worldSupabase());
    await page.goto("/plan");
    await byTestId(page, `entry-${entryId(2)}`).click();
    await expect(byTestId(page, "entry-sheet")).toBeVisible();
    // The dialog's role and name arrive a moment after the panel; scan once it has them.
    await expect(page.getByRole("dialog", { name: "Veggie chili" })).toBeVisible();
    expect(await scan(page, "planner-sheet", testInfo)).toEqual([]);
  });

  test("grocery list", async ({ page }, testInfo) => {
    await openSignedIn(page, worldSupabase());
    await page.goto("/list");
    await expect(byTestId(page, "list-two-pane")).toBeVisible();
    expect(await scan(page, "list", testInfo)).toEqual([]);
  });

  test("grocery list with an item's sheet open", async ({ page }, testInfo) => {
    await openSignedIn(page, worldSupabase());
    await page.goto("/list");
    await byTestId(page, `item-${itemId(1)}-info`).click();
    await expect(byTestId(page, "why-sheet")).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Yellow onions" })).toBeVisible();
    expect(await scan(page, "list-sheet", testInfo)).toEqual([]);
  });

  test("run review table", async ({ page }, testInfo) => {
    await openSignedIn(page, worldSupabase());
    await page.goto(`/shopping/${IDS.run}`);
    await expect(byTestId(page, "proposed-cart")).toBeVisible();
    expect(await scan(page, "run", testInfo)).toEqual([]);
  });
});

test.describe("axe-core at 390 by 844 (the phone)", () => {
  test.use(PHONE);

  test("planner", async ({ page }, testInfo) => {
    await openSignedIn(page, worldSupabase());
    await page.goto("/plan");
    await expect(byTestId(page, "week-grid")).toBeVisible();
    expect(await scan(page, "planner-phone", testInfo)).toEqual([]);
  });
});
