// The WS11 push rules on the real migrations (PGlite): preferences, quiet hours, the outbox drain,
// and the copy. Time is always passed in.
import type { NotificationPayload } from "@mp/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NotificationStore,
  Notifier,
  OUTBOX_LEASE_SECONDS,
  OUTBOX_MAX_ATTEMPTS,
  OutboxDrain,
  type Send,
} from "./notifications.ts";
import { pushText, sendPush, shortDate } from "./push.ts";
import { recorder } from "./testing/fixtures.ts";
import { createWs11TestDb, type Ws11TestDb } from "./testing/ws11.ts";

const HOME = "0a000000-0000-4000-8000-0000000000e1";
const OTHER = "0b000000-0000-4000-8000-0000000000e1";
const ALICE = "a1111111-1111-4111-8111-1111111111e1";
const CAROL = "c3333333-3333-4333-8333-3333333333e1";
const BOB = "b2222222-2222-4222-8222-2222222222e1";
const RUN_ID = "3e000000-0000-4000-8000-0000000000e1";
const LIST = "9e000000-0000-4000-8000-0000000000e1";
const CONNECTION = "7e000000-0000-4000-8000-0000000000e1";

let t: Ws11TestDb;

beforeAll(async () => {
  t = await createWs11TestDb();
}, 120_000);

afterAll(async () => {
  await t?.close();
});

beforeEach(async () => {
  await t.exec(`
    delete from public.notification_outbox;
    delete from public.notification_preferences;
    delete from public.push_tokens;
    delete from public.shopping_runs;
    delete from public.grocery_lists;
    delete from public.retailer_connections;
    delete from public.household_members;
    delete from public.households;
    delete from auth.users;
    insert into auth.users (id, email) values
      ('${ALICE}', 'alice-e1@example.test'),
      ('${CAROL}', 'carol-e1@example.test'),
      ('${BOB}', 'bob-e1@example.test');
    insert into public.households (id, name, created_by, timezone) values
      ('${HOME}', 'Home', '${ALICE}', 'America/Los_Angeles'),
      ('${OTHER}', 'Other', '${BOB}', 'America/Los_Angeles');
    insert into public.household_members (household_id, user_id, role) values
      ('${HOME}', '${ALICE}', 'owner'),
      ('${HOME}', '${CAROL}', 'member'),
      ('${OTHER}', '${BOB}', 'owner');
    insert into public.push_tokens (user_id, token, platform) values
      ('${ALICE}', 'ExponentPushToken[alice]', 'ios'),
      ('${CAROL}', 'ExponentPushToken[carol]', 'android'),
      ('${BOB}', 'ExponentPushToken[bob]', 'ios');
  `);
});

interface Sent {
  tokens: string[];
  payload: NotificationPayload;
  timeZone: string;
}

function makeSender(overrides: { invalid?: string[]; errors?: string[]; sentCount?: number } = {}) {
  const calls: Sent[] = [];
  const send: Send = async (tokens, payload, options) => {
    calls.push({ tokens: [...tokens].sort(), payload, timeZone: options.timeZone });
    return {
      sent: overrides.sentCount ?? tokens.length - (overrides.invalid?.length ?? 0),
      invalid: overrides.invalid ?? [],
      errors: overrides.errors ?? [],
    };
  };
  return { calls, send };
}

function setup(sender: Send, now: Date | (() => Date)) {
  const clock = typeof now === "function" ? now : () => now;
  const log = recorder();
  const store = new NotificationStore(t.runner);
  const notifier = new Notifier({ store, send: sender, log, now: clock });
  const drain = new OutboxDrain({ store, notifier, log, intervalSeconds: 30, now: clock });
  return { store, notifier, drain, log };
}

const cartReady: NotificationPayload = {
  type: "cart_ready",
  runId: RUN_ID,
  storeName: "QFC Duvall",
  subtotalUsd: 142.1,
};
const needsReview: NotificationPayload = { type: "needs_review", runId: RUN_ID, count: 3 };

const QUIET = `'{"start": "21:00", "end": "07:00"}'::jsonb`;

