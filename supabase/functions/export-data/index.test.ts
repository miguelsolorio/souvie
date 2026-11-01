import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createHandler,
  type ExportDeps,
  type ExportSection,
  type ExportSource,
  ORDER,
  type Row,
  SHOPPING_RUN_COLUMNS,
  SHOPPING_RUN_ITEM_COLUMNS,
} from "./handler.ts";

const url = "http://localhost:54321/functions/v1/export-data";
const ALICE = "a1111111-1111-4111-8111-111111111111";
const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";

/** An in-memory source that records which filters and sort order each query used. */
function fakeSource(tables: Record<string, Row[]>) {
  const calls: string[] = [];
  /** The column list each table was read with, when it had one. */
  const columns: Record<string, readonly string[]> = {};
  const source: ExportSource = {
    async select(table, eq, order, wanted) {
      calls.push(`select ${table} ${JSON.stringify(eq)} order ${order.join(",")}`);
      if (wanted) columns[table] = wanted;
      return (tables[table] ?? [])
        .filter((row) => Object.entries(eq).every(([column, value]) => row[column] === value))
        .map((row) =>
          // A real read returns only the columns asked for.
          wanted
            ? Object.fromEntries(Object.entries(row).filter(([key]) => wanted.includes(key)))
            : row,
        );
    },
    async rpc(fn, args) {
      calls.push(`rpc ${fn} ${JSON.stringify(args)}`);
      return fn === "list_household_members"
        ? [{ user_id: ALICE, role: "owner", display_name: "Alice" }]
        : [];
    },
  };
  return { source, calls, columns };
}

