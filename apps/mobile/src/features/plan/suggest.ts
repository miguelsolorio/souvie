// "Swap with a suggestion" (WS04 calling WS06). The button is hidden until the `suggest` Edge
// Function is deployed and EXPO_PUBLIC_SUGGEST_ENABLED is set to 1 (see .env.example). With the
// flag off the sheet offers the manual recipe picker only, and nothing here runs.
//
// The call is the one contract change this workstream asks of WS06 (see the completion report):
// `mode: "swap"` returns exactly one entry for one slot and writes nothing, so the planner applies
// the result through its own upsert, with the same optimistic update, rollback and RLS as a manual
// swap. WS06 already returns `{ planId, entries: [{ date, slot, recipeId, servings, why }] }`.
import { MealSlot } from "@mp/core";
import type { MpClient } from "@mp/db";

/** True when the suggest function is deployed. Read literally so Expo inlines the value. */
export function isSuggestEnabled(
  raw: string | undefined = process.env.EXPO_PUBLIC_SUGGEST_ENABLED,
) {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WHY_MAX = 280;

export interface SuggestedEntry {
  date: string;
  slot: MealSlot;
  recipeId: string;
  servings?: number;
  why?: string;
}

/**
 * Reads the first entry of a suggest response, or null when the answer is not one the planner can
 * use. The recipe id must be a UUID: the model chooses among candidates by index and the function
 * returns ids, but a malformed id must never reach the database.
 */
export function parseSwapSuggestion(data: unknown): SuggestedEntry | null {
  const entries = (data as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) return null;
  const first = entries[0] as Record<string, unknown> | undefined;
  if (!first || typeof first.recipeId !== "string" || !UUID.test(first.recipeId)) return null;
  const slot = MealSlot.safeParse(first.slot);
  if (!slot.success || typeof first.date !== "string") return null;
  const entry: SuggestedEntry = { date: first.date, slot: slot.data, recipeId: first.recipeId };
  if (typeof first.servings === "number" && first.servings > 0) entry.servings = first.servings;
  if (typeof first.why === "string" && first.why.trim())
    entry.why = first.why.trim().slice(0, WHY_MAX);
  return entry;
}

export interface SwapRequest {
  householdId: string;
  /** Monday of the week the slot is in. */
  weekStart: string;
  date: string;
  slot: MealSlot;
  /** Recipes the suggestion must not repeat: the one being replaced and the rest of the week. */
  excludeRecipeIds: string[];
}

export interface SwapResult {
  recipeId: string;
  servings: number | null;
  why: string | null;
}

export class SuggestUnavailableError extends Error {
  constructor(message = "Suggestions are not available yet.") {
    super(message);
    this.name = "SuggestUnavailableError";
  }
}

/** Asks `suggest` for one recipe for one slot. Throws SuggestUnavailableError if it is not deployed. */
export async function requestSwapSuggestion(
  client: MpClient,
  request: SwapRequest,
): Promise<SwapResult> {
  const { data, error } = await client.functions.invoke("suggest", {
    body: { ...request, mode: "swap" },
  });
  if (error) {
    const status = (error as { context?: { status?: number } }).context?.status;
    if (status === 404) throw new SuggestUnavailableError();
    throw new Error(error.message);
  }
  const first = parseSwapSuggestion(data);
  if (!first) throw new Error("The suggestion came back in a shape the app does not recognize.");
  return { recipeId: first.recipeId, servings: first.servings ?? null, why: first.why ?? null };
}
