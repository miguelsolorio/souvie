import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { openSignedOut, worldSupabase } from "./support/app";
import { byTestId } from "./support/helpers";
import {
  deepLinkListeners,
  emitDeepLink,
  installTauriStub,
  tauriInvokes,
} from "./support/tauriStub";

// The web build inside the desktop shell (WS13). The shell is stood in for (support/tauriStub.ts);
// the app code and the Tauri plugin packages it loads are the real ones. What this proves: in the
// desktop window the app signs in through the system browser and comes back by souvie://callback,
// where a browser tab would redirect itself.

const ORIGIN = "http://127.0.0.1:4173";

test.describe("in the desktop shell", () => {
  test("listens for souvie:// links, and ignores links it does not take", async ({ page }) => {
    const fake = worldSupabase();
    await openSignedOut(page, fake);
    await installTauriStub(page);
    await page.goto("/sign-in");

    await expect.poll(() => deepLinkListeners(page)).toBe(1);

    // A link to somewhere the app does not take links from changes nothing.
    await emitDeepLink(page, "souvie://household/settings");
    await emitDeepLink(page, "https://evil.example/callback?code=x");
    await page.waitForTimeout(200);
    await expect(page).toHaveURL(`${ORIGIN}/sign-in`);
  });

  test("Google opens in the system browser and sign-in finishes from the deep link", async ({
    page,
  }) => {
    const fake = worldSupabase();
    await openSignedOut(page, fake);
    await installTauriStub(page);
    await page.goto("/sign-in");
    await expect.poll(() => deepLinkListeners(page)).toBe(1);

    await page.getByRole("button", { name: "Continue with Google" }).click();

    // The window did not leave the app. The provider's address went to the opener plugin instead.
    await expect
      .poll(async () => (await tauriInvokes(page)).some((i) => i.cmd === "plugin:opener|open_url"))
      .toBe(true);
    await expect(page).toHaveURL(`${ORIGIN}/sign-in`);
    const opened = (await tauriInvokes(page)).find((i) => i.cmd === "plugin:opener|open_url");
    const url = new URL(String(opened?.args.url));
    expect(url.origin).toBe("http://127.0.0.1:54321");
    expect(url.pathname).toBe("/auth/v1/authorize");
    expect(url.searchParams.get("provider")).toBe("google");
    // The way back is the deep link, which is in the redirect allow list already (the phones use it).
    expect(url.searchParams.get("redirect_to")).toBe("souvie://callback");

    // The system browser finishes, the operating system hands the link to the app.
    await emitDeepLink(page, "souvie://callback?code=fake-auth-code");
    await expect(page).toHaveURL(`${ORIGIN}/plan`);
    await expect(byTestId(page, "week-grid")).toBeVisible();

    const exchange = fake.requests.find((r) => r.table === "auth/token");
    expect(exchange?.query.get("grant_type")).toBe("pkce");
    const body = exchange?.body as { auth_code?: string; code_verifier?: string };
    expect(body.auth_code).toBe("fake-auth-code");
    // The window kept the PKCE verifier across the trip through the other browser.
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256")
        .update(body.code_verifier ?? "")
        .digest("base64url"),
    );
  });

  test("an email link asks to come back to the desktop app, not to a page nobody can open", async ({
    page,
  }) => {
    const fake = worldSupabase();
    await openSignedOut(page, fake);
    await installTauriStub(page);
    await page.goto("/sign-in");
    await byTestId(page, "email-input").fill("cook@example.test");
    await byTestId(page, "send-magic-link").click();

    await expect.poll(() => fake.requests.some((r) => r.table === "auth/otp")).toBe(true);
    const otp = fake.requests.find((r) => r.table === "auth/otp");
    expect(otp?.query.get("redirect_to")).toBe("souvie://callback");
  });

  test("a sign-in that failed in the system browser says so", async ({ page }) => {
    await openSignedOut(page, worldSupabase());
    await installTauriStub(page);
    await page.goto("/sign-in");
    await expect.poll(() => deepLinkListeners(page)).toBe(1);

    await emitDeepLink(
      page,
      "souvie://callback#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    );
    await expect(page.getByText("Could not sign you in")).toBeVisible();
  });

  test("a household invite link opens the invite", async ({ page }) => {
    await openSignedOut(page, worldSupabase());
    await installTauriStub(page);
    await page.goto("/sign-in");
    await expect.poll(() => deepLinkListeners(page)).toBe(1);
    const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    await emitDeepLink(page, `souvie://join/${token}`);
    await expect(page).toHaveURL(new RegExp(`/join/${token}$|/sign-in$`));
  });
});

test.describe("in an ordinary browser", () => {
  test("Google still redirects the tab itself, and no desktop plugin is touched", async ({
    page,
  }) => {
    await openSignedOut(page, worldSupabase());
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await expect(page).toHaveURL(`${ORIGIN}/plan`);
    expect(await page.evaluate(() => "__TAURI_INTERNALS__" in window)).toBe(false);
  });
});
