// The calibration deck's recipe_feedback writes against WS04's real migration (WS06 follow-up to the
// merge). The rows come from the app's own `feedbackRows`, and each insert names exactly the columns
// the app sends, run as the `authenticated` role with a signed-in user's id. So a change to the grants,
// the policy, or the rows fails here rather than in a person's onboarding.
//
// PGlite stands in for Postgres (see testing/db.ts). Row Level Security, column privileges, and
// roles behave the same; auth.uid() is the stub that reads request.jwt.claim.sub.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { feedbackRows } from "../../../apps/mobile/src/features/onboarding/calibration.ts";
import { FIXTURE_HOUSEHOLD, FIXTURE_USER, OTHER_HOUSEHOLD, OTHER_USER } from "./testing/corpus.ts";
import { createTestDb, insertHousehold, insertRecipe, type TestDb } from "./testing/db.ts";

let t: TestDb;
const ids = {
  own: "",
  catalog: "",
  catalogDeleted: "",
  ownDeleted: "",
  other: "",
};

beforeAll(async () => {
  t = await createTestDb();
  await insertHousehold(t, { userId: FIXTURE_USER, householdId: FIXTURE_HOUSEHOLD });
  await insertHousehold(t, { userId: OTHER_USER, householdId: OTHER_HOUSEHOLD });
  const none = new Map<string, string>();
  const recipe = (title: string, householdId: string | null, deletedAt: string | null = null) =>
    insertRecipe(t, { title, householdId, deletedAt, lines: [] }, none);
  ids.own = await recipe("Own recipe", FIXTURE_HOUSEHOLD);
  ids.catalog = await recipe("Catalog recipe", null);
  ids.catalogDeleted = await recipe("Retired catalog recipe", null, "2026-10-01T00:00:00Z");
  ids.ownDeleted = await recipe("Deleted own recipe", FIXTURE_HOUSEHOLD, "2026-10-01T00:00:00Z");
  ids.other = await recipe("Other household recipe", OTHER_HOUSEHOLD);
});

afterAll(async () => {
  await t.close();
});

/** Runs `fn` as a signed-in member: the authenticated role, with auth.uid() set to the user. */
async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  await t.exec(
    `select set_config('request.jwt.claim.sub', '${userId}', false); set role authenticated;`,
  );
  try {
    return await fn();
  } finally {
    await t.exec("reset role; select set_config('request.jwt.claim.sub', '', false);");
  }
}

/** The insert a PostgREST client makes for these columns. */
function insertRow(row: Record<string, unknown>) {
  const columns = Object.keys(row);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  return t.query(
    `insert into public.recipe_feedback (${columns.join(", ")}) values (${placeholders})`,
    columns.map((column) => row[column]),
  );
}

async function expectRefused(row: Record<string, unknown>, message: RegExp) {
  await asUser(FIXTURE_USER, async () => {
    await expect(insertRow(row)).rejects.toThrow(message);
  });
}

describe("calibration swipes against WS04's recipe_feedback grants and policy", () => {
  it("lets a member insert a like and a dislike for their own recipe and for a catalog recipe", async () => {
    const rows = feedbackRows(FIXTURE_HOUSEHOLD, [
      { recipeId: ids.own, signal: "like" },
      { recipeId: ids.catalog, signal: "dislike" },
    ]);
    expect(rows).toHaveLength(2);
    await asUser(FIXTURE_USER, async () => {
      for (const row of rows) await insertRow(row);
    });
    const stored = await t.query<{ recipe_id: string; signal: string; user_id: string }>(
      "select recipe_id, signal::text as signal, user_id from public.recipe_feedback order by signal",
    );
    expect(stored).toEqual([
      { recipe_id: ids.catalog, signal: "dislike", user_id: FIXTURE_USER },
      { recipe_id: ids.own, signal: "like", user_id: FIXTURE_USER },
    ]);
  });

  it("refuses a row that names user_id, which is why the app leaves it out", async () => {
    await expectRefused(
      {
        household_id: FIXTURE_HOUSEHOLD,
        user_id: FIXTURE_USER,
        recipe_id: ids.own,
        signal: "like",
      },
      /permission denied for table recipe_feedback/,
    );
  });

  it("refuses the signals that only WS04's trigger writes", async () => {
    for (const signal of ["skipped", "saved", "cooked"]) {
      await expectRefused(
        { household_id: FIXTURE_HOUSEHOLD, recipe_id: ids.own, signal },
        /row-level security/,
      );
    }
  });

  it("refuses a deleted recipe, a retired catalog recipe, and another household's recipe", async () => {
    for (const recipeId of [ids.ownDeleted, ids.catalogDeleted, ids.other]) {
      await expectRefused(
        { household_id: FIXTURE_HOUSEHOLD, recipe_id: recipeId, signal: "like" },
        /row-level security/,
      );
    }
  });

  it("refuses another household as the target", async () => {
    await expectRefused(
      { household_id: OTHER_HOUSEHOLD, recipe_id: ids.catalog, signal: "like" },
      /row-level security/,
    );
  });

  it("lets the member read their own answers back, which is how a retry skips them", async () => {
    const rows = await asUser(FIXTURE_USER, () =>
      t.query<{ recipe_id: string; signal: string }>(
        `select recipe_id, signal::text as signal from public.recipe_feedback
          where household_id = $1 and user_id = $2 and recipe_id = any($3::uuid[])`,
        [FIXTURE_HOUSEHOLD, FIXTURE_USER, [ids.own, ids.catalog]],
      ),
    );
    expect(rows.map((r) => r.signal).sort()).toEqual(["dislike", "like"]);
  });
});
