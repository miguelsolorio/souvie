import { test as base, expect, type Page } from "@playwright/test";

// The `test` every spec uses (WS13 fix round). It is Playwright's, with one addition: no page may
// reach a host that is not this computer.
//
// The app under test is built to talk to a loopback address that the fake Supabase answers
// (support/fakeSupabase.ts), and global-setup.ts refuses to start unless the export is that
// build. This is the second lock. If a build ever carried a real address, or a screen called some
// outside service, the request is aborted here, before it leaves the browser, and the test fails
// and names it. Nothing reaches the hosted Supabase project, whatever is in dist.

export { expect };

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** True for an address on this computer. Only http, https, ws and wss ever reach the guard. */
export function isLoopback(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname);
}

const blockedByPage = new WeakMap<Page, string[]>();

/**
 * The requests the guard aborted on this page, as "GET https://...". The list is live. A test
 * that provokes one on purpose reads it and then empties it (`splice(0)`), or the test fails.
 */
export function blockedRequests(page: Page): string[] {
  return blockedByPage.get(page) ?? [];
}

export const test = base.extend({
  page: async ({ page }, use) => {
    const blocked: string[] = [];
    blockedByPage.set(page, blocked);

    // Registered first, so it answers last: the fake's own routes are more specific and win.
    await page.route(
      (url) => !isLoopback(url),
      (route) => {
        blocked.push(`${route.request().method()} ${route.request().url()}`);
        return route.abort("blockedbyclient");
      },
    );
    await page.routeWebSocket(
      (url) => !isLoopback(url),
      (socket) => {
        blocked.push(`WS ${socket.url()}`);
        void socket.close({ code: 1008, reason: "blocked by the test guard" });
      },
    );

    await use(page);

    expect(blocked, "requests to a host that is not this computer were aborted").toEqual([]);
  },
});
