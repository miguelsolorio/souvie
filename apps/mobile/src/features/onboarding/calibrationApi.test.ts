import type { MpClient } from "@mp/db";
import { describe, expect, it, vi } from "vitest";
import { saveCalibrationFeedback } from "./calibrationApi";

function fakeClient(options: {
  existing?: { recipe_id: string; signal: string }[];
  selectError?: string;
  insertError?: string;
}) {
  const filters: [string, unknown][] = [];
  const insert = vi.fn(async (_rows: unknown[]) => ({
    error: options.insertError ? { message: options.insertError } : null,
  }));
  const result = options.selectError
    ? { data: null, error: { message: options.selectError } }
    : { data: options.existing ?? [], error: null };
  // A real promise that also carries the filter methods, the way a PostgREST builder does.
  const query: Promise<typeof result> & {
    eq(column: string, value: string): typeof query;
    in(column: string, values: string[]): typeof query;
  } = Object.assign(Promise.resolve(result), {
    eq(column: string, value: string) {
      filters.push([column, value]);
      return query;
    },
    in(column: string, values: string[]) {
      filters.push([column, values]);
      return query;
    },
  });
  const tables: string[] = [];
  const client = {
    from: (table: string) => {
      tables.push(table);
      return { select: () => query, insert };
    },
  } as unknown as MpClient;
  return { client, insert, filters, tables };
}

const answers = [
  { recipeId: "r1", signal: "like" as const },
  { recipeId: "r2", signal: "dislike" as const },
  { recipeId: "r3", signal: "like" as const },
];

describe("saveCalibrationFeedback", () => {
  it("inserts a row per answer, scoped to the household, without user_id", async () => {
    const { client, insert, filters, tables } = fakeClient({});
    const written = await saveCalibrationFeedback(client, {
      householdId: "h",
      userId: "u",
      answers,
    });
    expect(written).toBe(3);
    // WS04 grants a client insert on (id, household_id, recipe_id, signal, rating) and fills
    // user_id from auth.uid(), so the rows carry no user_id.
    expect(insert).toHaveBeenCalledWith([
      { household_id: "h", recipe_id: "r1", signal: "like" },
      { household_id: "h", recipe_id: "r2", signal: "dislike" },
      { household_id: "h", recipe_id: "r3", signal: "like" },
    ]);
    // The user id only narrows the lookup of earlier answers.
    expect(filters).toContainEqual(["household_id", "h"]);
    expect(filters).toContainEqual(["user_id", "u"]);
    expect(filters).toContainEqual(["recipe_id", ["r1", "r2", "r3"]]);
    expect(new Set(tables)).toEqual(new Set(["recipe_feedback"]));
  });

  it("does not write a recipe the person already answered", async () => {
    const { client, insert } = fakeClient({
      existing: [
        { recipe_id: "r1", signal: "like" },
        { recipe_id: "r2", signal: "cooked" },
      ],
    });
    const written = await saveCalibrationFeedback(client, {
      householdId: "h",
      userId: "u",
      answers,
    });
    // r1 was answered before. r2 only has a "cooked" signal, which is not a calibration answer.
    expect(written).toBe(2);
    const rows = insert.mock.calls[0]?.[0] as { recipe_id: string }[];
    expect(rows.map((r) => r.recipe_id)).toEqual(["r2", "r3"]);
  });

  it("counts a like or a dislike as an answer, and not the signals WS04's trigger writes", async () => {
    const { client, insert } = fakeClient({
      existing: [
        { recipe_id: "r1", signal: "dislike" },
        { recipe_id: "r2", signal: "skipped" },
        { recipe_id: "r3", signal: "saved" },
      ],
    });
    await saveCalibrationFeedback(client, { householdId: "h", userId: "u", answers });
    const rows = insert.mock.calls[0]?.[0] as { recipe_id: string }[];
    expect(rows.map((r) => r.recipe_id)).toEqual(["r2", "r3"]);
  });

  it("writes nothing when everything was answered or nothing was swiped", async () => {
    const all = fakeClient({
      existing: answers.map((a) => ({ recipe_id: a.recipeId, signal: a.signal })),
    });
    expect(
      await saveCalibrationFeedback(all.client, { householdId: "h", userId: "u", answers }),
    ).toBe(0);
    expect(all.insert).not.toHaveBeenCalled();
    const none = fakeClient({});
    expect(
      await saveCalibrationFeedback(none.client, { householdId: "h", userId: "u", answers: [] }),
    ).toBe(0);
  });

  it("reports a failed lookup or insert", async () => {
    await expect(
      saveCalibrationFeedback(fakeClient({ selectError: "boom" }).client, {
        householdId: "h",
        userId: "u",
        answers,
      }),
    ).rejects.toThrow("boom");
    await expect(
      saveCalibrationFeedback(fakeClient({ insertError: "nope" }).client, {
        householdId: "h",
        userId: "u",
        answers,
      }),
    ).rejects.toThrow("nope");
  });
});
