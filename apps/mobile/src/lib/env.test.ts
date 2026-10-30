import { describe, expect, it } from "vitest";
import { readSupabaseEnv } from "./env";

describe("readSupabaseEnv", () => {
  it("returns url and anon key when both are set", () => {
    expect(
      readSupabaseEnv({ supabaseUrl: " http://127.0.0.1:54321 ", supabaseAnonKey: "anon" }),
    ).toEqual({ url: "http://127.0.0.1:54321", anonKey: "anon" });
  });

  it("returns null when either value is missing or blank", () => {
    expect(readSupabaseEnv({})).toBeNull();
    expect(readSupabaseEnv({ supabaseUrl: "http://127.0.0.1:54321" })).toBeNull();
    expect(readSupabaseEnv({ supabaseUrl: "  ", supabaseAnonKey: "anon" })).toBeNull();
  });

  it("throws on a malformed or non-http URL", () => {
    expect(() => readSupabaseEnv({ supabaseUrl: "not a url", supabaseAnonKey: "anon" })).toThrow(
      /not a valid URL/,
    );
    expect(() =>
      readSupabaseEnv({ supabaseUrl: "ftp://example.com", supabaseAnonKey: "anon" }),
    ).toThrow(/http or https/);
  });
});