describe("the words of a push", () => {
  it("cart_ready says what happens next and never that the order was placed (R19)", () => {
    const text = pushText(cartReady);
    expect(text.body).toBe(
      "Your cart at QFC Duvall is ready ($142.10). Tap to review, then pick a pickup time and pay in the store's app.",
    );
    expect(text.body).not.toMatch(/order (was|has been) placed|purchased|paid for/i);
  });

  it("names the store and the subtotal and nothing from the cart", () => {
    for (const payload of [
      cartReady,
      needsReview,
      { type: "run_failed", runId: RUN_ID, scheduled: true },
      { type: "weekly_nudge", weekStart: "2026-11-09" },
    ] as NotificationPayload[]) {
      const { title, body } = pushText(payload);
      expect(`${title} ${body}`).not.toMatch(/—|–/);
    }
  });

  it("explains each reason a scheduled run was skipped", () => {
    const reasons = [
      "no_active_list",
      "connection_not_found",
      "connection_inactive",
      "tier3_unattended",
      "run_in_progress",
      "daily_run_limit",
      "invalid_policy",
      "missed",
      "internal_error",
    ] as const;
    const bodies = reasons.map(
      (reason) =>
        pushText({
          type: "schedule_skipped",
          scheduleId: RUN_ID,
          reason,
          weekStart: "2026-11-09",
        }).body,
    );
    expect(new Set(bodies).size).toBeGreaterThanOrEqual(7);
    expect(bodies[0]).toContain("Nov 9");
    for (const body of bodies) expect(body).toMatch(/skipped|cannot start|could not start/);
  });

  it("reads the pickup window on the household's clock", () => {
    const payload: NotificationPayload = {
      type: "pickup_reminder",
      orderId: RUN_ID,
      runId: null,
      slotStart: "2026-11-07T01:30:00Z",
    };
    expect(pushText(payload, { timeZone: "America/Los_Angeles" }).body).toBe(
      "Your pickup window starts at 5:30 PM.",
    );
    expect(pushText(payload, { timeZone: "UTC" }).body).toBe(
      "Your pickup window starts at 1:30 AM.",
    );
  });

  it("formats a week start", () => {
    expect(shortDate("2026-11-09")).toBe("Nov 9");
    expect(shortDate("garbage")).toBe("garbage");
  });

  it("marks a held review high priority when it goes to Expo", async () => {
    const bodies: Array<Array<Record<string, unknown>>> = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ data: [{ status: "ok" }] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    await sendPush(
      ["ExponentPushToken[a]"],
      { ...needsReview, urgent: true } as NotificationPayload,
      { fetch },
    );
    await sendPush(["ExponentPushToken[a]"], needsReview, { fetch });
    expect(bodies[0]?.[0]).toMatchObject({ priority: "high" });
    expect(bodies[1]?.[0]).not.toHaveProperty("priority");
  });
});

