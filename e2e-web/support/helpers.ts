import type { Locator, Page } from "@playwright/test";

/** An element by the test ID react-native-web writes out as `data-testid`. */
export const byTestId = (page: Page, id: string): Locator => page.locator(`[data-testid="${id}"]`);

/** The test ID of whatever has keyboard focus, or null. */
export async function focusedTestId(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);
}

/** Presses Tab until the element with `id` has focus. Fails after `limit` presses. */
export async function tabTo(page: Page, id: string, limit = 80): Promise<number> {
  for (let presses = 1; presses <= limit; presses++) {
    await page.keyboard.press("Tab");
    if ((await focusedTestId(page)) === id) return presses;
  }
  throw new Error(`Tab did not reach ${id} in ${limit} presses`);
}

/**
 * Every control Tab can reach, in the order Tab visits them: the `data-testid` (or role and
 * label when there is none) of each stop, until focus leaves the page or loops.
 */
export async function tabOrder(page: Page, limit = 120): Promise<string[]> {
  const stops: string[] = [];
  for (let presses = 0; presses < limit; presses++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      return (
        el.getAttribute("data-testid") ??
        `${el.getAttribute("role") ?? el.tagName.toLowerCase()}:${el.getAttribute("aria-label") ?? el.textContent?.slice(0, 30) ?? ""}`
      );
    });
    if (stop === null) break;
    if (stops.includes(stop)) break;
    stops.push(stop);
  }
  return stops;
}
