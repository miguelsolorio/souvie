// The schedule math twice: packages/core/src/schedule.ts (what the editor previews) and the SQL
// functions in the WS11 migration (what the scheduler runs). They must agree on every instant, or
// the editor would promise one time and the cron job keep another. Also the generators that need a
// table WS12 owns, run against a stand-in with docs/02's columns.
import { isValidCron, nextRunAt, resolveTargetWeekStart } from "@mp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWs11TestDb, type Ws11TestDb } from "./testing/ws11.ts";

let t: Ws11TestDb;

beforeAll(async () => {
  t = await createWs11TestDb();
}, 120_000);

afterAll(async () => {
  await t?.close();
});

const CRONS = [
  "0 9 * * 6",
  "30 2 * * *",
  "30 1 * * *",
  "0 18 * * 1-5",
  "15 0 * * 0",
  "45 23 * * 0,6",
  "0 0 * * 1",
  "59 23 * * 7",
];

const ZONES = [
  "America/Los_Angeles",
  "America/New_York",
  "America/St_Johns",
  "Europe/London",
  "Asia/Kolkata",
  "Pacific/Auckland",
  "Australia/Lord_Howe",
  "UTC",
];

/** Rows of [from, sqlNext] for one cron and zone, from a series of instants. */
async function sqlNexts(
  cron: string,
  tz: string,
  series: string,
): Promise<Array<[string, string]>> {
  const rows = await t.query<{ f: string; n: string }>(
    `select to_char(f at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as f,
            to_char(public.scheduled_run_next($1, $2, f) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as n
       from (${series}) as s(f)`,
    [cron, tz],
  );
  return rows.map((row) => [row.f, row.n]);
}

