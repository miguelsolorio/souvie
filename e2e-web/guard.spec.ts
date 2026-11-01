import { blockedRequests, expect, test } from "./support/test";

// The guard that keeps the browser tests off the hosted Supabase project (WS13 fix round). Two
// locks: global-setup.ts refuses to start on an export that is not the placeholder build (its logic
// is tested in support/exportGuard.test.ts), and support/test.ts aborts any request to a host that
// is not this computer. These prove the second one in a real browser.

const HOSTED = "https://abcdefghijklmnopqrst.supabase.co";

test.describe("the outside-world guard", () => {
  test("aborts a request to a hosted Supabase address before it leaves the browser", async ({
    page,
  }) => {
    await page.goto("/sign-in");
    const failures: string[] = [];
    page.on("requestfailed", (request) => {
      failures.push(`${request.url()} ${request.failure()?.errorText ?? ""}`);
    });

    // What a build with a real address would send when someone asks for an email sign-in.
    const outcome = await page.evaluate(async (hosted) => {
      try {
        const response = await fetch(`${hosted}/auth/v1/otp`, {
          method: "POST",
          headers: { "content-type": "application/json", apikey: "x" },
          body: JSON.stringify({ email: "cook@example.test", create_user: true }),
        });
        return `answered ${response.status}`;
      } catch (error) {
        return `rejected: ${(error as Error).message}`;
      }
    }, HOSTED);

    // The browser never got an answer, from the guard or from the project.
    expect(outcome).toMatch(/^rejected: /);
    expect(blockedRequests(page)).toEqual([`POST ${HOSTED}/auth/v1/otp`]);
    expect(failures).toHaveLength(1);
    // Chrome adds a suffix to the error text in some versions (".Inspector"), so match the start.
    expect(failures[0]).toContain(`${HOSTED}/auth/v1/otp net::ERR_BLOCKED_BY_CLIENT`);

    // The test asked for it, so it is acknowledged. Without this the test would fail on it.
    blockedRequests(page).splice(0);
  });

  test("aborts a realtime socket to a hosted address too", async ({ page }) => {
    await page.goto("/sign-in");
    const outcome = await page.evaluate(
      (hosted) =>
        new Promise<string>((resolve) => {
          const socket = new WebSocket(`${hosted.replace("https", "wss")}/realtime/v1/websocket`);
          socket.onopen = () => resolve("open");
          socket.onerror = () => resolve("error");
          socket.onclose = () => resolve("closed");
        }),
      HOSTED,
    );
    expect(["error", "closed", "open"]).toContain(outcome);
    // Whether the browser reports it as closed or errored, the guard saw the attempt.
    await expect.poll(() => blockedRequests(page).length).toBe(1);
    expect(blockedRequests(page)[0]).toBe(
      "WS wss://abcdefghijklmnopqrst.supabase.co/realtime/v1/websocket",
    );
    blockedRequests(page).splice(0);
  });

  test("lets the app's own origin and the fake Supabase address through", async ({ page }) => {
    await page.goto("/sign-in");
    // The page's own origin: its HTML, and one of the scripts it loaded.
    const own = await page.evaluate(async () => {
      const script = document.querySelector<HTMLScriptElement>("script[src]")?.src ?? "";
      const [html, bundle] = await Promise.all([fetch("/sign-in"), fetch(script)]);
      return [html.status, bundle.status];
    });
    expect(own).toEqual([200, 200]);
    // Nothing answers on the fake address here (no fake is installed), but the guard let the
    // request go: it fails to connect, as a closed port does, and is not aborted by the guard.
    const outcome = await page.evaluate(() =>
      fetch("http://127.0.0.1:1/").then(
        () => "answered",
        () => "refused",
      ),
    );
    expect(outcome).toBe("refused");
    expect(blockedRequests(page)).toEqual([]);
  });
});