describe("Notifier: preferences and quiet hours", () => {
  const afternoon = new Date("2026-11-07T20:00:00Z"); // 12:00 in Los Angeles

  it("sends cart_ready to every member of the household and to nobody else", async () => {
    const sender = makeSender();
    const { notifier } = setup(sender.send, afternoon);
    const result = await notifier.notifyRun(HOME, cartReady);
    expect(result.sent).toBe(2);
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]?.tokens).toEqual([
      "ExponentPushToken[alice]",
      "ExponentPushToken[carol]",
    ]);
    expect(sender.calls[0]?.timeZone).toBe("America/Los_Angeles");
  });

  it("skips a member who turned the type off while another member still gets it", async () => {
    await t.exec(`
      insert into public.notification_preferences (user_id, type, enabled)
      values ('${ALICE}', 'items_need_review', false);
    `);
    const sender = makeSender();
    const { notifier } = setup(sender.send, afternoon);
    await notifier.notifyRun(HOME, needsReview);
    expect(sender.calls[0]?.tokens).toEqual(["ExponentPushToken[carol]"]);
    // Her other types are untouched.
    await notifier.notifyRun(HOME, cartReady);
    expect(sender.calls[1]?.tokens).toEqual([
      "ExponentPushToken[alice]",
      "ExponentPushToken[carol]",
    ]);
  });

  it("sends nothing when everyone turned the type off", async () => {
    await t.exec(`
      insert into public.notification_preferences (user_id, type, enabled) values
        ('${ALICE}', 'cart_ready', false), ('${CAROL}', 'cart_ready', false);
    `);
    const sender = makeSender();
    const { notifier } = setup(sender.send, afternoon);
    const result = await notifier.notifyRun(HOME, cartReady);
    expect(result).toMatchObject({ sent: 0, attempted: 0 });
    expect(sender.calls).toHaveLength(0);
  });

  it("holds a push inside quiet hours and reports when it will go out", async () => {
    await t.exec(`update public.households set quiet_hours = ${QUIET} where id = '${HOME}'`);
    const sender = makeSender();
    // 22:00 on Friday 2026-11-06 in Los Angeles (PST, UTC-8).
    const { notifier } = setup(sender.send, new Date("2026-11-07T06:00:00Z"));
    const result = await notifier.notifyRun(HOME, cartReady);
    expect(sender.calls).toHaveLength(0);
    expect(result.sent).toBe(0);
    expect(result.deferredUntil?.toISOString()).toBe("2026-11-07T15:00:00.000Z"); // 07:00 PST
    const rows = await t.query<{ type: string; deliver_after: Date; payload: NotificationPayload }>(
      "select type::text as type, deliver_after, payload from public.notification_outbox where household_id = $1",
      [HOME],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("cart_ready");
    expect(new Date(rows[0]?.deliver_after ?? 0).toISOString()).toBe("2026-11-07T15:00:00.000Z");
    expect(rows[0]?.payload).toMatchObject({
      runId: RUN_ID,
      storeName: "QFC Duvall",
      subtotalUsd: 142.1,
    });
  });

  it("holds a review too, flagged urgent, because the run waits on the person", async () => {
    await t.exec(`update public.households set quiet_hours = ${QUIET} where id = '${HOME}'`);
    const sender = makeSender();
    const { notifier } = setup(sender.send, new Date("2026-11-07T08:00:00Z")); // 00:00 PST
    const result = await notifier.notifyRun(HOME, needsReview);
    expect(result.deferredUntil?.toISOString()).toBe("2026-11-07T15:00:00.000Z");
    const [row] = await t.query<{ type: string; payload: Record<string, unknown> }>(
      "select type::text as type, payload from public.notification_outbox where household_id = $1",
      [HOME],
    );
    expect(row?.type).toBe("items_need_review");
    expect(row?.payload).toMatchObject({ type: "needs_review", count: 3, urgent: true });
  });

  it("reads quiet hours in the household's zone, not UTC", async () => {
    await t.exec(`update public.households set quiet_hours = ${QUIET} where id = '${HOME}'`);
    const sender = makeSender();
    // 04:00Z on 2026-11-07 is 20:00 on the 6th in Los Angeles: not quiet yet, though it is night in UTC.
    const { notifier } = setup(sender.send, new Date("2026-11-07T04:00:00Z"));
    const result = await notifier.notifyRun(HOME, cartReady);
    expect(result.deferredUntil).toBeUndefined();
    expect(sender.calls).toHaveLength(1);
  });

  it("uses America/Los_Angeles when the household has set no zone", async () => {
    await t.exec(
      `update public.households set timezone = null, quiet_hours = ${QUIET} where id = '${HOME}'`,
    );
    const sender = makeSender();
    const { notifier } = setup(sender.send, new Date("2026-11-07T08:00:00Z"));
    const result = await notifier.notifyRun(HOME, cartReady);
    expect(result.deferredUntil?.toISOString()).toBe("2026-11-07T15:00:00.000Z");
  });

  it("deletes the token Expo says is dead, in this household only", async () => {
    await t.exec(`
      insert into public.push_tokens (user_id, token, platform)
      values ('${BOB}', 'ExponentPushToken[carol]', 'ios')
      on conflict do nothing;
    `);
    const sender = makeSender({ invalid: ["ExponentPushToken[carol]"] });
    const { notifier } = setup(sender.send, afternoon);
    await notifier.notifyRun(HOME, cartReady);
    const left = await t.query<{ user_id: string; token: string }>(
      "select user_id, token from public.push_tokens order by token, user_id",
    );
    // Carol's row is gone; Bob's row with the same token string belongs to another household.
    expect(left.map((r) => `${r.user_id}:${r.token}`)).toEqual([
      `${ALICE}:ExponentPushToken[alice]`,
      `${BOB}:ExponentPushToken[bob]`,
      `${BOB}:ExponentPushToken[carol]`,
    ]);
  });
});

