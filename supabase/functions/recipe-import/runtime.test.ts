import { afterEach, describe, expect, it, vi } from "vitest";

// client.ts is the only module that loads supabase-js, so a stub keeps this test offline.
vi.mock("./client.ts", () => ({ createClient: () => ({}) }));

import { runtimeFromEnv } from "./index.ts";

const ENV: Record<string, string> = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_ANON_KEY: "anon-test-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
};
const env = (name: string) => ENV[name];
const denoEnv = { get: env };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runtimeFromEnv and the DNS check", () => {
  it("logs one warning, and has no resolver, when Deno.resolveDns is absent", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runtime = runtimeFromEnv(env, { env: denoEnv });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("DNS check");
    expect(runtime.resolveHost).toBeUndefined();
  });

  it("logs the same warning when there is no Deno at all", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    runtimeFromEnv(env);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("stays quiet and resolves A and AAAA records when Deno.resolveDns exists", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const resolveDns = vi.fn(async (_host: string, type: "A" | "AAAA") =>
      type === "A" ? ["93.184.216.34"] : ["2606:2800:220:1::1"],
    );
    const runtime = runtimeFromEnv(env, { env: denoEnv, resolveDns });
    expect(warn).not.toHaveBeenCalled();
    await expect(runtime.resolveHost?.("example.test")).resolves.toEqual([
      "93.184.216.34",
      "2606:2800:220:1::1",
    ]);
  });

  it("fails the lookup when a name has no address", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const resolveDns = vi.fn(async () => {
      throw new Error("NXDOMAIN");
    });
    const runtime = runtimeFromEnv(env, { env: denoEnv, resolveDns });
    await expect(runtime.resolveHost?.("nope.test")).rejects.toThrow("no address for nope.test");
  });
});
