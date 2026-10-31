import type { CalibrationCard } from "@mp/core";
import { describe, expect, it } from "vitest";
import {
  answerCard,
  currentCard,
  feedbackRows,
  isFinished,
  progressOf,
  SWIPE_THRESHOLD,
  signalForDrag,
  skipRest,
  startCalibration,
  undoAnswer,
} from "./calibration";

const card = (i: number): CalibrationCard => ({
  recipeId: `c77e0000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  title: `Recipe ${i}`,
  description: null,
  imageUrl: null,
  sourceUrl: null,
  cuisine: null,
  totalMin: 30,
  tags: [],
});
const CARDS = Array.from({ length: 12 }, (_, i) => card(i));

describe("the swipe deck", () => {
  it("shows the cards in order and counts progress", () => {
    let state = startCalibration(CARDS);
    expect(currentCard(state)?.title).toBe("Recipe 0");
    expect(progressOf(state)).toEqual({ answered: 0, total: 12 });
    state = answerCard(state, "like");
    state = answerCard(state, "dislike");
    expect(currentCard(state)?.title).toBe("Recipe 2");
    expect(progressOf(state)).toEqual({ answered: 2, total: 12 });
    expect(state.answers).toEqual([
      { recipeId: CARDS[0]?.recipeId, signal: "like" },
      { recipeId: CARDS[1]?.recipeId, signal: "dislike" },
    ]);
  });

  it("is finished after all twelve cards are answered (acceptance criterion: all twelve)", () => {
    let state = startCalibration(CARDS);
    for (let i = 0; i < 12; i++) state = answerCard(state, i % 2 === 0 ? "like" : "dislike");
    expect(isFinished(state)).toBe(true);
    expect(currentCard(state)).toBeNull();
    expect(answerCard(state, "like")).toBe(state);
  });

  it("is finished at once for a deck of nothing", () => {
    const state = startCalibration([]);
    expect(isFinished(state)).toBe(true);
    expect(currentCard(state)).toBeNull();
  });

  it("ends early on Skip the rest and keeps what was answered", () => {
    let state = startCalibration(CARDS);
    state = answerCard(state, "like");
    state = skipRest(state);
    expect(isFinished(state)).toBe(true);
    expect(currentCard(state)).toBeNull();
    expect(state.answers).toHaveLength(1);
    expect(answerCard(state, "like").answers).toHaveLength(1);
  });

  it("undoes the last answer and reopens a deck that was ended early", () => {
    let state = startCalibration(CARDS);
    state = answerCard(state, "like");
    state = answerCard(state, "like");
    state = skipRest(state);
    state = undoAnswer(state);
    expect(state.answers).toHaveLength(1);
    expect(isFinished(state)).toBe(false);
    expect(currentCard(state)?.title).toBe("Recipe 1");
    expect(undoAnswer(startCalibration(CARDS)).answers).toHaveLength(0);
  });
});

describe("feedbackRows", () => {
  const answers = [
    { recipeId: "r1", signal: "like" as const },
    { recipeId: "r2", signal: "dislike" as const },
    { recipeId: "r1", signal: "dislike" as const },
  ];

  it("builds one row per recipe with the household", () => {
    const rows = feedbackRows("h1", answers);
    expect(rows).toEqual([
      { household_id: "h1", recipe_id: "r1", signal: "like" },
      { household_id: "h1", recipe_id: "r2", signal: "dislike" },
    ]);
  });

  it("leaves out recipes the person already answered", () => {
    const rows = feedbackRows("h1", answers, new Set(["r2"]));
    expect(rows.map((r) => r.recipe_id)).toEqual(["r1"]);
  });

  it("uses only the like and dislike signals a client may insert", () => {
    for (const row of feedbackRows("h", answers)) {
      expect(["like", "dislike"]).toContain(row.signal);
    }
  });

  it("names only columns WS04 grants a client insert on, and never user_id", () => {
    // WS04: grant insert (id, household_id, recipe_id, signal, rating) on recipe_feedback.
    // user_id comes from the column default, so naming it is "permission denied for table".
    const granted = new Set(["id", "household_id", "recipe_id", "signal", "rating"]);
    for (const row of feedbackRows("h", answers)) {
      expect(Object.keys(row).every((column) => granted.has(column))).toBe(true);
      expect(row).not.toHaveProperty("user_id");
    }
  });
});

describe("signalForDrag", () => {
  it("means like to the right and skip to the left, past the threshold", () => {
    expect(signalForDrag(SWIPE_THRESHOLD)).toBe("like");
    expect(signalForDrag(200)).toBe("like");
    expect(signalForDrag(-SWIPE_THRESHOLD)).toBe("dislike");
    expect(signalForDrag(-250)).toBe("dislike");
  });

  it("ignores a short drag", () => {
    expect(signalForDrag(SWIPE_THRESHOLD - 1)).toBeNull();
    expect(signalForDrag(0)).toBeNull();
    expect(signalForDrag(-(SWIPE_THRESHOLD - 1))).toBeNull();
  });
});