describe("OutboxDrain", () => {
  const noon = new Date("2026-11-07T20:00:00Z");

  async function addRow(
    payload: NotificationPayload,
    options: { type?: string; deliverAfter?: string; dedupeKey?: string; household?: string } = {},
  ) {
    const [row] = await t.query<{ id: string }>(
      `select public.notification_outbox_add($1::uuid, $2::public.notification_type, $3::text::jsonb, $4::timestamptz, $5) as id`,
      [
        options.household ?? HOME,
        options.type ?? (payload.type === "needs_review" ? "items_need_review" : payload.type),
        JSON.stringify(payload),
        options.deliverAfter ?? "2026-11-07T19:00:00Z",
        options.dedupeKey ?? null,
      ],
    );
    return row?.id as string;
  }

  async function rowOf(id: string) {
    const [row] = await t.query<{
      sent_at: Date | null;
      attempts: number;
      last_error: string | null;
      deliver_after: Date;
    }>(
      "select sent_at, attempts, last_error, deliver_after from public.notification_outbox where id = $1",
      [id],
    );
    return row as NonNullable<typeof row>;
  }

  it("sends a due row once, to the members who want it, and marks it sent", async () => {
    const id = await addRow({ type: "weekly_nudge", weekStart: "2026-11-09" });
    const sender = makeSender();
    const { drain } = setup(sender.send, noon);
    expect(await drain.drainOnce()).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]?.payload).toMatchObject({
      type: "weekly_nudge",
      weekStart: "2026-11-09",
    });
    expect(sender.calls[0]?.tokens).toEqual([
      "ExponentPushToken[alice]",
      "ExponentPushToken[carol]",
    ]);
    expect((await rowOf(id)).sent_at).not.toBeNull();
    // Nothing is left to send.
    expect(await drain.drainOnce()).toMatchObject({ claimed: 0 });
    expect(sender.calls).toHaveLength(1);
  });

  it("does not send a row that is not due yet", async () => {
    await addRow(
      { type: "weekly_nudge", weekStart: "2026-11-09" },
      { deliverAfter: "2026-11-07T21:00:00Z" },
    );
    const sender = makeSender();
    const { drain } = setup(sender.send, noon);
    expect(await drain.drainOnce()).toMatchObject({ claimed: 0 });
    expect(sender.calls).toHaveLength(0);
  });

  it("honours a person's preference for each type", async () => {
    await t.exec(`
      insert into public.notification_preferences (user_id, type, enabled)
      values ('${ALICE}', 'weekly_nudge', false);
    `);
    await addRow({ type: "weekly_nudge", weekStart: "2026-11-09" });
    const sender = makeSender();
    const { drain } = setup(sender.send, noon);
    await drain.drainOnce();
    expect(sender.calls[0]?.tokens).toEqual(["ExponentPushToken[carol]"]);
  });

  it("moves a row due in quiet hours to their end, without counting an attempt", async () => {
    await t.exec(`update public.households set quiet_hours = ${QUIET} where id = '${HOME}'`);
    const id = await addRow(
      { type: "weekly_nudge", weekStart: "2026-11-09" },
      { deliverAfter: "2026-11-07T05:00:00Z" },
    );
    const sender = makeSender();
    // 23:30 on the 6th in Los Angeles.
    const night = setup(sender.send, new Date("2026-11-07T07:30:00Z"));
    expect(await night.drain.drainOnce()).toMatchObject({ claimed: 0, deferred: 1 });
    const held = await rowOf(id);
    expect(held.sent_at).toBeNull();
    expect(held.attempts).toBe(0);
    expect(new Date(held.deliver_after).toISOString()).toBe("2026-11-07T15:00:00.000Z");
    expect(sender.calls).toHaveLength(0);
    // At 07:00 it goes out.
    const morning = setup(sender.send, new Date("2026-11-07T15:00:30Z"));
    expect(await morning.drain.drainOnce()).toMatchObject({ claimed: 1, sent: 1 });
    expect((await rowOf(id)).sent_at).not.toBeNull();
  });

  it("retries a failed send after the lease, and stops after the last attempt", async () => {
    const id = await addRow({ type: "weekly_nudge", weekStart: "2026-11-09" });
    const sender = makeSender({ sentCount: 0, errors: ["expo push answered 500"] });
    let clock = noon;
    const { drain } = setup(sender.send, () => clock);
    expect(await drain.drainOnce()).toMatchObject({ claimed: 1, sent: 0, failed: 1 });
    let row = await rowOf(id);
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe("expo push answered 500");
    expect(row.sent_at).toBeNull();
    // Inside the lease nothing is retried.
    expect(await drain.drainOnce()).toMatchObject({ claimed: 0 });
    // After the lease it is tried again, up to the limit.
    for (let attempt = 2; attempt <= OUTBOX_MAX_ATTEMPTS; attempt++) {
      clock = new Date(clock.getTime() + (OUTBOX_LEASE_SECONDS + 1) * 1000);
      expect(await drain.drainOnce()).toMatchObject({ claimed: 1, failed: 1 });
      row = await rowOf(id);
      expect(row.attempts).toBe(attempt);
    }
    clock = new Date(clock.getTime() + (OUTBOX_LEASE_SECONDS + 1) * 1000);
    expect(await drain.drainOnce()).toMatchObject({ claimed: 0 });
    expect((await rowOf(id)).sent_at).toBeNull();
  });

  it("marks a row sent when nobody in the household has a device", async () => {
    await t.exec("delete from public.push_tokens");
    const id = await addRow({ type: "weekly_nudge", weekStart: "2026-11-09" });
    const sender = makeSender();
    const { drain } = setup(sender.send, noon);
    expect(await drain.drainOnce()).toMatchObject({ claimed: 1, sent: 1 });
    expect(sender.calls).toHaveLength(0);
    expect((await rowOf(id)).sent_at).not.toBeNull();
  });

  it("drops a held review once the run is no longer waiting", async () => {
    await t.exec(`
      insert into public.grocery_lists (id, household_id, name) values ('${LIST}', '${HOME}', 'List');
      insert into public.retailer_connections (id, household_id, user_id, retailer, auth_type, status)
        values ('${CONNECTION}', '${HOME}', '${ALICE}', 'kroger', 'none', 'active');
      insert into public.shopping_runs (id, household_id, list_id, connection_id, retailer, status)
        values ('${RUN_ID}', '${HOME}', '${LIST}', '${CONNECTION}', 'kroger', 'needs_review');
    `);
    const stale = await addRow({ ...needsReview, urgent: true } as NotificationPayload);
    const sender = makeSender();
    const { drain } = setup(sender.send, noon);
    // Still waiting: it goes.
    expect(await drain.drainOnce()).toMatchObject({ sent: 1, skipped: 0 });
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]?.payload).toMatchObject({ urgent: true });

    // The person approved in the app before the quiet hours ended: the push would be stale.
    const later = await addRow({ ...needsReview, urgent: true } as NotificationPayload, {
      dedupeKey: "again",
    });
    await t.exec(`update public.shopping_runs set status = 'cancelled' where id = '${RUN_ID}'`);
    expect(await drain.drainOnce()).toMatchObject({ sent: 0, skipped: 1 });
    expect(sender.calls).toHaveLength(1);
    expect((await rowOf(later)).last_error).toBe("stale: the run moved on");
    expect((await rowOf(stale)).sent_at).not.toBeNull();
  });

  it("never sends a row whose payload is not a notification", async () => {
    const [bad] = await t.query<{ id: string }>(
      `insert into public.notification_outbox (household_id, type, payload, deliver_after)
       values ($1, 'weekly_nudge', '{"type": "marketing"}', '2026-11-07T19:00:00Z') returning id`,
      [HOME],
    );
    const sender = makeSender();
    const { drain } = setup(sender.send, noon);
    expect(await drain.drainOnce()).toMatchObject({ claimed: 0 });
    expect(sender.calls).toHaveLength(0);
    const row = await rowOf(bad?.id as string);
    expect(row.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(row.last_error).toContain("not a notification");
  });

  it("keeps one row per dedupe key", async () => {
    await addRow(
      { type: "weekly_nudge", weekStart: "2026-11-09" },
      { dedupeKey: "weekly_nudge:home:2026-11-09" },
    );
    const again = await addRow(
      { type: "weekly_nudge", weekStart: "2026-11-09" },
      { dedupeKey: "weekly_nudge:home:2026-11-09" },
    );
    expect(again).toBeNull();
    const [{ n } = { n: 0 }] = await t.query<{ n: number }>(
      "select count(*)::int as n from public.notification_outbox",
    );
    expect(n).toBe(1);
  });

  it("delivers the rows SQL writes: a slow import and a failed run", async () => {
    await t.exec(`
      insert into public.grocery_lists (id, household_id, name) values ('${LIST}', '${HOME}', 'List');
      insert into public.retailer_connections (id, household_id, user_id, retailer, auth_type, status)
        values ('${CONNECTION}', '${HOME}', '${ALICE}', 'kroger', 'none', 'active');
      insert into public.shopping_runs (id, household_id, list_id, connection_id, retailer, status)
        values ('${RUN_ID}', '${HOME}', '${LIST}', '${CONNECTION}', 'kroger', 'running');
      update public.shopping_runs set status = 'failed', error = 'stalled: no heartbeat for 90 seconds'
       where id = '${RUN_ID}';
    `);
    const sender = makeSender();
    const { drain } = setup(sender.send, new Date(Date.now() + 60_000));
    expect(await drain.drainOnce()).toMatchObject({ claimed: 1, sent: 1 });
    expect(sender.calls[0]?.payload).toEqual({
      type: "run_failed",
      runId: RUN_ID,
      scheduled: false,
    });
  });
});

