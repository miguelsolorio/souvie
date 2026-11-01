// Typed calls, query keys and errors for scheduled runs and notifications (WS11). The hooks in
// ./hooks/useSchedules.ts and ./hooks/useNotificationSettings.ts are thin wrappers over this file,
// so the logic is testable without React.
//
// What the database enforces and this file only reports: owners write schedules (RLS), members
// read them; next_run_at is computed by a trigger, never sent; a household has at most ten; the
// connection must be the household's own; quiet hours and the zone are owner-editable columns of
// households; a preference is written through set_notification_preference.
import {
  cadenceToCron,
  DEFAULT_SCHEDULE_CADENCE,
  DEFAULT_TIME_ZONE,
  NotificationType,
  QuietHours,
  ScheduledRun,
  type ScheduleInput,
} from "@mp/core";
import type { MpClient } from "./client";
import { newId } from "./ids";

// ---------------------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------------------

export const schedulesKey = (householdId: string | null | undefined) =>
  ["schedules", householdId] as const;
export const scheduleKey = (
  householdId: string | null | undefined,
  scheduleId: string | null | undefined,
) => ["schedules", householdId, scheduleId] as const;
export const scheduleConnectionsKey = (householdId: string | null | undefined) =>
  ["schedule-connections", householdId] as const;
export const notificationSettingsKey = (householdId: string | null | undefined) =>
  ["notification-settings", householdId] as const;
export const notificationPreferencesKey = (userId: string | null | undefined) =>
  ["notification-preferences", userId] as const;

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

export type ScheduleApiErrorCode =
  | "not_owner"
  | "connection_not_found"
  | "no_connection"
  | "too_many_schedules"
  | "invalid_schedule"
  | "invalid_quiet_hours"
  | "invalid_time_zone"
  | "not_authenticated"
  | "network"
  | "internal_error";

const MESSAGES: Record<ScheduleApiErrorCode, string> = {
  not_owner: "Only the household owner can change shopping schedules and quiet hours.",
  connection_not_found: "That store connection is not in your household.",
  no_connection: "Connect a store first. A schedule needs one.",
  too_many_schedules: "A household can have ten schedules at most.",
  invalid_schedule: "That schedule is not valid. Check the day, the time and the rules.",
  invalid_quiet_hours: "Quiet hours need two different times.",
  invalid_time_zone: "That time zone is not valid.",
  not_authenticated: "Sign in again to continue.",
  network: "We could not reach the server. Check your connection.",
  internal_error: "Something went wrong. Try again.",
};

export class ScheduleApiError extends Error {
  readonly code: ScheduleApiErrorCode;
  constructor(code: ScheduleApiErrorCode) {
    super(MESSAGES[code]);
    this.name = "ScheduleApiError";
    this.code = code;
  }
}

interface PostgrestLike {
  message?: string;
  code?: string;
}

/** Maps what PostgREST says to a ScheduleApiError. The raw message is not shown to people. */
export function toScheduleApiError(error: unknown): ScheduleApiError {
  if (error instanceof ScheduleApiError) return error;
  const { message = "", code = "" } = (error ?? {}) as PostgrestLike;
  if (/failed to fetch|network|timeout/i.test(message) && code === "") {
    return new ScheduleApiError("network");
  }
  for (const known of [
    "connection_not_found",
    "too_many_schedules",
    "invalid_time_zone",
    "not_authenticated",
  ] as const) {
    if (message.includes(known)) return new ScheduleApiError(known);
  }
  if (message.includes("invalid_cron")) return new ScheduleApiError("invalid_schedule");
  // 42501: RLS or a column privilege. For schedules and quiet hours that means "not the owner".
  if (code === "42501" || /row-level security|permission denied/i.test(message)) {
    return new ScheduleApiError("not_owner");
  }
  if (code === "23514") {
    return new ScheduleApiError(
      message.includes("quiet_hours") ? "invalid_quiet_hours" : "invalid_schedule",
    );
  }
  return new ScheduleApiError("internal_error");
}

// ---------------------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------------------

export const SCHEDULE_COLUMNS =
  "id, household_id, cron, tz, connection_id, policy, next_run_at, last_enqueued_for, enabled, created_at, updated_at";

function parseSchedule(row: unknown): ScheduledRun {
  const parsed = ScheduledRun.safeParse(row);
  if (!parsed.success) throw new ScheduleApiError("internal_error");
  return parsed.data;
}