describe("scheduled_run_next agrees with nextRunAt", () => {
  it("over most of 2026, for every cron and zone", async () => {
    // Every 7h 13m from the end of February to mid November: all weekdays, hours and minutes.
    const series =
      "select generate_series(timestamptz '2026-02-25 00:00+00', timestamptz '2026-11-15 00:00+00', interval '7 hours 13 minutes')";
    const mismatches: string[] = [];
    let checked = 0;
    for (const tz of ZONES) {
      for (const cron of CRONS) {
        for (const [from, sql] of await sqlNexts(cron, tz, series)) {
          const ts = nextRunAt(cron, tz, new Date(from)).toISOString();
          checked += 1;
          if (ts !== sql) mismatches.push(`${cron} ${tz} from ${from}: ts ${ts} sql ${sql}`);
        }
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(checked).toBeGreaterThan(10_000);
  }, 120_000);

  it("minute by minute around each daylight saving change", async () => {
    // Twenty minute steps, 30 hours either side of the changes in the zones above.
    const changes: Array<[string, string]> = [
      ["America/Los_Angeles", "2026-03-08 10:00+00"],
      ["America/Los_Angeles", "2026-11-01 09:00+00"],
      ["America/New_York", "2026-03-08 07:00+00"],
      ["America/New_York", "2026-11-01 06:00+00"],
      ["America/St_Johns", "2026-03-08 05:30+00"],
      ["Europe/London", "2026-03-29 01:00+00"],
      ["Europe/London", "2026-10-25 01:00+00"],
      ["Pacific/Auckland", "2026-04-04 14:00+00"],
      ["Pacific/Auckland", "2026-09-26 14:00+00"],
      ["Australia/Lord_Howe", "2026-04-04 15:00+00"],
      ["Australia/Lord_Howe", "2026-10-03 15:30+00"],
    ];
    const mismatches: string[] = [];
    let checked = 0;
    for (const [tz, at] of changes) {
      const series = `select generate_series(timestamptz '${at}' - interval '30 hours', timestamptz '${at}' + interval '30 hours', interval '20 minutes')`;
      for (const cron of [
        "30 2 * * *",
        "30 1 * * *",
        "0 2 * * *",
        "0 3 * * *",
        "30 0 * * *",
        "0 9 * * 6",
        "0 9 * * 0",
      ]) {
        for (const [from, sql] of await sqlNexts(cron, tz, series)) {
          const ts = nextRunAt(cron, tz, new Date(from)).toISOString();
          checked += 1;
          if (ts !== sql) mismatches.push(`${cron} ${tz} from ${from}: ts ${ts} sql ${sql}`);
        }
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(checked).toBeGreaterThan(5_000);
  }, 120_000);
});

describe("scheduled_run_target_week agrees with resolveTargetWeekStart", () => {
  it("for every hour over a few weeks, in two zones", async () => {
    const mismatches: string[] = [];
    for (const tz of ["America/Los_Angeles", "Pacific/Auckland", "UTC"]) {
      const rows = await t.query<{ f: string; w: string }>(
        `select to_char(f at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as f,
                public.scheduled_run_target_week(f, $1)::text as w
           from generate_series(timestamptz '2026-10-20 00:00+00', timestamptz '2026-11-20 00:00+00', interval '1 hour') as f`,
        [tz],
      );
      for (const row of rows) {
        const ts = resolveTargetWeekStart(new Date(row.f), tz);
        if (ts !== row.w) mismatches.push(`${tz} ${row.f}: ts ${ts} sql ${row.w}`);
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
  });
});

describe("cron validity agrees", () => {
  const candidates = [
    "0 9 * * 6",
    "00 09 * * 06",
    "0 9 * * 7",
    "0 9 * * 0",
    "0 9 * * 8",
    "0 9 * * 5-7",
    "0 9 * * 7-5",
    "0 9 * * 1,3,5",
    "0 9 * * 1,",
    "0 9 * * ,1",
    "  0 9 * * 6  ",
    "0\t9 * * 6",
    "0 9 * * 6\n",
    "0 9  *  * 6",
    "59 23 * * *",
    "60 0 * * *",
    "0 24 * * *",
    "0 9 * * *",
    "0 9 1 * *",
    "0 9 * 1 *",
    "*/15 * * * *",
    "0 9-17 * * 1-5",
    "0 9 * * mon",
    "0 9 * *",
    "0 9 * * 6 2026",
    "",
    "nope",
    "1 2 3 4 5",
  ];

  it("accepts and refuses the same strings", async () => {
    const disagree: string[] = [];
    for (const cron of candidates) {
      const [row] = await t.query<{ ok: boolean }>(
        "select public.scheduled_run_cron_is_valid($1) as ok",
        [cron],
      );
      if (isValidCron(cron) !== row?.ok) disagree.push(JSON.stringify(cron));
    }
    expect(disagree).toEqual([]);
  });
});

describe("pickup reminders (reads WS12's orders table)", () => {
  const HOUSEHOLD = "0a000000-0000-4000-8000-0000000000f1";
  const USER = "a1111111-1111-4111-8111-1111111111f1";
  const RUN = "3f000000-0000-4000-8000-0000000000f1";

  it("does nothing while there is no orders table", async () => {
    const [row] = await t.query<{ n: number }>("select public.enqueue_pickup_reminders() as n");
    expect(row?.n).toBe(0);
  });

  it("writes one reminder an hour before a confirmed pickup window, once", async () => {
    // docs/02's orders table, as far as the generator reads it.
    await t.exec(`
      create table public.orders (
        id uuid primary key default gen_random_uuid(),
        household_id uuid not null references public.households (id),
        run_id uuid,
        slot_start timestamptz,
        slot_end timestamptz,
        status text not null default 'confirmed'
      );
      insert into auth.users (id, email) values ('${USER}', 'f1@example.test');
      insert into public.households (id, name, created_by) values ('${HOUSEHOLD}', 'Pickup', '${USER}');
      insert into public.household_members (household_id, user_id, role) values ('${HOUSEHOLD}', '${USER}', 'owner');
      insert into public.orders (id, household_id, run_id, slot_start, status) values
        ('0d000000-0000-4000-8000-0000000000f1', '${HOUSEHOLD}', '${RUN}', '2026-11-08 01:30+00', 'confirmed'),
        ('0d000000-0000-4000-8000-0000000000f2', '${HOUSEHOLD}', null, '2026-11-08 01:40+00', 'cancelled'),
        ('0d000000-0000-4000-8000-0000000000f3', '${HOUSEHOLD}', null, null, 'confirmed'),
        ('0d000000-0000-4000-8000-0000000000f4', '${HOUSEHOLD}', null, '2026-11-09 18:00+00', 'confirmed');
    `);
    // 00:35 UTC: the first window opens in 55 minutes. The later one is a day away.
    const [first] = await t.query<{ n: number }>(
      "select public.enqueue_pickup_reminders(interval '1 hour', timestamptz '2026-11-08 00:35+00') as n",
    );
    expect(first?.n).toBe(1);
    const rows = await t.query<{
      type: string;
      payload: Record<string, unknown>;
      deliver_after: Date;
    }>(
      "select type::text as type, payload, deliver_after from public.notification_outbox where household_id = $1",
      [HOUSEHOLD],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("pickup_reminder");
    expect(rows[0]?.payload).toEqual({
      type: "pickup_reminder",
      orderId: "0d000000-0000-4000-8000-0000000000f1",
      runId: RUN,
      slotStart: "2026-11-08T01:30:00Z",
    });
    // Sent at once: the window is already less than an hour away.
    expect(new Date(rows[0]?.deliver_after ?? 0).toISOString()).toBe("2026-11-08T00:35:00.000Z");

    const [again] = await t.query<{ n: number }>(
      "select public.enqueue_pickup_reminders(interval '1 hour', timestamptz '2026-11-08 00:50+00') as n",
    );
    expect(again?.n).toBe(0);
    // The next day's window gets its reminder when it comes within the hour.
    const [later] = await t.query<{ n: number }>(
      "select public.enqueue_pickup_reminders(interval '1 hour', timestamptz '2026-11-09 17:00+00') as n",
    );
    expect(later?.n).toBe(1);
  });
});
