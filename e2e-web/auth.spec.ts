import { createHash } from "node:crypto";
import { openSignedOut, worldSupabase } from "./support/app";
import { watchConsoleErrors } from "./support/consoleErrors";
import { byTestId } from "./support/helpers";
import { expect, test } from "./support/test";

// WS13 acceptance criterion 5: sign-in with Google (and Apple) completes on the web through the
// /callback route, here on the local static server. The identity provider is the fake's part:
// /auth/v1/authorize answers with a redirect straight back to the app with a code. Everything the
// app does is real: the PKCE challenge, the redirect URL it asks for, the code exchange, and
// where it goes afterwards.
//
// On the Cloudflare preview URL the same flow needs the preview origin in Supabase's redirect
// allow list (docs/01-architecture.md, "Web hosting and the desktop shell"); that run is Miguel's.

const ORIGIN = "http://127.0.0.1:4173";

for (const provider of ["google", "apple"] as const) {
  test(`${provider} sign-in completes on the web through /callback`, async ({ page }) => {
    const fake = worldSupabase();
    await openSignedOut(page, fake);
    const watch = watchConsoleErrors(page);

    await page.goto("/sign-in");
    await page
      .getByRole("button", { name: `Continue with ${provider === "google" ? "Google" : "Apple"}` })
      .click();

    // The app asked the provider to come back to /callback on this origin, with a PKCE challenge.
    await expect.poll(() => fake.requests.some((r) => r.table === "auth/authorize")).toBe(true);
    const authorize = fake.requests.find((r) => r.table === "auth/authorize");
    expect(authorize?.query.get("provider")).toBe(provider);
    expect(authorize?.query.get("redirect_to")).toBe(`${ORIGIN}/callback`);
    expect(authorize?.query.get("code_challenge_method")).toBe("s256");

    // The provider sent the browser back, the app swapped the code for a session, and the signed-in
    // home screen opened.
    await expect(page).toHaveURL(`${ORIGIN}/plan`);
    await expect(byTestId(page, "week-grid")).toBeVisible();

    const exchange = fake.requests.find((r) => r.table === "auth/token");
    expect(exchange?.query.get("grant_type")).toBe("pkce");
    const body = exchange?.body as { auth_code?: string; code_verifier?: string };
    expect(body.auth_code).toBe("fake-auth-code");
    // The verifier the app kept is the one whose hash it sent: the code cannot be swapped by anyone else.
    const challenge = createHash("sha256")
      .update(body.code_verifier ?? "")
      .digest("base64url");
    expect(authorize?.query.get("code_challenge")).toBe(challenge);

    // The session is stored, so a reload stays signed in.
    await page.reload();
    await expect(byTestId(page, "week-grid")).toBeVisible();
    expect(watch.errors()).toEqual([]);
  });
}

test.describe("a sign-in that did not work", () => {
  test("an expired link says so and offers a way back (error in the fragment)", async ({
    page,
  }) => {
    await openSignedOut(page, worldSupabase());
    await page.goto(
      "/callback#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    );
    await expect(page.getByText("Could not sign you in")).toBeVisible();
    await expect(page.getByText(/expired|did not work|invalid/i).first()).toBeVisible();

    await page.getByRole("button", { name: "Back to sign in" }).click();
    await expect(page).toHaveURL(`${ORIGIN}/sign-in`);
  });

  test("a provider that refuses says so (error in the query)", async ({ page }) => {
    await openSignedOut(page, worldSupabase());
    await page.goto("/callback?error=access_denied&error_description=The+user+denied+access");
    await expect(page.getByText("Could not sign you in")).toBeVisible();
  });

  test("a callback with no code says the link is incomplete", async ({ page }) => {
    await openSignedOut(page, worldSupabase());
    await page.goto("/callback");
    await expect(page.getByText("Could not sign you in")).toBeVisible();
    await expect(page.getByText(/missing its code/)).toBeVisible();
  });
});
