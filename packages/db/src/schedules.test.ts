import { describe, expect, it } from "vitest";
import type { MpClient } from "./client";
import {
  createDefaultSchedule,
  createSchedule,
  deleteSchedule,
  fetchNotificationPreferences,
  fetchNotificationSettings,
  fetchScheduleConnections,
  fetchSchedules,
  forgetPushTokenBySecret,
  registerPushToken,
  SCHEDULE_COLUMNS,
  ScheduleApiError,
  saveNotificationSettings,
  setNotificationPreference,
  toScheduleApiError,
  updateSchedule,
} from "./schedules";

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const CONNECTION = "7a000000-0000-4000-8000-0000000000a1";
const SCHEDULE_ID = "5a000000-0000-4000-8000-0000000000a1";

type Result = { data: unknown; error: unknown };

interface Call {
  table: string;
  op: string;
  payload?: unknown;
  filters: Array<[string, unknown]>;
}

/**
 * A stand-in for the slice of supabase-js these functions use. Results are queued per
 * `table:op`; the last one repeats. Every request is logged.
 */
function stub(results: Record<string, Result[]> = {}) {
  const calls: Call[] = [];
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  const next = (key: string): Result => {
    const queue = results[key] ?? [];
    const head = queue.length > 1 ? queue.shift() : queue[0];
    return head ?? { data: [], error: null };
  };
  const from = (table: string) => {
    const call: Call = { table, op: "select", filters: [] };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.select = chain;
    builder.order = chain;
    builder.limit = chain;
    builder.single = chain;
    builder.maybeSingle = () => {
      call.op = `${call.op}:maybe`;
      return builder;
    };
    builder.insert = (payload: unknown) => {
      call.op = "insert";
      call.payload = payload;
      return builder;
    };
    builder.update = (payload: unknown) => {
      call.op = "update";
      call.payload = payload;
      return builder;
    };
    builder.delete = () => {
      call.op = "delete";
      return builder;
    };
    builder.eq = (column: string, value: unknown) => {
      call.filters.push([column, value]);
      return builder;
    };
    // biome-ignore lint/suspicious/noThenProperty: a thenable stands in for the PostgREST builder.
    builder.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) => {
      calls.push(call);
      const key = `${table}:${call.op.replace(":maybe", "")}`;
      return Promise.resolve(next(key)).then(resolve, reject);
    };
    return builder;
  };
  const rpc = (fn: string, args: unknown) => {
    rpcCalls.push({ fn, args });
    return Promise.resolve(next(`rpc:${fn}`));
  };
  return { client: { from, rpc } as unknown as MpClient, calls, rpcCalls };
}

const row = (overrides: Record<string, unknown> = {}) => ({
  id: SCHEDULE_ID,
  household_id: HOUSEHOLD,
  cron: "0 9 * * 6",
  tz: "America/Los_Angeles",
  connection_id: CONNECTION,
  policy: { budget_cap_usd: 150 },
  next_run_at: "2026-11-07T17:00:00+00:00",
  last_enqueued_for: null,
  enabled: true,
  created_at: "2026-10-31T12:00:00+00:00",
  updated_at: "2026-10-31T12:00:00+00:00",
  ...overrides,
});

const input = {
  cron: "0 9 * * 6",
  tz: "America/Los_Angeles",
  connection_id: CONNECTION,
  policy: { budget_cap_usd: 150, substitution: "same_brand" as const },
  enabled: true,
};

describe("toScheduleApiError", () => {
  it("words what the database says", () => {
    expect(toScheduleApiError({ message: "too_many_schedules", code: "P0001" }).code).toBe(
      "too_many_schedules",
    );
    expect(toScheduleApiError({ message: "connection_not_found", code: "P0001" }).code).toBe(
      "connection_not_found",
    );
    expect(toScheduleApiError({ message: "invalid_cron", code: "P0001" }).code).toBe(
      "invalid_schedule",
    );
    expect(toScheduleApiError({ message: "invalid_time_zone", code: "P0001" }).code).toBe(
      "invalid_time_zone",
    );
    expect(
      toScheduleApiError({ message: "new row violates row-level security policy", code: "42501" })
        .code,
    ).toBe("not_owner");
    expect(
      toScheduleApiError({
        message: 'violates check constraint "households_quiet_hours_valid"',
        code: "23514",
      }).code,
    ).toBe("invalid_quiet_hours");
    expect(toScheduleApiError({ message: "TypeError: Failed to fetch", code: "" }).code).toBe(
      "network",
    );
    expect(toScheduleApiError({ message: "boom", code: "XX000" }).code).toBe("internal_error");
  });

  it("never shows the raw database message", () => {
    expect(
      toScheduleApiError({ message: "relation scheduled_runs exploded", code: "XX000" }).message,
    ).not.toMatch(/relation|exploded/);
  });
});