/** The household's schedules, soonest first. */
export async function fetchSchedules(
  client: MpClient,
  householdId: string,
): Promise<ScheduledRun[]> {
  const { data, error } = await client
    .from("scheduled_runs")
    .select(SCHEDULE_COLUMNS)
    .eq("household_id", householdId)
    .order("next_run_at", { ascending: true });
  if (error) throw toScheduleApiError(error);
  return (data ?? []).map(parseSchedule);
}

export async function fetchSchedule(
  client: MpClient,
  householdId: string,
  scheduleId: string,
): Promise<ScheduledRun | null> {
  const { data, error } = await client
    .from("scheduled_runs")
    .select(SCHEDULE_COLUMNS)
    .eq("household_id", householdId)
    .eq("id", scheduleId)
    .maybeSingle();
  if (error) throw toScheduleApiError(error);
  return data ? parseSchedule(data) : null;
}

/**
 * Creates a schedule. The id is the caller's, so a retry after a dropped connection finds the row
 * the first attempt made (a duplicate id comes back as the existing schedule) instead of adding a
 * second one. `next_run_at` is not sent: a trigger computes it.
 */
export async function createSchedule(
  client: MpClient,
  householdId: string,
  input: ScheduleInput,
  id: string = newId(),
): Promise<ScheduledRun> {
  const { data, error } = await client
    .from("scheduled_runs")
    .insert({
      id,
      household_id: householdId,
      cron: input.cron,
      tz: input.tz,
      connection_id: input.connection_id,
      policy: input.policy,
      enabled: input.enabled,
    })
    .select(SCHEDULE_COLUMNS)
    .single();
  if (error) {
    if (error.code === "23505") {
      const existing = await fetchSchedule(client, householdId, id);
      if (existing) return existing;
    }
    throw toScheduleApiError(error);
  }
  return parseSchedule(data);
}

/** Edits a schedule. Only the columns given are sent. */
export async function updateSchedule(
  client: MpClient,
  householdId: string,
  scheduleId: string,
  patch: Partial<ScheduleInput>,
): Promise<ScheduledRun> {
  const { data, error } = await client
    .from("scheduled_runs")
    .update(patch)
    .eq("household_id", householdId)
    .eq("id", scheduleId)
    .select(SCHEDULE_COLUMNS);
  if (error) throw toScheduleApiError(error);
  // RLS hides a schedule a member may not change as "no rows", not as an error.
  const row = data?.[0];
  if (!row) throw new ScheduleApiError("not_owner");
  return parseSchedule(row);
}

export async function deleteSchedule(
  client: MpClient,
  householdId: string,
  scheduleId: string,
): Promise<void> {
  const { data, error } = await client
    .from("scheduled_runs")
    .delete()
    .eq("household_id", householdId)
    .eq("id", scheduleId)
    .select("id");
  if (error) throw toScheduleApiError(error);
  if (!data || data.length === 0) throw new ScheduleApiError("not_owner");
}

/** A store connection a schedule can use. Tier 3 connections are listed but cannot run unattended. */
export interface ScheduleConnection {
  id: string;
  retailer: string;
  storeName: string | null;
  status: "active" | "needs_reauth" | "revoked";
  /** browser_session means the store runs on the phone (Tier 3), so it cannot be scheduled. */
  unattended: boolean;
}

export async function fetchScheduleConnections(
  client: MpClient,
  householdId: string,
): Promise<ScheduleConnection[]> {
  const { data, error } = await client
    .from("retailer_connections")
    .select("id, retailer, store_name, status, auth_type")
    .eq("household_id", householdId)
    .order("created_at", { ascending: true });
  if (error) throw toScheduleApiError(error);
  return (data ?? []).map((row) => ({
    id: row.id,
    retailer: row.retailer,
    storeName: row.store_name,
    status: row.status,
    unattended: row.auth_type !== "browser_session",
  }));
}

/**
 * The first suggested schedule (docs: onboarding offers "Saturday 9:00 for the week starting
 * Monday" to accept, edit or skip): Saturday 9:00 in `tz`, at the household's default store, or its
 * first active store the scheduler can run. WS06's onboarding calls this when the person accepts.
 * Calling it again returns the schedule it made.
 */
