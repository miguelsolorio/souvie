import { describe, expect, it } from "vitest";
import {
  createHandler,
  type ExportDeps,
  type ExportSection,
  type ExportSource,
  type Row,
} from "./handler.ts";

const url = "http://localhost:54321/functions/v1/export-data";
const ALICE = "a1111111-1111-4111-8111-111111111111";
const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";

/** An in-memory source that records which filters each query used. */
function fakeSource(tables: Record<string, Row[]>) {
  const calls: string[] = [];
  const source: ExportSource = {
    async select(table, eq) {
      calls.push(`select ${table} ${JSON.stringify(eq)}`);
      return (tables[table] ?? []).filter((row) =>
        Object.entries(eq).every(([column, value]) => row[column] === value),
      );
    },
    async rpc(fn, args) {
      calls.push(`rpc ${fn} ${JSON.stringify(args)}`);
      return fn === "list_household_members"
        ? [{ user_id: ALICE, role: "owner", display_name: "Alice" }]
        : [];
    },
  };
  return { source, calls };
}

const tables: Record<string, Row[]> = {
  profiles: [{ user_id: ALICE, display_name: "Alice", preferences: {} }],
  household_members: [
    { household_id: HOUSEHOLD, user_id: ALICE, role: "owner", created_at: "2026-10-01T00:00:00Z" },
    { household_id: "other", user_id: "someone-else", role: "owner", created_at: "2026-10-02" },
  ],
  households: [{ id: HOUSEHOLD, name: "Alice Home" }],
  household_invites: [{ household_id: HOUSEHOLD, token: "t" }],
  audit_events: [{ household_id: HOUSEHOLD, kind: "member_added" }],
};

function deps(overrides: Partial<ExportDeps> = {}) {
  const { source, calls } = fakeSource(tables);
  const merged: ExportDeps = {
    authenticate: async (token) =>
      token === "good" ? { id: ALICE, email: "a@example.test" } : null,
    sourceFor: () => source,
    now: () => new Date("2026-10-30T12:00:00Z"),
    ...overrides,
  };
  return { deps: merged, calls };
}

const request = (init: RequestInit = {}) => new Request(url, init);
const authed = (method = "POST") => request({ method, headers: { Authorization: "Bearer good" } });

describe("export-data", () => {
  it("rejects a request without a token", async () => {
    const res = await createHandler(deps().deps)(request({ method: "POST" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  it("rejects a token that does not belong to a user", async () => {
    const res = await createHandler(deps().deps)(
      request({ method: "POST", headers: { Authorization: "Bearer bad" } }),
    );
    expect(res.status).toBe(401);
  });

  it("returns the profile, memberships, and each household with roster, invites, and audit events", async () => {
    const res = await createHandler(deps().deps)(authed());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="meal-planner-export-2026-10-30.json"',
    );
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = await res.json();
    expect(body.exported_at).toBe("2026-10-30T12:00:00.000Z");
    expect(body.user).toEqual({ id: ALICE, email: "a@example.test" });
    expect(body.profile).toMatchObject({ display_name: "Alice" });
    expect(body.memberships).toHaveLength(1);
    expect(body.households).toHaveLength(1);
    expect(body.households[0]).toMatchObject({
      household: { name: "Alice Home" },
      members: [{ user_id: ALICE }],
      roster: [{ display_name: "Alice" }],
      invites: [{ token: "t" }],
      audit_events: [{ kind: "member_added" }],
    });
  });

  it("queries only the caller's own rows and households", async () => {
    const { deps: d, calls } = deps();
    await createHandler(d)(authed("GET"));
    expect(calls).toContain(`select profiles {"user_id":"${ALICE}"}`);
    expect(calls).toContain(`select household_members {"user_id":"${ALICE}"}`);
    expect(calls.every((c) => !c.includes('"other"'))).toBe(true);
  });

  it("runs sections added by later workstreams", async () => {
    const orders: ExportSection = { key: "orders", collect: async () => [{ id: "o1" }] };
    const { deps: d } = deps({ sections: [orders] });
    const body = await (await createHandler(d)(authed())).json();
    expect(body.orders).toEqual([{ id: "o1" }]);
    expect(body.households).toBeUndefined();
  });

  it("answers 500 without leaking the error when a query fails", async () => {
    const failing: ExportSource = {
      select: async () => {
        throw new Error("secret database detail");
      },
      rpc: async () => [],
    };
    const res = await createHandler(deps({ sourceFor: () => failing }).deps)(authed());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });

  it("answers CORS preflight and rejects other methods", async () => {
    const handler = createHandler(deps().deps);
    const preflight = await handler(request({ method: "OPTIONS" }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");
    expect((await handler(request({ method: "DELETE" }))).status).toBe(405);
  });
});
