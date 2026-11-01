import { describe, expect, it } from "vitest";
import { routeForDeepLink } from "./desktopLinks";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("routeForDeepLink", () => {
  it("sends a finished sign-in to the callback screen with its code", () => {
    expect(routeForDeepLink("souvie://callback?code=abc123")).toBe("/callback?code=abc123");
  });

  it("keeps a code that needs escaping safe", () => {
    expect(routeForDeepLink("souvie://callback?code=a%20b%26c")).toBe("/callback?code=a%20b%26c");
  });

  it("moves a failure from the fragment into the query, where the screen reads it", () => {
    expect(
      routeForDeepLink(
        "souvie://callback#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
      ),
    ).toBe(
      "/callback?error=access_denied&error_description=Email%20link%20is%20invalid%20or%20has%20expired",
    );
  });

  it("takes a failure that arrives in the query", () => {
    expect(routeForDeepLink("souvie://callback?error=access_denied&error_description=Nope")).toBe(
      "/callback?error=access_denied&error_description=Nope",
    );
  });

  it("still opens the callback screen for a link with nothing on it, so it can say so", () => {
    expect(routeForDeepLink("souvie://callback")).toBe("/callback");
  });

  it("opens a household invite", () => {
    expect(routeForDeepLink(`souvie://join/${TOKEN}`)).toBe(`/join/${TOKEN}`);
  });

  it("passes the Kroger redirect through with its query", () => {
    expect(routeForDeepLink("souvie://oauth/kroger?code=k1&state=s1")).toBe(
      "/oauth/kroger?code=k1&state=s1",
    );
  });

  it("is not case sensitive about the scheme", () => {
    expect(routeForDeepLink("SOUVIE://callback?code=x")).toBe("/callback?code=x");
  });

  it("ignores a trailing slash", () => {
    expect(routeForDeepLink("souvie://join/abc/")).toBe("/join/abc");
  });

  it("drops anything that is not a souvie link", () => {
    expect(routeForDeepLink("https://example.com/callback?code=x")).toBeNull();
    expect(routeForDeepLink("exp://192.168.0.2:8081/--/callback")).toBeNull();
    expect(routeForDeepLink("javascript:alert(1)")).toBeNull();
    expect(routeForDeepLink("")).toBeNull();
  });

  it("drops a souvie link to anywhere the app does not take links from", () => {
    expect(routeForDeepLink("souvie://household/settings")).toBeNull();
    expect(routeForDeepLink("souvie://profile")).toBeNull();
    expect(routeForDeepLink("souvie://")).toBeNull();
    expect(routeForDeepLink("souvie://shopping/123")).toBeNull();
  });

  it("drops a link that tries to climb out of its path", () => {
    expect(routeForDeepLink("souvie://join/../profile")).toBeNull();
    expect(routeForDeepLink("souvie://callback/%2e%2e/profile")).toBeNull();
    expect(routeForDeepLink("souvie://oauth/kroger/..//x")).toBeNull();
    expect(routeForDeepLink("souvie://join/a b")).toBeNull();
  });
});
