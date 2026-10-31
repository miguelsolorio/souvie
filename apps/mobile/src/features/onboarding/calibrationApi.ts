// Writing the swipes (WS06). The rows go to WS04's recipe_feedback table, under WS04's grants and
// policy: a client inserts (id, household_id, recipe_id, signal, rating) only, user_id comes from
// the column default (the caller's auth.uid()), the signal must be `like` or `dislike`, and the
// recipe must be live and either the household's own or a catalog recipe.
import type { MpClient } from "@mp/db";
import { type Answer, feedbackRows } from "./calibration";

/**
 * Saves a person's like and dislike answers as recipe_feedback rows in their household. A recipe
 * they already answered is left alone, so retrying a failed finish, or going through calibration
 * twice, never writes twice. Returns how many rows were written.
 *
 * `userId` is only for the lookup of earlier answers. It is not written: the database fills the
 * column from the session, and a client that names it is refused.
 */
export async function saveCalibrationFeedback(
  client: MpClient,
  args: { householdId: string; userId: string; answers: readonly Answer[] },
): Promise<number> {
  if (args.answers.length === 0) return 0;
  const ids = args.answers.map((a) => a.recipeId);

  const existing = await client
    .from("recipe_feedback")
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

  const rows = feedbackRows(args.householdId, args.answers, answered);
  if (rows.length === 0) return 0;
  const { error } = await client.from("recipe_feedback").insert(rows);
  if (error) throw new Error(error.message);
  return rows.length;
}
