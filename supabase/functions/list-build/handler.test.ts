import { describe, expect, it, vi } from "vitest";
import { LIST_BUILD_ERROR_MESSAGES, ListBuildResponse } from "../../../packages/core/src/index.ts";
import { handleListBuild, MAX_BODY_BYTES, type Runtime } from "./handler.ts";
import { NoPlanError } from "./store.ts";

const USER = "a1111111-1111-4111-8111-111111111111";
const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const LIST = "1a000000-0000-4000-8000-0000000000a1";

const RESULT = {
  ok: true as const,
  listId: LIST,
  itemCount: 24,
  needsAttentionCount: 2,
  alreadyHaveCount: 6,
  planVersion: 1,
  skippedEntryCount: 0,
  rebuilt: false,
};

function runtime(overrides: Partial<Runtime["store"]> = {}, auth = true) {
  const store = {
    resolveHousehold: vi.fn(async () => ({ kind: "member", householdId: HOUSEHOLD }) as const),
    build: vi.fn(async () => RESULT),
    ...overrides,
  };
  const value: Runtime = {
    authenticate: vi.fn(async () => (auth ? { userId: USER } : null)),
    store,
    now: () => new Date("2026-11-01T18:00:00.000Z"),
  };
  return { value, store };
}

function request(body: unknown, init: { method?: string; auth?: string | null } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.auth !== null) headers.Authorization = init.auth ?? "Bearer token";
  return new Request("http://localhost/functions/v1/list-build", {
    method: init.method ?? "POST",
    headers,
    ...(init.method === "GET"
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

async function read(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe("handleListBuild", () => {
  it("builds the list and answers with the contract's shape", async () => {
    const { value, store } = runtime();
    const response = await handleListBuild(request({ weekStart: "2026-11-02" }), value);
    expect(response.status).toBe(200);
    const body = await read(response);
    expect(ListBuildResponse.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ listId: LIST, itemCount: 24, needsAttentionCount: 2 });
    expect(store.build).toHaveBeenCalledWith({
      householdId: HOUSEHOLD,
      weekStart: "2026-11-02",
      now: new Date("2026-11-01T18:00:00.000Z"),
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("builds for the household in the body, after the membership check", async () => {
    const { value, store } = runtime();
    await handleListBuild(request({ weekStart: "2026-11-02", householdId: HOUSEHOLD }), value);
    expect(store.resolveHousehold).toHaveBeenCalledWith(USER, HOUSEHOLD);
  });

  it("answers the preflight without a body or a token", async () => {
    const { value } = runtime();
    const response = await handleListBuild(request("", { method: "OPTIONS", auth: null }), value);
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("allows POST only", async () => {
    const { value } = runtime();
    const response = await handleListBuild(request("", { method: "GET" }), value);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST, OPTIONS");
  });

  it("refuses a request with no token, a malformed header, or a token that does not check out", async () => {
    const none = runtime();
    expect(
      (await handleListBuild(request({ weekStart: "2026-11-02" }, { auth: null }), none.value))
        .status,
    ).toBe(401);
    expect(
      (
        await handleListBuild(
          request({ weekStart: "2026-11-02" }, { auth: "Basic abc" }),
          none.value,
        )
      ).status,
    ).toBe(401);
    const bad = runtime({}, false);
    const response = await handleListBuild(request({ weekStart: "2026-11-02" }), bad.value);
    expect(response.status).toBe(401);
    expect(await read(response)).toEqual({
      ok: false,
      error: "unauthorized",
      message: LIST_BUILD_ERROR_MESSAGES.unauthorized,
    });
    expect(bad.store.build).not.toHaveBeenCalled();
    expect(none.store.build).not.toHaveBeenCalled();
  });

  it("treats a failing auth service as unauthorized, not as an internal error", async () => {
    const { value } = runtime();
    value.authenticate = vi.fn(async () => {
      throw new Error("auth is down");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await handleListBuild(request({ weekStart: "2026-11-02" }), value);
    spy.mockRestore();
    expect(response.status).toBe(401);
  });

  it.each([
    ["not json", "{nope"],
    ["no weekStart", {}],
    ["a Tuesday", { weekStart: "2026-11-03" }],
    ["a bad date", { weekStart: "2026-02-31" }],
    ["a bad household id", { weekStart: "2026-11-02", householdId: "nope" }],
    ["a number", { weekStart: 20261102 }],
    ["an array", []],
  ])("rejects %s as invalid_request", async (_name, body) => {
    const { value, store } = runtime();
    const response = await handleListBuild(request(body), value);
    expect(response.status).toBe(400);
    expect((await read(response)).error).toBe("invalid_request");
    expect(store.build).not.toHaveBeenCalled();
  });

  it("rejects a body over the size limit before reading it as json", async () => {
    const { value } = runtime();
    const response = await handleListBuild(
      request(`{"weekStart":"2026-11-02","pad":"${"x".repeat(MAX_BODY_BYTES)}"}`),
      value,
    );
    expect(response.status).toBe(413);
  });

  it("refuses a household the caller is not in, and a caller with none", async () => {
    const stranger = runtime({
      resolveHousehold: vi.fn(async () => ({ kind: "not_a_member" }) as const),
    });
    const forbidden = await handleListBuild(
      request({ weekStart: "2026-11-02", householdId: HOUSEHOLD }),
      stranger.value,
    );
    expect(forbidden.status).toBe(403);
    expect((await read(forbidden)).error).toBe("not_a_member");
    expect(stranger.store.build).not.toHaveBeenCalled();

    const lonely = runtime({
      resolveHousehold: vi.fn(async () => ({ kind: "no_household" }) as const),
    });
    const none = await handleListBuild(request({ weekStart: "2026-11-02" }), lonely.value);
    expect(none.status).toBe(403);
    expect((await read(none)).error).toBe("no_household");
  });

  it("answers 200 with no_plan when the week has nothing planned", async () => {
    const { value } = runtime({
      build: vi.fn(async () => {
        throw new NoPlanError();
      }),
    });
    const response = await handleListBuild(request({ weekStart: "2026-11-02" }), value);
    expect(response.status).toBe(200);
    expect(await read(response)).toEqual({
      ok: false,
      error: "no_plan",
      message: LIST_BUILD_ERROR_MESSAGES.no_plan,
    });
  });

  it("hides the cause of a failure from the body and logs it", async () => {
    const { value } = runtime({
      build: vi.fn(async () => {
        throw new Error("password authentication failed for user postgres");
      }),
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await handleListBuild(request({ weekStart: "2026-11-02" }), value);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    expect(response.status).toBe(500);
    const text = JSON.stringify(await read(response));
    expect(text).not.toContain("password");
    expect(text).toContain("internal_error");
  });
});
