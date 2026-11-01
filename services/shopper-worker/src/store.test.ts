import { readFileSync } from "node:fs";
import { canTransition, RUN_STATUSES } from "@mp/agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readConfig } from "./config.ts";
import { pushText, sendPush } from "./push.ts";
import { InvalidAllergyError, RunStore, rawTextsOf, unionAllergies } from "./store.ts";
import {
  ALICE,
  BOB,
  CONNECTION,
  createRunsTestDb,
  enqueue,
  HOUSEHOLD,
  type RunsTestDb,
  seedHousehold,
} from "./testing/fixtures.ts";

let t: RunsTestDb;

beforeAll(async () => {
  t = await createRunsTestDb();
  await seedHousehold(t);
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe("RunStore under service_role", () => {
  it("every transaction runs as service_role, which cannot create a table", async () => {
    const store = new RunStore(t.runner);
    const role = await store.inServiceRole((tx) =>
      tx.query<{ role: string }>("select current_user as role", []),
    );
    expect(role[0]?.role).toBe("service_role");
    await expect(
      store.inServiceRole((tx) => tx.query("create table public.__ws09_ddl (id int)", [])),
    ).rejects.toThrow(/permission denied/);
  });

  it("calls pgmq as the connection role, since the service role has no pgmq grant", async () => {
    const store = new RunStore(t.runner);
    await expect(
      store.inServiceRole((tx) => tx.query("select * from pgmq.read('shopping_run', 1, 1)", [])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      t.runner.query("select * from pgmq.read('shopping_run', 0, 1)", []),
    ).resolves.toBeDefined();
  });

  it("claims a run once", async () => {
    const runId = await enqueue(t);
    const store = new RunStore(t.runner);
    expect((await store.claim(runId))?.householdId).toBe(HOUSEHOLD);
    expect(await store.claim(runId)).toBeNull();
    expect(await store.requeue({ id: runId, householdId: HOUSEHOLD })).toBe(true);
    expect((await store.claim(runId))?.id).toBe(runId);
    await store.fail(runId, "test over");
  });

  it("loads the list without excluded or checked lines, with the recipe lines", async () => {
    const runId = await enqueue(t);
    const store = new RunStore(t.runner);
    await t.exec(
      `update public.grocery_list_items set checked = true where display_name = 'Carrots'`,
    );
    const run = await store.claim(runId);
    if (!run) throw new Error("no run");
    const input = await store.loadPlanningInput(run);
    expect(input.lines).toHaveLength(11);
    expect(input.lines.find((l) => l.displayName === "Diced tomatoes")?.rawTexts).toEqual([
      "2 (14.5 oz) cans diced tomatoes",
    ]);
    expect(input.connection).toMatchObject({
      id: CONNECTION,
      retailer: "kroger",
      storeId: "MOCK0001",
      status: "active",
    });
    await t.exec(
      `update public.grocery_list_items set checked = false where display_name = 'Carrots'`,
    );
    await store.fail(runId, "test over");
  });

  it("calls only the allowed WS07 functions", async () => {
    const store = new RunStore(t.runner);
    expect((await store.rpc("retailer_disconnect", {})).error?.message).toMatch(/not allowed/);
    const quota = await store.rpc("retailer_quota_consume", {
      p_retailer: "kroger",
      p_endpoint: "products",
      p_day: "2026-10-31",
      p_ceiling: 9500,
      p_amount: 1,
    });
    expect(quota).toEqual({ data: [{ allowed: true, used: 1 }], error: null });
    const token = await store.rpc("retailer_read_refresh_token", { p_connection_id: CONNECTION });
    expect(token).toEqual({ data: null, error: null });
  });
});

describe("helpers", () => {
  it("unions the members' allergies and fails closed on a value outside the vocabulary", () => {
    expect(
      unionAllergies([
        { allergies: ["milk"] },
        { allergies: ["peanut", "milk"] },
        {},
        { diets: [] },
      ]),
    ).toEqual(["milk", "peanut"]);
    expect(() => unionAllergies([{ allergies: ["milk", "lupine"] }])).toThrow(InvalidAllergyError);
  });

  it("reads the recipe lines out of an item's detail", () => {
    expect(
      rawTextsOf({ contributions: [{ rawTexts: ["2 cans", "2 cans"] }, { rawTexts: ["1 can"] }] }),
    ).toEqual(["2 cans", "1 can"]);
    expect(rawTextsOf(null)).toEqual([]);
  });

  it("reads the config without logging a value", () => {
    const config = readConfig({
      WORKER_DATABASE_URL: "postgres://x",
      WORKER_CONCURRENCY: "99",
      WORKER_HEARTBEAT_SECONDS: "1",
    });
    expect(config).toMatchObject({
      concurrency: 8,
      heartbeatSeconds: 5,
      retailerMode: "live",
      aiDailyCapUsd: 2,
    });
    expect(() => readConfig({})).toThrow(/WORKER_DATABASE_URL/);
    expect(() => readConfig({ WORKER_DATABASE_URL: "x", WORKER_RETAILER_MODE: "cloud" })).toThrow(
      /live or mock/,
    );
    // Three beats fit inside the one sweep threshold, whatever the env asks for.
    expect(
      readConfig({ WORKER_DATABASE_URL: "x", WORKER_HEARTBEAT_SECONDS: "300" }).heartbeatSeconds,
    ).toBe(30);
  });

  it("refuses the mock store in production", () => {
    expect(() =>
      readConfig({
        WORKER_DATABASE_URL: "x",
        WORKER_RETAILER_MODE: "mock",
        NODE_ENV: "production",
      }),
    ).toThrow(/mock is refused when NODE_ENV is production/);
    expect(
      readConfig({ WORKER_DATABASE_URL: "x", WORKER_RETAILER_MODE: "mock", NODE_ENV: "test" })
        .retailerMode,
    ).toBe("mock");
    expect(readConfig({ WORKER_DATABASE_URL: "x", NODE_ENV: "production" }).retailerMode).toBe(
      "live",
    );
  });

  it("builds the image on the repo's Node version", () => {
    const pinned = readFileSync(new URL("../../../.node-version", import.meta.url), "utf8").trim();
    const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    expect(dockerfile).toContain(`FROM node:${pinned}-slim AS base`);
  });
});

describe("the household's allergies, read from the database", () => {
  it("are the union over every member of this household, and only this household", async () => {
    const CAROL = "c3333333-3333-4333-8333-3333333333a9";
    const DAVE = "d4444444-4444-4444-8444-4444444444a9";
    await t.exec(`
      insert into auth.users (id, email) values
        ('${CAROL}', 'carol-ws09@example.test'), ('${DAVE}', 'dave-ws09@example.test');
      insert into public.household_members (household_id, user_id, role) values
        ('${HOUSEHOLD}', '${CAROL}', 'member'), ('${HOUSEHOLD}', '${DAVE}', 'member');
      update public.profiles set preferences = '{"allergies": ["peanut"]}'::jsonb where user_id = '${ALICE}';
      update public.profiles set preferences = '{"allergies": ["milk", "sesame"]}'::jsonb where user_id = '${CAROL}';
      update public.profiles set preferences = '{"allergies": ["shellfish"]}'::jsonb where user_id = '${BOB}';
    `);
    try {
      await t.exec(
        `update public.shopping_runs set status = 'cancelled' where status in ('queued', 'running', 'needs_review')`,
      );
      const runId = await enqueue(t);
      const store = new RunStore(t.runner);
      const run = await store.claim(runId);
      if (!run) throw new Error("no run");
      // Owner alice (peanut), member carol (milk, sesame), member dave who never answered, and
      // bob of the other household (shellfish), who must not leak in.
      expect((await store.loadPlanningInput(run)).allergies).toEqual(["milk", "peanut", "sesame"]);
    } finally {
      await t.exec(`
        delete from public.household_members where user_id in ('${CAROL}', '${DAVE}');
        update public.profiles set preferences = '{}'::jsonb where user_id in ('${ALICE}', '${BOB}');
      `);
    }
  });
});

describe("the run state machine in SQL and in TypeScript", () => {
  it("has the same statuses and allows exactly the same moves", async () => {
    const statuses = await t.query<{ status: string }>(
      "select unnest(enum_range(null::public.shopping_runs_status))::text as status",
      [],
    );
    expect(statuses.map((row) => row.status)).toEqual([...RUN_STATUSES]);
    const pairs = await t.query<{ from: string; to: string; ok: boolean }>(
      `select f::text as from, s::text as to, public.shopping_run_transition_allowed(f, s) as ok
         from unnest(enum_range(null::public.shopping_runs_status)) f,
              unnest(enum_range(null::public.shopping_runs_status)) s
        where f <> s`,
      [],
    );
    expect(pairs).toHaveLength(RUN_STATUSES.length * (RUN_STATUSES.length - 1));
    const differ = pairs.filter(
      (pair) =>
        pair.ok !==
        canTransition(
          pair.from as (typeof RUN_STATUSES)[number],
          pair.to as (typeof RUN_STATUSES)[number],
        ),
    );
    expect(differ).toEqual([]);
  });
});

describe("push notifications", () => {
  it("say the store and the subtotal, never an item", () => {
    expect(
      pushText({ type: "cart_ready", runId: "r", storeName: "QFC Duvall", subtotalUsd: 142.17 })
        .body,
    ).toBe("Cart ready at QFC Duvall, $142.17. Review and pay.");
    expect(pushText({ type: "needs_review", runId: "r", count: 3 }).body).toBe(
      "3 items need your call",
    );
    expect(pushText({ type: "needs_review", runId: "r", count: 1 }).body).toBe(
      "1 item needs your call",
    );
  });

  it("sends to Expo and reports tokens that no longer reach a device", async () => {
    const requests: Array<{ url: string; body: unknown; auth: string | null }> = [];
    const fetch = (async (url: string, init: RequestInit) => {
      requests.push({
        url,
        body: JSON.parse(String(init.body)),
        auth: new Headers(init.headers).get("authorization"),
      });
      return new Response(
        JSON.stringify({
          data: [{ status: "ok" }, { status: "error", details: { error: "DeviceNotRegistered" } }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;
    const result = await sendPush(
      ["ExponentPushToken[a]", "ExponentPushToken[b]", "not-a-token"],
      { type: "needs_review", runId: "r", count: 2 },
      { fetch, accessToken: "secret" },
    );
    expect(result).toEqual({ sent: 1, invalid: ["ExponentPushToken[b]"], errors: [] });
    expect(requests[0]?.url).toBe("https://exp.host/--/api/v2/push/send");
    expect(requests[0]?.auth).toBe("Bearer secret");
    expect(requests[0]?.body).toEqual([
      {
        to: "ExponentPushToken[a]",
        title: "Review your cart",
        body: "2 items need your call",
        data: { type: "needs_review", runId: "r", count: 2 },
        sound: "default",
      },
      {
        to: "ExponentPushToken[b]",
        title: "Review your cart",
        body: "2 items need your call",
        data: { type: "needs_review", runId: "r", count: 2 },
        sound: "default",
      },
    ]);
  });
});
