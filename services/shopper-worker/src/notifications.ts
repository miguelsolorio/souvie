// Who gets which push, and when (WS11).
//
//   Notifier      sends a payload to the household members who want it, or, when quiet hours are on,
//                 parks it in notification_outbox until they end.
//   OutboxDrain   on a timer, sends the outbox rows that are due. The outbox carries the pushes
//                 SQL decides on (the weekly nudge, a failed run, a skipped schedule, a slow import,
//                 a pickup reminder) and any run push that quiet hours held back.
//   NotificationStore  every statement, under the service role like the rest of the worker.
//
// cart_ready and needs_review are still pushed by the run itself, straight through Notifier, so
// there is no second path to the same phone. The outbox never receives them except as a deferral.
//
// A person's preferences are theirs: notification_preferences has a row per type only when they
// changed it, and a missing row means on. Quiet hours and the zone are the household's. There is
// no Edge Function and no pg_net: SQL writes the outbox and this file sends.
import {
  DEFAULT_TIME_ZONE,
  isValidTimeZone,
  NotificationPayload,
  type NotificationType,
  notificationTypeOf,
  QuietHours,
  quietHoursEnd,
} from "@mp/core";
import { type SendResult, sendPush } from "./push.ts";
import { errorMessage, type Logger } from "./queue.ts";
import type { SqlRunner } from "./sql.ts";
import { SERVICE_ROLE_STATEMENT } from "./store.ts";

/** Sends a row this many times before it stays in the outbox unsent until it is pruned. */
export const OUTBOX_MAX_ATTEMPTS = 5;
/** While a row is being sent it is invisible for this long; a worker that dies retries after it. */
export const OUTBOX_LEASE_SECONDS = 300;
/** Rows one drain pass takes. */
export const OUTBOX_BATCH = 50;

export interface HouseholdSettings {
  timeZone: string;
  quietHours: QuietHours | null;
}

export interface DueNotification {
  id: string;
  householdId: string;
  type: NotificationType;
  payload: NotificationPayload;
  attempts: number;
  settings: HouseholdSettings;
}

interface SettingsRow {
  timezone: string | null;
  quiet_hours: unknown;
}

function settingsOf(row: SettingsRow | undefined): HouseholdSettings {
  const timeZone =
    row?.timezone && isValidTimeZone(row.timezone) ? row.timezone : DEFAULT_TIME_ZONE;
  const quiet = QuietHours.safeParse(row?.quiet_hours);
  return { timeZone, quietHours: quiet.success ? quiet.data : null };
}

/** What a stored notification refers to must still be true when it is sent. */
const FRESH_STATUS: Readonly<Record<string, readonly string[]>> = {
  cart_ready: ["cart_ready"],
  needs_review: ["needs_review"],
  run_failed: ["failed"],
};

export class NotificationStore {
  constructor(private readonly sql: SqlRunner) {}