export async function createDefaultSchedule(
  client: MpClient,
  householdId: string,
  tz: string = DEFAULT_TIME_ZONE,
): Promise<ScheduledRun> {
  const cron = cadenceToCron(DEFAULT_SCHEDULE_CADENCE);
  const connections = (await fetchScheduleConnections(client, householdId)).filter(
    (c) => c.status === "active" && c.unattended,
  );
  const { data: household, error } = await client
    .from("households")
    .select("default_connection_id")
    .eq("id", householdId)
    .maybeSingle();
  if (error) throw toScheduleApiError(error);
  const preferred = connections.find((c) => c.id === household?.default_connection_id);
  const connection = preferred ?? connections[0];
  if (!connection) throw new ScheduleApiError("no_connection");
  const existing = (await fetchSchedules(client, householdId)).find(
    (s) => s.cron === cron && s.connection_id === connection.id,
  );
  if (existing) return existing;
  return createSchedule(client, householdId, {
    cron,
    tz,
    connection_id: connection.id,
    policy: { substitution: "same_brand" },
    enabled: true,
  });
}

// ---------------------------------------------------------------------------------------
// Quiet hours and the household's zone
// ---------------------------------------------------------------------------------------

export interface NotificationSettings {
  timezone: string | null;
  quietHours: QuietHours | null;
}

export async function fetchNotificationSettings(
  client: MpClient,
  householdId: string,
): Promise<NotificationSettings> {
  const { data, error } = await client
    .from("households")
    .select("timezone, quiet_hours")
    .eq("id", householdId)
    .maybeSingle();
  if (error) throw toScheduleApiError(error);
  const quiet = QuietHours.safeParse(data?.quiet_hours);
  return { timezone: data?.timezone ?? null, quietHours: quiet.success ? quiet.data : null };
}

/** Sets or clears quiet hours (owners only; the database says no to anyone else). */
export async function saveNotificationSettings(
  client: MpClient,
  householdId: string,
  settings: { quietHours: QuietHours | null; timezone?: string },
): Promise<void> {
  const quietHours = settings.quietHours === null ? null : QuietHours.parse(settings.quietHours);
  const { data, error } = await client
    .from("households")
    .update({
      quiet_hours: quietHours,
      ...(settings.timezone ? { timezone: settings.timezone } : {}),
    })
    .eq("id", householdId)
    .select("id");
  if (error) throw toScheduleApiError(error);
  if (!data || data.length === 0) throw new ScheduleApiError("not_owner");
}

// ---------------------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------------------

/** Every type with the person's choice. A type they never changed is on. */
export type NotificationPreferences = Record<NotificationType, boolean>;

export async function fetchNotificationPreferences(
  client: MpClient,
  userId: string,
): Promise<NotificationPreferences> {
  const { data, error } = await client
    .from("notification_preferences")
    .select("type, enabled")
    .eq("user_id", userId);
  if (error) throw toScheduleApiError(error);
  const out = Object.fromEntries(
    NotificationType.options.map((type) => [type, true]),
  ) as NotificationPreferences;
  for (const row of data ?? []) {
    const type = NotificationType.safeParse(row.type);
    if (type.success) out[type.data] = row.enabled;
  }
  return out;
}

export async function setNotificationPreference(
  client: MpClient,
  type: NotificationType,
  enabled: boolean,
): Promise<void> {
  const { error } = await client.rpc("set_notification_preference", {
    p_type: type,
    p_enabled: enabled,
  });
  if (error) throw toScheduleApiError(error);
}

// ---------------------------------------------------------------------------------------
// Device tokens
// ---------------------------------------------------------------------------------------

/**
 * Registers this device for the signed-in person. A device belongs to whoever signed in on it last.
 * Calling it on every launch refreshes the row's updated_at and never makes a second row.
 */
export async function registerPushToken(
  client: MpClient,
  token: string,
  platform: "ios" | "android" | "web",
): Promise<void> {
  const { error } = await client.rpc("register_push_token", {
    p_token: token,
    p_platform: platform,
  });
  if (error) throw toScheduleApiError(error);
}

/**
 * Forgets a device by its token, with or without a session. For a session that ended without the
 * app signing out (the account was signed out elsewhere), when the app can no longer delete its
 * own row.
 */
export async function forgetPushTokenBySecret(client: MpClient, token: string): Promise<void> {
  const { error } = await client.rpc("forget_push_token", { p_token: token });
  if (error) throw toScheduleApiError(error);
}
