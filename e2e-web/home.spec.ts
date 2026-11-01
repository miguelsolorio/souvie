import { expect, test } from "@playwright/test";
import { watchConsoleErrors } from "./support/consoleErrors";
import { PHONE } from "./support/viewports";

// WS13 acceptance criteria 2 and 9. The page is the static export served from disk with no
// backend and nobody signed in, so the home route sends the visitor to the sign-in screen.

test.describe("home", () => {
  test("/ renders the sign-in screen with the right title", async ({ page }) => {
    const watch = watchConsoleErrors(page);
    await page.goto("/");

    await expect(page).toHaveTitle("Souvie");
    await expect(page.getByRole("heading", { name: "Souvie" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with Apple" })).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in$/);

    expect(watch.errors()).toEqual([]);
  });

  test("/plan loads without console errors and also lands on sign-in", async ({ page }) => {
    const watch = watchConsoleErrors(page);
    await page.goto("/plan");

    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
    await expect(page).toHaveTitle("Souvie");

    expect(watch.errors()).toEqual([]);
  });

  test("the page is a real HTML document with a language and a description", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    const description = page.locator('meta[name="description"]');
    await expect(description).toHaveAttribute("content", /grocery list/);
  });
});

test.describe("home on a phone", () => {
  test.use(PHONE);

  test("the sign-in screen fits a 390 pixel window with nothing sideways", async ({ page }) => {
    const watch = watchConsoleErrors(page);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    expect(watch.errors()).toEqual([]);
  });
});