  #inServiceRole<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T> {
    return this.sql.transaction(async (tx) => {
      await tx.query(SERVICE_ROLE_STATEMENT, []);
      return fn(tx);
    });
  }

  async householdSettings(householdId: string): Promise<HouseholdSettings> {
    const rows = await this.#inServiceRole((tx) =>
      tx.query<SettingsRow>(
        `select h.timezone, h.quiet_hours
           from public.households h
          where h.id = $1::uuid`,
        [householdId],
      ),
    );
    return settingsOf(rows[0]);
  }

  /**
   * The device tokens of the members who have not turned `type` off. A member with no row for the
   * type wants it. The household is named, so nobody outside it is reached.
   */
  async recipientTokens(householdId: string, type: NotificationType): Promise<string[]> {
    const rows = await this.#inServiceRole((tx) =>
      tx.query<{ token: string }>(
        `select distinct pt.token
           from public.household_members m
           join public.push_tokens pt on pt.user_id = m.user_id
          where m.household_id = $1::uuid
            and not exists (
              select 1 from public.notification_preferences np
               where np.user_id = m.user_id
                 and np.type = $2::public.notification_type
                 and np.enabled = false
            )`,
        [householdId, type],
      ),
    );
    return rows.map((row) => row.token);
  }

  /** Tokens Expo says no longer reach a device, among the household's members. */
  async removeTokens(householdId: string, tokens: readonly string[]): Promise<void> {
    if (tokens.length === 0) return;
    await this.#inServiceRole((tx) =>
      tx.query(
        `delete from public.push_tokens pt
          where pt.token = any($2::text[])
            and pt.user_id in (
              select m.user_id from public.household_members m where m.household_id = $1::uuid
            )`,
        [householdId, tokens],
      ),
    );
  }

  /** Parks a payload until `deliverAfter` (quiet hours end). */
  async hold(
    householdId: string,
    payload: NotificationPayload,
    deliverAfter: Date,
  ): Promise<string | null> {
    const rows = await this.#inServiceRole((tx) =>
      tx.query<{ id: string | null }>(
        `select public.notification_outbox_add(
                  $1::uuid, $2::public.notification_type, $3::text::jsonb, $4::timestamptz, null
                ) as id`,
        [
          householdId,
          notificationTypeOf(payload),
          JSON.stringify(payload),
          deliverAfter.toISOString(),
        ],
      ),
    );
    return rows[0]?.id ?? null;
  }

  async runStatus(runId: string): Promise<string | null> {
    const rows = await this.#inServiceRole((tx) =>
      tx.query<{ status: string }>(
        `select r.status::text as status from public.shopping_runs r where r.id = $1::uuid`,
        [runId],
      ),
    );
    return rows[0]?.status ?? null;
  }

  /**
   * Takes the rows that are due. A row inside its household's quiet hours is moved to their end
   * and not taken; every other row is leased for OUTBOX_LEASE_SECONDS (a worker that dies retries
   * after it) and counted as an attempt. One transaction, so two workers never take the same row.
   */
  async claimDue(
    now: Date,
    limit = OUTBOX_BATCH,
  ): Promise<{ claimed: DueNotification[]; deferred: number }> {
    return this.#inServiceRole(async (tx) => {
      const rows = await tx.query<{
        id: string;
        household_id: string;
        type: NotificationType;
        payload: unknown;
        attempts: number;
        timezone: string | null;
        quiet_hours: unknown;
      }>(
        `select o.id, o.household_id, o.type::text as type, o.payload, o.attempts,
                h.timezone, h.quiet_hours
           from public.notification_outbox o
           join public.households h on h.id = o.household_id
          where o.sent_at is null
            and o.deliver_after <= $1::timestamptz
            and o.attempts < $2::integer
          order by o.deliver_after, o.created_at
          limit $3::integer
            for update of o skip locked`,
        [now.toISOString(), OUTBOX_MAX_ATTEMPTS, limit],
      );
      const claimed: DueNotification[] = [];
      let deferred = 0;
      for (const row of rows) {
        const settings = settingsOf(row);
        const payload = NotificationPayload.safeParse(row.payload);
        if (!payload.success) {
          await tx.query(
            `update public.notification_outbox o
                set attempts = $2::integer, last_error = 'the payload is not a notification'
              where o.id = $1::uuid`,
            [row.id, OUTBOX_MAX_ATTEMPTS],
          );
          continue;
        }
        const end = quietHoursEnd(now, settings.quietHours, settings.timeZone);
        if (end) {
          await tx.query(
            `update public.notification_outbox o set deliver_after = $2::timestamptz
              where o.id = $1::uuid`,
            [row.id, end.toISOString()],
          );
          deferred += 1;
          continue;
        }
        await tx.query(
          `update public.notification_outbox o
              set attempts = o.attempts + 1,
                  deliver_after = $2::timestamptz
            where o.id = $1::uuid`,
          [row.id, new Date(now.getTime() + OUTBOX_LEASE_SECONDS * 1000).toISOString()],
        );
        claimed.push({
          id: row.id,
          householdId: row.household_id,
          type: row.type,
          payload: payload.data,
          attempts: row.attempts + 1,
          settings,
        });
      }
      return { claimed, deferred };
    });
  }

  async markSent(id: string, note: string | null = null): Promise<void> {
    await this.#inServiceRole((tx) =>
      tx.query(
        `update public.notification_outbox o
            set sent_at = now(), last_error = $2
          where o.id = $1::uuid`,
        [id, note],
      ),
    );
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.#inServiceRole((tx) =>
      tx.query(`update public.notification_outbox o set last_error = $2 where o.id = $1::uuid`, [
        id,
        error.slice(0, 500),
      ]),
    );
  }
}

export type Send = (
  tokens: readonly string[],
  payload: NotificationPayload,
  options: { timeZone: string },
) => Promise<SendResult>;

export interface NotifierOptions {
  store: Pick<NotificationStore, "householdSettings" | "recipientTokens" | "removeTokens" | "hold">;
  send: Send;
  log: Logger;
  now?: () => Date;
}

export interface NotifyResult {
  /** Devices Expo accepted. */
  sent: number;
  /** Devices tried. */
  attempted: number;
  /** Set when quiet hours held the push back; the push goes out then. */
  deferredUntil?: Date;
  errors: string[];
}

export class Notifier {
  readonly #o: NotifierOptions;

  constructor(options: NotifierOptions) {
    this.#o = options;
  }