const tables: Record<string, Row[]> = {
  profiles: [{ user_id: ALICE, display_name: "Alice", preferences: {} }],
  household_members: [
    { household_id: HOUSEHOLD, user_id: ALICE, role: "owner", created_at: "2026-10-01T00:00:00Z" },
    { household_id: "other", user_id: "someone-else", role: "owner", created_at: "2026-10-02" },
  ],
  households: [{ id: HOUSEHOLD, name: "Alice Home" }],
  household_invites: [{ household_id: HOUSEHOLD, token: "secret-invite-token", used_at: null }],
  audit_events: [{ household_id: HOUSEHOLD, kind: "member_added" }],
  // WS12. One household's rows and another's, so a leak shows.
  orders: [
    { id: "o1", household_id: HOUSEHOLD, run_id: "r1", total_usd: 100, confirmed_at: "2026-11-02" },
    {
      id: "o-other",
      household_id: "other",
      run_id: "r-other",
      total_usd: 7,
      confirmed_at: "2026-11-02",
    },
  ],
  shopping_runs: [
    {
      id: "r1",
      household_id: HOUSEHOLD,
      status: "cart_ready",
      store_name: "Mock QFC Duvall",
      subtotal_usd: 98,
      created_at: "2026-11-02",
      transcript: [{ tool: "search_products", output_summary: "secret-transcript-line" }],
      cart_snapshot: { summary: "secret-cart-snapshot" },
    },
    { id: "r-other", household_id: "other", status: "cart_ready", created_at: "2026-11-02" },
  ],
  shopping_run_items: [
    {
      id: "i1",
      run_id: "r1",
      household_id: HOUSEHOLD,
      product_name: "Harbor Fields Yellow Onions",
      cart_qty: 1,
      created_at: "2026-11-02",
      alternatives: [{ name: "secret-alternative" }],
    },
    { id: "i-other", run_id: "r-other", household_id: "other", created_at: "2026-11-02" },
  ],
  meal_plan_entries: [
    { id: "e1", household_id: HOUSEHOLD, date: "2026-11-03", status: "cooked" },
    { id: "e-other", household_id: "other", date: "2026-11-03", status: "cooked" },
  ],
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
      'attachment; filename="souvie-export-2026-10-30.json"',
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
      invites: [{ token: "[redacted]", used_at: null }],
      audit_events: [{ kind: "member_added" }],
    });
  });

  it("never puts an invite token in the file", async () => {
    const res = await createHandler(deps().deps)(authed());
    expect(JSON.stringify(await res.json())).not.toContain("secret-invite-token");
  });

  it("asks for every table in a total order so pages are stable", async () => {
    const { deps: d, calls } = deps();
    await createHandler(d)(authed());
    expect(calls).toContain(
      `select profiles {"user_id":"${ALICE}"} order ${ORDER.profiles.join(",")}`,
    );
    expect(calls).toContain(
      `select household_invites {"household_id":"${HOUSEHOLD}"} order created_at,id`,
    );
    expect(calls).toContain(
      `select audit_events {"household_id":"${HOUSEHOLD}"} order created_at,id`,
    );
    for (const call of calls.filter((c) => c.startsWith("select "))) {
      expect(call, call).toMatch(/ order \S+/);
    }
  });

  it("queries only the caller's own rows and households", async () => {
    const { deps: d, calls } = deps();
    await createHandler(d)(authed("GET"));
    expect(calls.some((c) => c.startsWith(`select profiles {"user_id":"${ALICE}"}`))).toBe(true);
    expect(calls.some((c) => c.startsWith(`select household_members {"user_id":"${ALICE}"}`))).toBe(
      true,
    );
    expect(calls.every((c) => !c.includes('"other"'))).toBe(true);
  });

  it("includes the household's orders, runs, run lines and meal plan entries (WS12)", async () => {
    const res = await createHandler(deps().deps)(authed());
    const body = await res.json();
    expect(body.orders).toEqual([expect.objectContaining({ id: "o1", total_usd: 100 })]);
    expect(body.shopping_runs).toEqual([
      expect.objectContaining({ id: "r1", status: "cart_ready", store_name: "Mock QFC Duvall" }),
    ]);
    expect(body.shopping_run_items).toEqual([
      expect.objectContaining({ id: "i1", product_name: "Harbor Fields Yellow Onions" }),
    ]);
    expect(body.meal_plan_entries).toEqual([expect.objectContaining({ id: "e1" })]);
  });

  it("leaves the transcript, the cart snapshot and the search alternatives out of the file", async () => {
    const res = await createHandler(deps().deps)(authed());
    const body = await res.json();
    const [run] = body.shopping_runs;
    expect(run).not.toHaveProperty("transcript");
    expect(run).not.toHaveProperty("cart_snapshot");
    expect(body.shopping_run_items[0]).not.toHaveProperty("alternatives");
    const text = JSON.stringify(body);
    expect(text).not.toContain("secret-transcript-line");
    expect(text).not.toContain("secret-cart-snapshot");
    expect(text).not.toContain("secret-alternative");
  });

  it("asks the database for the allowed columns, so a transcript never leaves it", async () => {
    const { deps: d, columns } = (() => {
      const made = fakeSource(tables);
      return { deps: deps({ sourceFor: () => made.source }).deps, columns: made.columns };
    })();
    await createHandler(d)(authed());
    expect(columns.shopping_runs).toBe(SHOPPING_RUN_COLUMNS);
    expect(columns.shopping_run_items).toBe(SHOPPING_RUN_ITEM_COLUMNS);
    expect(columns.shopping_runs).not.toContain("transcript");
    expect(columns.shopping_runs).not.toContain("cart_snapshot");
    expect(columns.shopping_run_items).not.toContain("alternatives");
  });

  it("reads the WS12 tables only for the caller's own households, each in a total order", async () => {
    const { deps: d, calls } = deps();
    const body = await (await createHandler(d)(authed())).json();
    for (const table of ["orders", "shopping_runs", "shopping_run_items", "meal_plan_entries"]) {
      const call = `select ${table} {"household_id":"${HOUSEHOLD}"} order ${ORDER[table as keyof typeof ORDER].join(",")}`;
      expect(calls, table).toContain(call);
    }
    expect(JSON.stringify(body)).not.toContain("other");
    expect(calls.every((c) => !c.includes('"other"'))).toBe(true);
  });

  it("reads each WS12 table once per household, for a caller in two", async () => {
    const second = "0b000000-0000-4000-8000-00000000000b";
    const two: Record<string, Row[]> = {
      ...tables,
      household_members: [
        ...(tables.household_members ?? []),
        {
          household_id: second,
          user_id: ALICE,
          role: "member",
          created_at: "2026-10-05T00:00:00Z",
        },
      ],
      orders: [
        ...(tables.orders ?? []),
        { id: "o2", household_id: second, confirmed_at: "2026-11-03" },
      ],
    };
    const made = fakeSource(two);
    const body = await (
      await createHandler(deps({ sourceFor: () => made.source }).deps)(authed())
    ).json();
    expect(body.orders.map((o: Row) => o.id).sort()).toEqual(["o1", "o2"]);
    expect(made.calls.filter((c) => c.startsWith("select orders "))).toHaveLength(2);
  });

  it("exports every column of the run tables except the ones it leaves out", () => {
    // The column lists are written out, so a column added to a table later would silently stay
    // out of the export. The generated types list every column; this fails until the list does.
    const types = readFileSync(
      fileURLToPath(new URL("../../../packages/db/src/types.generated.ts", import.meta.url)),
      "utf8",
    );
    const columnsOf = (table: string): string[] => {
      const block = new RegExp(
        `\n      ${table}: \\{\n        Row: \\{\n([\\s\\S]*?)\n        \\};`,
      ).exec(types);
      if (!block?.[1]) throw new Error(`${table} is not in types.generated.ts`);
      return [...block[1].matchAll(/^\s+(\w+):/gm)].map((m) => m[1] ?? "");
    };
    const runs = columnsOf("shopping_runs").filter(
      (c) => !["transcript", "cart_snapshot"].includes(c),
    );
    expect([...SHOPPING_RUN_COLUMNS].sort()).toEqual(runs.sort());
    const items = columnsOf("shopping_run_items").filter((c) => c !== "alternatives");
    expect([...SHOPPING_RUN_ITEM_COLUMNS].sort()).toEqual(items.sort());
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