describe("schedules", () => {
  it("reads a household's schedules, soonest first", async () => {
    const { client, calls } = stub({ "scheduled_runs:select": [{ data: [row()], error: null }] });
    const found = await fetchSchedules(client, HOUSEHOLD);
    expect(found).toHaveLength(1);
    expect(found[0]?.cron).toBe("0 9 * * 6");
    expect(calls[0]?.filters).toEqual([["household_id", HOUSEHOLD]]);
  });

  it("refuses a row that is not a schedule", async () => {
    const { client } = stub({ "scheduled_runs:select": [{ data: [{ id: "x" }], error: null }] });
    await expect(fetchSchedules(client, HOUSEHOLD)).rejects.toBeInstanceOf(ScheduleApiError);
  });

  it("creates a schedule without sending next_run_at or last_enqueued_for", async () => {
    const { client, calls } = stub({ "scheduled_runs:insert": [{ data: row(), error: null }] });
    const made = await createSchedule(client, HOUSEHOLD, input, SCHEDULE_ID);
    expect(made.id).toBe(SCHEDULE_ID);
    const sent = calls[0]?.payload as Record<string, unknown>;
    expect(sent).toEqual({
      id: SCHEDULE_ID,
      household_id: HOUSEHOLD,
      cron: "0 9 * * 6",
      tz: "America/Los_Angeles",
      connection_id: CONNECTION,
      policy: { budget_cap_usd: 150, substitution: "same_brand" },
      enabled: true,
    });
    expect(sent).not.toHaveProperty("next_run_at");
    expect(sent).not.toHaveProperty("last_enqueued_for");
  });

  it("treats a retry that hits a duplicate id as the schedule the first try made", async () => {
    const { client, calls } = stub({
      "scheduled_runs:insert": [
        { data: null, error: { message: "duplicate key value", code: "23505" } },
      ],
      "scheduled_runs:select": [{ data: row(), error: null }],
    });
    const made = await createSchedule(client, HOUSEHOLD, input, SCHEDULE_ID);
    expect(made.id).toBe(SCHEDULE_ID);
    expect(calls.map((c) => c.op)).toEqual(["insert", "select:maybe"]);
  });

  it("explains an owner-only refusal", async () => {
    const { client } = stub({
      "scheduled_runs:insert": [
        { data: null, error: { message: "new row violates row-level security", code: "42501" } },
      ],
    });
    await expect(createSchedule(client, HOUSEHOLD, input)).rejects.toMatchObject({
      code: "not_owner",
    });
  });

  it("edits only the columns it is given", async () => {
    const { client, calls } = stub({
      "scheduled_runs:update": [{ data: [row({ enabled: false })], error: null }],
    });
    const changed = await updateSchedule(client, HOUSEHOLD, SCHEDULE_ID, { enabled: false });
    expect(changed.enabled).toBe(false);
    expect(calls[0]?.payload).toEqual({ enabled: false });
    expect(calls[0]?.filters).toEqual([
      ["household_id", HOUSEHOLD],
      ["id", SCHEDULE_ID],
    ]);
  });

  it("reports no rows changed as not allowed (RLS hides a member's edit as zero rows)", async () => {
    const { client } = stub({ "scheduled_runs:update": [{ data: [], error: null }] });
    await expect(
      updateSchedule(client, HOUSEHOLD, SCHEDULE_ID, { enabled: false }),
    ).rejects.toMatchObject({ code: "not_owner" });
    const second = stub({ "scheduled_runs:delete": [{ data: [], error: null }] });
    await expect(deleteSchedule(second.client, HOUSEHOLD, SCHEDULE_ID)).rejects.toMatchObject({
      code: "not_owner",
    });
  });

  it("deletes a schedule", async () => {
    const { client, calls } = stub({
      "scheduled_runs:delete": [{ data: [{ id: SCHEDULE_ID }], error: null }],
    });
    await expect(deleteSchedule(client, HOUSEHOLD, SCHEDULE_ID)).resolves.toBeUndefined();
    expect(calls[0]?.op).toBe("delete");
  });

  it("asks for the columns clients may read", () => {
    expect(SCHEDULE_COLUMNS).toContain("next_run_at");
    expect(SCHEDULE_COLUMNS).not.toContain("*");
  });
});