  /**
   * A push the run itself makes (cart_ready, needs_review). Inside the household's quiet hours it
   * is held in the outbox and goes out when they end; a held needs_review is marked urgent, since
   * the run waits on the person.
   */
  async notifyRun(householdId: string, payload: NotificationPayload): Promise<NotifyResult> {
    const settings = await this.#o.store.householdSettings(householdId);
    const now = (this.#o.now ?? (() => new Date()))();
    const end = quietHoursEnd(now, settings.quietHours, settings.timeZone);
    if (end) {
      const held = payload.type === "needs_review" ? { ...payload, urgent: true } : payload;
      await this.#o.store.hold(householdId, held, end);
      this.#o.log.info("push held for quiet hours", {
        type: payload.type,
        until: end.toISOString(),
      });
      return { sent: 0, attempted: 0, deferredUntil: end, errors: [] };
    }
    return this.deliver(householdId, payload, settings);
  }

  /** Sends now to every member who has not turned the type off. Removes dead tokens. */
  async deliver(
    householdId: string,
    payload: NotificationPayload,
    settings?: HouseholdSettings,
  ): Promise<NotifyResult> {
    const type = notificationTypeOf(payload);
    const home = settings ?? (await this.#o.store.householdSettings(householdId));
    const tokens = await this.#o.store.recipientTokens(householdId, type);
    if (tokens.length === 0) return { sent: 0, attempted: 0, errors: [] };
    const result = await this.#o.send(tokens, payload, { timeZone: home.timeZone });
    await this.#o.store.removeTokens(householdId, result.invalid);
    this.#o.log.info("push sent", {
      type: payload.type,
      devices: result.sent,
      errors: result.errors.length,
    });
    return { sent: result.sent, attempted: tokens.length, errors: result.errors };
  }
}

/** A Notifier that sends through Expo. */
export function createExpoSend(accessToken: string | undefined, fetchImpl?: typeof fetch): Send {
  return (tokens, payload, options) =>
    sendPush(tokens, payload, {
      accessToken,
      timeZone: options.timeZone,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
}

export interface DrainResult {
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
  deferred: number;
}

export interface OutboxDrainOptions {
  store: Pick<NotificationStore, "claimDue" | "markSent" | "markFailed" | "runStatus">;
  notifier: Pick<Notifier, "deliver">;
  log: Logger;
  intervalSeconds: number;
  now?: () => Date;
}

/** Sends what is due in notification_outbox, every `intervalSeconds`. */
export class OutboxDrain {
  readonly #o: OutboxDrainOptions;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;

  constructor(options: OutboxDrainOptions) {
    this.#o = options;
  }

  /** One pass. Never throws: a broken row must not stop the rest, or the worker. */
  async drainOnce(): Promise<DrainResult> {
    const out: DrainResult = { claimed: 0, sent: 0, failed: 0, skipped: 0, deferred: 0 };
    const now = (this.#o.now ?? (() => new Date()))();
    let batch: Awaited<ReturnType<NotificationStore["claimDue"]>>;
    try {
      batch = await this.#o.store.claimDue(now);
    } catch (error) {
      this.#o.log.error("outbox claim failed", { error: errorMessage(error) });
      return out;
    }
    out.deferred = batch.deferred;
    out.claimed = batch.claimed.length;
    for (const row of batch.claimed) {
      try {
        if (!(await this.#isCurrent(row.payload))) {
          await this.#o.store.markSent(row.id, "stale: the run moved on");
          out.skipped += 1;
          continue;
        }
        const result = await this.#o.notifier.deliver(row.householdId, row.payload, row.settings);
        if (result.attempted > 0 && result.sent === 0 && result.errors.length > 0) {
          throw new Error(result.errors[0]);
        }
        await this.#o.store.markSent(row.id);
        out.sent += 1;
      } catch (error) {
        out.failed += 1;
        this.#o.log.warn("outbox push failed", {
          id: row.id,
          type: row.type,
          attempt: row.attempts,
          error: errorMessage(error),
        });
        try {
          await this.#o.store.markFailed(row.id, errorMessage(error));
        } catch (markError) {
          this.#o.log.error("outbox row could not be marked", { error: errorMessage(markError) });
        }
      }
    }
    return out;
  }

  async #isCurrent(payload: NotificationPayload): Promise<boolean> {
    const fresh = FRESH_STATUS[payload.type];
    if (!fresh || !("runId" in payload) || payload.runId === null) return true;
    const status = await this.#o.store.runStatus(payload.runId);
    return status !== null && fresh.includes(status);
  }

  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const result = await this.drainOnce();
      if (result.claimed > 0 || result.deferred > 0)
        this.#o.log.info("outbox drained", { ...result });
    } finally {
      this.#running = false;
    }
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.#o.intervalSeconds * 1000);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
