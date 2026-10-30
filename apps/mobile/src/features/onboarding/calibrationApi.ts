// Writing the swipes (WS06). recipe_feedback is WS04's table, so it is not in the generated
// database types yet; this talks to it through a small loose interface instead of editing them.
// Once WS04 merges and the types are regenerated, the cast can go.
import type { MpClient } from "@mp/db";
import { type Answer, type FeedbackRow, feedbackRows } from "./calibration";

interface LooseResult<T> {
  data: T | null;
  error: { message: string } | null;
}

interface LooseQuery<T> extends PromiseLike<LooseResult<T>> {
  eq(column: string, value: string): LooseQuery<T>;
  in(column: string, values: string[]): LooseQuery<T>;
}

export interface LooseFeedbackTable {
  select(columns: string): LooseQuery<{ recipe_id: string; signal: string }[]>;
  insert(rows: FeedbackRow[]): PromiseLike<{ error: { message: string } | null }>;
}

export interface LooseClient {
  from(table: "recipe_feedback"): LooseFeedbackTable;
}

/**
 * Saves a person's like and skip answers as recipe_feedback rows (`like`, `dislike`) in their
 * household. A recipe they already answered is left alone, so retrying a failed finish, or going
 * through calibration twice, never writes twice. Returns how many rows were written.
 */
export async function saveCalibrationFeedback(
  client: MpClient | LooseClient,
  args: { householdId: string; userId: string; answers: readonly Answer[] },
): Promise<number> {
  if (args.answers.length === 0) return 0;
  const table = (client as unknown as LooseClient).from("recipe_feedback");
  const ids = args.answers.map((a) => a.recipeId);

  const existing = await table
    .select("recipe_id, signal")
    .eq("household_id", args.householdId)
    .eq("user_id", args.userId)
    .in("recipe_id", ids);
  if (existing.error) throw new Error(existing.error.message);
  const answered = new Set(
    (existing.data ?? [])
      .filter((row) => row.signal === "like" || row.signal === "dislike")
      .map((row) => row.recipe_id),
  );

  const rows = feedbackRows(args.householdId, args.userId, args.answers, answered);
  if (rows.length === 0) return 0;
  const { error } = await table.insert(rows);
  if (error) throw new Error(error.message);
  return rows.length;
}