describe("connections and the default schedule", () => {
  const connections = (rows: Array<Record<string, unknown>>) => ({
    "retailer_connections:select": [{ data: rows, error: null }],
  });
  const kroger = {
    id: CONNECTION,
    retailer: "kroger",
    store_name: "QFC Duvall",
    status: "active",
    auth_type: "none",
  };

  it("marks a Tier 3 connection as one that cannot run unattended", async () => {
    const { client } = stub(
      connections([
        kroger,
        { ...kroger, id: "c2", retailer: "safeway", auth_type: "browser_session" },
      ]),
    );
    const found = await fetchScheduleConnections(client, HOUSEHOLD);
    expect(found.map((c) => [c.id, c.unattended])).toEqual([
      [CONNECTION, true],
      ["c2", false],
    ]);
  });

  it("makes Saturday 9:00 at the household's default store", async () => {
    const { client, calls } = stub({
      ...connections([
        { ...kroger, id: "other-store" },
        kroger,
        { ...kroger, id: "tier3", retailer: "costco", auth_type: "browser_session" },
      ]),
      "households:select": [{ data: { default_connection_id: CONNECTION }, error: null }],
      "scheduled_runs:select": [{ data: [], error: null }],
      "scheduled_runs:insert": [{ data: row(), error: null }],
    });
    await createDefaultSchedule(client, HOUSEHOLD, "America/Los_Angeles");
    const sent = calls.find((c) => c.op === "insert")?.payload as Record<string, unknown>;
    expect(sent).toMatchObject({
      cron: "0 9 * * 6",
      tz: "America/Los_Angeles",
      connection_id: CONNECTION,
      enabled: true,
      policy: { substitution: "same_brand" },
    });
  });

  it("skips a store that needs a new sign-in or runs on the phone", async () => {
    const { client } = stub({
      ...connections([
        { ...kroger, id: "stale", status: "needs_reauth" },
        { ...kroger, id: "tier3", auth_type: "browser_session" },
      ]),
      "households:select": [{ data: { default_connection_id: null }, error: null }],
    });
    await expect(createDefaultSchedule(client, HOUSEHOLD)).rejects.toMatchObject({
      code: "no_connection",
    });
  });

  it("returns the schedule it already made instead of a second one", async () => {
    const { client, calls } = stub({
      ...connections([kroger]),
      "households:select": [{ data: { default_connection_id: null }, error: null }],
      "scheduled_runs:select": [{ data: [row()], error: null }],
    });
    const made = await createDefaultSchedule(client, HOUSEHOLD);
    expect(made.id).toBe(SCHEDULE_ID);
    expect(calls.some((c) => c.op === "insert")).toBe(false);
  });
});

describe("quiet hours and preferences", () => {
  it("reads quiet hours and the zone, and treats junk as none", async () => {
    const good = stub({
      "households:select": [
        {
          data: { timezone: "America/Los_Angeles", quiet_hours: { start: "21:00", end: "07:00" } },
          error: null,
        },
      ],
    });
    expect(await fetchNotificationSettings(good.client, HOUSEHOLD)).toEqual({
      timezone: "America/Los_Angeles",
      quietHours: { start: "21:00", end: "07:00" },
    });
    const junk = stub({
      "households:select": [
        { data: { timezone: null, quiet_hours: { start: "9pm" } }, error: null },
      ],
    });
    expect(await fetchNotificationSettings(junk.client, HOUSEHOLD)).toEqual({
      timezone: null,
      quietHours: null,
    });
  });

  it("saves, clears, and refuses quiet hours; only the owner's update changes a row", async () => {
    const saved = stub({ "households:update": [{ data: [{ id: HOUSEHOLD }], error: null }] });
    await saveNotificationSettings(saved.client, HOUSEHOLD, {
      quietHours: { start: "21:00", end: "07:00" },
      timezone: "America/Los_Angeles",
    });
    expect(saved.calls[0]?.payload).toEqual({
      quiet_hours: { start: "21:00", end: "07:00" },
      timezone: "America/Los_Angeles",
    });
    await saveNotificationSettings(saved.client, HOUSEHOLD, { quietHours: null });
    expect(saved.calls[1]?.payload).toEqual({ quiet_hours: null });
    await expect(
      saveNotificationSettings(saved.client, HOUSEHOLD, {
        quietHours: { start: "21:00", end: "21:00" },
      }),
    ).rejects.toThrow();
    const member = stub({ "households:update": [{ data: [], error: null }] });
    await expect(
      saveNotificationSettings(member.client, HOUSEHOLD, { quietHours: null }),
    ).rejects.toMatchObject({ code: "not_owner" });
  });

  it("answers every type, on unless the person turned it off", async () => {
    const { client } = stub({
      "notification_preferences:select": [
        {
          data: [
            { type: "items_need_review", enabled: false },
            { type: "bogus", enabled: false },
          ],
          error: null,
        },
      ],
    });
    const prefs = await fetchNotificationPreferences(client, "u1");
    expect(prefs.items_need_review).toBe(false);
    expect(prefs.cart_ready).toBe(true);
    expect(Object.keys(prefs).sort()).toEqual(
      [
        "cart_ready",
        "import_finished",
        "items_need_review",
        "pickup_reminder",
        "run_failed",
        "schedule_skipped",
        "weekly_nudge",
      ].sort(),
    );
  });

  it("writes a preference and a device through the functions, never the tables", async () => {
    const { client, rpcCalls, calls } = stub({
      "rpc:set_notification_preference": [{ data: null, error: null }],
      "rpc:register_push_token": [{ data: null, error: null }],
      "rpc:forget_push_token": [{ data: null, error: null }],
    });
    await setNotificationPreference(client, "weekly_nudge", false);
    await registerPushToken(client, "ExponentPushToken[abc]", "ios");
    await forgetPushTokenBySecret(client, "ExponentPushToken[abc]");
    expect(rpcCalls).toEqual([
      { fn: "set_notification_preference", args: { p_type: "weekly_nudge", p_enabled: false } },
      { fn: "register_push_token", args: { p_token: "ExponentPushToken[abc]", p_platform: "ios" } },
      { fn: "forget_push_token", args: { p_token: "ExponentPushToken[abc]" } },
    ]);
    expect(calls).toHaveLength(0);
  });
});