describe("stopping the drain (SIGTERM)", () => {
  const noon = new Date("2026-11-07T20:00:00Z");

  async function addNudge(deliverAfter: string, dedupeKey: string) {
    const [row] = await t.query<{ id: string }>(
      `select public.notification_outbox_add($1::uuid, 'weekly_nudge', $2::text::jsonb, $3::timestamptz, $4) as id`,
      [
        HOME,
        JSON.stringify({ type: "weekly_nudge", weekStart: "2026-11-09" }),
        deliverAfter,
        dedupeKey,
      ],
    );
    return row?.id as string;
  }

  async function rowOf(id: string) {
    const [row] = await t.query<{
      sent_at: Date | null;
      attempts: number;
      deliver_after: Date;
    }>("select sent_at, attempts, deliver_after from public.notification_outbox where id = $1", [
      id,
    ]);
    return row as NonNullable<typeof row>;
  }

  /** A sender whose calls wait on a gate the test opens. */
  function gatedSender() {
    const calls: string[][] = [];
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const send: Send = async (tokens) => {
      calls.push([...tokens]);
      await gate;
      return { sent: tokens.length, invalid: [], errors: [] };
    };
    return { calls, send, open };
  }

  it("waits for the send in flight, marks it sent, and hands the rest of the batch back unsent", async () => {
    const first = await addNudge("2026-11-07T19:00:00Z", "stop-1");
    const second = await addNudge("2026-11-07T19:01:00Z", "stop-2");
    const sender = gatedSender();
    const { drain } = setup(sender.send, noon);

    const pass = drain.tick();
    await vi.waitFor(() => expect(sender.calls).toHaveLength(1));
    let stopped = false;
    const stopping = drain.stop(5_000).then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The push is on its way to Expo: stop does not return, and the worker has not closed its connection.
    expect(stopped).toBe(false);

    sender.open();
    await stopping;
    await pass;
    expect(stopped).toBe(true);

    const sent = await rowOf(first);
    expect(sent.sent_at).not.toBeNull();
    // The second row was claimed but never sent: it is back, not waiting out a 5 minute lease.
    const held = await rowOf(second);
    expect(held.sent_at).toBeNull();
    expect(held.attempts).toBe(0);
    expect(new Date(held.deliver_after).getTime()).toBeLessThanOrEqual(noon.getTime());
    expect(sender.calls).toHaveLength(1);

    // The next worker sends it once.
    const next = setup(makeSender().send, noon);
    expect(await next.drain.drainOnce()).toMatchObject({ claimed: 1, sent: 1 });
    expect((await rowOf(second)).sent_at).not.toBeNull();
  });

  it("gives up waiting after the timeout, so a hung Expo call cannot hold the worker", async () => {
    await addNudge("2026-11-07T19:00:00Z", "hang-1");
    const send: Send = () => new Promise(() => {});
    const { drain } = setup(send, noon);
    void drain.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const started = Date.now();
    await drain.stop(50);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("starts no pass after stop", async () => {
    await addNudge("2026-11-07T19:00:00Z", "after-stop");
    const sender = makeSender();
    const { drain } = setup(sender.send, noon);
    await drain.stop();
    await drain.tick();
    drain.start();
    expect(sender.calls).toHaveLength(0);
    const [{ n } = { n: -1 }] = await t.query<{ n: number }>(
      "select count(*)::int as n from public.notification_outbox where sent_at is null",
    );
    expect(n).toBe(1);
  });

  it("returns at once when no pass is running", async () => {
    const { drain } = setup(makeSender().send, noon);
    drain.start();
    const started = Date.now();
    await drain.stop();
    expect(Date.now() - started).toBeLessThan(500);
  });
});
