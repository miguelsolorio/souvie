import { describe, expect, it } from "vitest";
import { buildInviteUrl, isValidInviteToken, parseAuthCallback, parseInviteInput } from "./links";

const TOKEN = "9f2c4a7e1b3d5f60a8c2e4f6081a3c5e7092b4d6f8a1c3e5072941b3d5f7a9c1";

describe("isValidInviteToken", () => {
  it("accepts the 64 hex characters create_invite returns", () => {
    expect(isValidInviteToken(TOKEN)).toBe(true);
  });

  it("rejects short, long, and non URL-safe values", () => {
    expect(isValidInviteToken("short")).toBe(false);
    expect(isValidInviteToken("a".repeat(129))).toBe(false);
    expect(isValidInviteToken(`${TOKEN}/../x`)).toBe(false);
    expect(isValidInviteToken("has space has space has space")).toBe(false);
    expect(isValidInviteToken(undefined)).toBe(false);
    expect(isValidInviteToken(42)).toBe(false);
  });
});

describe("parseInviteInput", () => {
  it("accepts a bare token with surrounding whitespace", () => {
    expect(parseInviteInput(`  ${TOKEN}\n`)).toBe(TOKEN);
  });

  it("extracts the token from a web link", () => {
    expect(parseInviteInput(`https://app.example.test/join/${TOKEN}`)).toBe(TOKEN);
    expect(parseInviteInput(`http://localhost:8081/join/${TOKEN}/`)).toBe(TOKEN);
    expect(parseInviteInput(`https://app.example.test/join/${TOKEN}?utm=x#frag`)).toBe(TOKEN);
  });

  it("extracts the token from the deep link", () => {
    expect(parseInviteInput(`mealplanner://join/${TOKEN}`)).toBe(TOKEN);
  });

  it("returns null for anything else", () => {
    expect(parseInviteInput("")).toBeNull();
    expect(parseInviteInput("   ")).toBeNull();
    expect(parseInviteInput("hello")).toBeNull();
    expect(parseInviteInput("https://app.example.test/plan")).toBeNull();
    expect(parseInviteInput("https://app.example.test/join/short")).toBeNull();
  });
});

describe("buildInviteUrl", () => {
  it("uses the web origin when there is one, without doubling slashes", () => {
    expect(buildInviteUrl(TOKEN, "https://app.example.test")).toBe(
      `https://app.example.test/join/${TOKEN}`,
    );
    expect(buildInviteUrl(TOKEN, "https://app.example.test//")).toBe(
      `https://app.example.test/join/${TOKEN}`,
    );
  });

  it("falls back to the deep link", () => {
    expect(buildInviteUrl(TOKEN)).toBe(`mealplanner://join/${TOKEN}`);
    expect(buildInviteUrl(TOKEN, "  ")).toBe(`mealplanner://join/${TOKEN}`);
    expect(buildInviteUrl(TOKEN, null)).toBe(`mealplanner://join/${TOKEN}`);
  });

  it("round-trips through parseInviteInput", () => {
    expect(parseInviteInput(buildInviteUrl(TOKEN, "https://app.example.test"))).toBe(TOKEN);
    expect(parseInviteInput(buildInviteUrl(TOKEN))).toBe(TOKEN);
  });
});

describe("parseAuthCallback", () => {
  it("reads the PKCE code from a deep link", () => {
    expect(parseAuthCallback("mealplanner://callback?code=abc-123")).toEqual({
      code: "abc-123",
      error: null,
      errorDescription: null,
    });
  });

  it("reads the code from a web URL and an Expo Go URL", () => {
    expect(parseAuthCallback("http://localhost:8081/callback?code=xyz").code).toBe("xyz");
    expect(parseAuthCallback("exp://192.168.1.5:8081/--/callback?code=xyz").code).toBe("xyz");
  });

  it("reads an error from the query", () => {
    const result = parseAuthCallback(
      "mealplanner://callback?error=access_denied&error_description=User+cancelled",
    );
    expect(result.code).toBeNull();
    expect(result.error).toBe("access_denied");
    expect(result.errorDescription).toBe("User cancelled");
  });

  it("reads an expired-link error from the fragment", () => {
    const result = parseAuthCallback(
      "http://localhost:8081/callback#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    );
    expect(result.error).toBe("access_denied");
    expect(result.errorDescription).toBe("Email link is invalid or has expired");
  });

  it("falls back to error_code when there is no error", () => {
    expect(parseAuthCallback("mealplanner://callback?error_code=otp_expired").error).toBe(
      "otp_expired",
    );
  });

  it("prefers the query over the fragment and decodes percent escapes", () => {
    const result = parseAuthCallback("mealplanner://callback?code=from%20query#code=from-fragment");
    expect(result.code).toBe("from query");
  });

  it("returns nulls when there is nothing to read", () => {
    expect(parseAuthCallback("mealplanner://callback")).toEqual({
      code: null,
      error: null,
      errorDescription: null,
    });
    expect(parseAuthCallback("mealplanner://callback?code=")).toMatchObject({ code: null });
  });
});
