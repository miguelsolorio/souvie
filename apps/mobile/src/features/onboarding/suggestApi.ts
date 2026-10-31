// Calls to the `suggest` Edge Function (WS06). The shapes are in @mp/core (preferences.ts) and
// supabase/functions/suggest/README.md. Failures come back as SuggestError with a code the screens
// turn into plain words.
import {
  type SUGGEST_ERROR_CODES,
  SUGGEST_ERROR_MESSAGES,
  SuggestBackfillResponse,
  SuggestCalibrationResponse,
  SuggestFailure,
  SuggestPlanResponse,
  type SuggestRequest,
} from "@mp/core";
import type { MpClient } from "@mp/db";
import { FunctionsHttpError } from "@supabase/supabase-js";

export const SUGGEST_FUNCTION = "suggest";

export type SuggestClientErrorCode =
  | (typeof SUGGEST_ERROR_CODES)[number]
  | "network"
  | "unreadable";

export class SuggestError extends Error {
  readonly code: SuggestClientErrorCode;
  constructor(code: SuggestClientErrorCode, message?: string) {
    super(message ?? code);
    this.name = "SuggestError";
    this.code = code;
  }
}

const CLIENT_MESSAGES = {
  network: "We could not reach the server. Check your connection and try again.",
  unreadable: "The server sent an answer we could not read. Try again.",
} as const;

/** Text for the person using the app. */
export function suggestErrorMessage(error: unknown): string {
  if (error instanceof SuggestError) {
    if (error.code === "network" || error.code === "unreadable") return CLIENT_MESSAGES[error.code];
    return SUGGEST_ERROR_MESSAGES[error.code];
  }
  return SUGGEST_ERROR_MESSAGES.internal_error;
}

async function call(client: MpClient, body: SuggestRequest): Promise<unknown> {
  const { data, error } = await client.functions.invoke(SUGGEST_FUNCTION, { body });
  let payload: unknown = data;
  if (error) {
    if (!(error instanceof FunctionsHttpError)) throw new SuggestError("network");
    payload = await error.context.json().catch(() => null);
  }
  if (!payload || typeof payload !== "object") throw new SuggestError("unreadable");
  const failure = SuggestFailure.safeParse(payload);
  if (failure.success) throw new SuggestError(failure.data.error, failure.data.message);
  return payload;
}

function parse<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  payload: unknown,
): T {
  const result = schema.safeParse(payload);
  if (!result.success) throw new SuggestError("unreadable");
  return result.data;
}

export type PlanRequest = Omit<SuggestRequest, "mode"> & { mode: "draft" | "replace" };

/** Draft or replace a week's dinners. */
export async function suggestPlan(client: MpClient, request: PlanRequest) {
  return parse(SuggestPlanResponse, await call(client, request));
}

/** The twelve cards for the swipe screen. Writes nothing. */
export async function suggestCalibration(
  client: MpClient,
  request: Pick<SuggestRequest, "householdId" | "weekStart">,
) {
  return parse(SuggestCalibrationResponse, await call(client, { ...request, mode: "calibration" }));
}

/** Embeds the household's recipes that have no embedding yet. */
export async function suggestBackfill(
  client: MpClient,
  request: Pick<SuggestRequest, "householdId" | "weekStart">,
) {
  return parse(SuggestBackfillResponse, await call(client, { ...request, mode: "backfill" }));
}
