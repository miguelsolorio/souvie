import { describe, expect, it } from "vitest";
import { AuthCallbackError, describeAuthError, isPlausibleEmail } from "./authMessages";

describe("isPlausibleEmail", () => {
  it("accepts ordinary addresses", () => {
    expect(isPlausibleEmail("alice@example.test")).toBe(true);
    expect(isPlausibleEmail("  alice+meals@mail.example.test ")).toBe(true);
  });

  it("rejects values that cannot be an email", () => {
    for (const value of ["", "alice", "alice@", "@example.test", "alice@example", "a b@c.test"]) {
      expect(isPlausibleEmail(value), value).toBe(false);
    }
  });
});

describe("describeAuthError", () => {
  it("explains expired links and codes", () => {
    expect(describeAuthError(new Error("Email link is invalid or has expired"))).toMatch(/expired/);
    expect(describeAuthError(new Error("Token has expired or is invalid"))).toMatch(/expired/);
  });

  it("explains a wrong code", () => {
    expect(describeAuthError(new Error("Invalid token"))).toMatch(/not right/);
  });

  it("explains rate limits and network failures", () => {
    expect(describeAuthError(new Error("email rate limit exceeded"))).toMatch(/Too many/);
    expect(
      describeAuthError(
        new Error("For security purposes, you can only request this after 20 seconds"),
      ),
    ).toMatch(/Too many/);
    expect(describeAuthError(new Error("Network request failed"))).toMatch(/Could not reach/);
    expect(describeAuthError(new TypeError("Failed to fetch"))).toMatch(/Could not reach/);
  });

  it("explains a provider that is not turned on", () => {
    expect(describeAuthError(new Error("Unsupported provider: provider is not enabled"))).toMatch(
      /not turned on/,
    );
  });

  it("passes through the text of a callback error", () => {
    expect(describeAuthError(new AuthCallbackError("Sign-in was cancelled."))).toBe(
      "Sign-in was cancelled.",
    );
  });

  it("never shows raw internals for unknown failures", () => {
    expect(describeAuthError(new Error("SQLSTATE 23505 duplicate key"))).toBe(
      "Sign-in did not work. Try again.",
    );
    expect(describeAuthError(undefined)).toBe("Sign-in did not work. Try again.");
  });
});
