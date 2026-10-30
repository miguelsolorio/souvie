import { describe, expect, it } from "vitest";
import health, { VERSION } from "./index.ts";

const url = "http://localhost:54321/functions/v1/health";

describe("health Edge Function", () => {
  it("returns ok and the version on GET", async () => {
    const res = await health.fetch(new Request(url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ ok: true, version: VERSION });
  });

  it("accepts POST, which supabase-js functions.invoke sends by default", async () => {
    const res = await health.fetch(new Request(url, { method: "POST", body: "{}" }));
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("answers CORS preflight so the web app can call it", async () => {
    const res = await health.fetch(new Request(url, { method: "OPTIONS" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-headers")).toContain("apikey");
  });

  it("rejects other methods", async () => {
    const res = await health.fetch(new Request(url, { method: "DELETE" }));
    expect(res.status).toBe(405);
  });
});
