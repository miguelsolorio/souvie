// The swipe screen's state (WS06): twelve cards, each answered like or skip. A right swipe is a
// like; a left swipe is a skip, stored as the `skipped` signal (docs/02 §Planning). "Skip the rest"
// ends the deck early. Pure functions, so Vitest runs them.
import type { CalibrationCard } from "@mp/core";

export type SwipeSignal = "like" | "skipped";

export interface Answer {
  recipeId: string;
  signal: SwipeSignal;
}

export interface CalibrationState {
  cards: readonly CalibrationCard[];
  answers: readonly Answer[];
  /** The person chose "Skip the rest". */
  endedEarly: boolean;
}

export function startCalibration(cards: readonly CalibrationCard[]): CalibrationState {
  return { cards, answers: [], endedEarly: false };
}

export function currentCard(state: CalibrationState): CalibrationCard | null {
  if (state.endedEarly) return null;
  return state.cards[state.answers.length] ?? null;
}

export function isFinished(state: CalibrationState): boolean {
  return state.endedEarly || state.answers.length >= state.cards.length;
}

/** Records an answer for the card on top. Does nothing once the deck is finished. */
export function answerCard(state: CalibrationState, signal: SwipeSignal): CalibrationState {
  const card = currentCard(state);
  if (!card) return state;
  return { ...state, answers: [...state.answers, { recipeId: card.recipeId, signal }] };
}

/** "Skip the rest": keep what was answered, ask no more. */
export function skipRest(state: CalibrationState): CalibrationState {
  return isFinished(state) ? state : { ...state, endedEarly: true };
}

/** Undo the last answer, for a swipe the person regrets. */
export function undoAnswer(state: CalibrationState): CalibrationState {
  if (state.answers.length === 0) return state;
  return { ...state, endedEarly: false, answers: state.answers.slice(0, -1) };
}

export function progressOf(state: CalibrationState): { answered: number; total: number } {
  return { answered: state.answers.length, total: state.cards.length };
}

export interface FeedbackRow {
  household_id: string;
  user_id: string;
  recipe_id: string;
  signal: SwipeSignal;
}

/**
 * The recipe_feedback rows to insert, leaving out recipes the person already answered (a resumed
 * or repeated calibration must not write twice). `existing` lists recipe ids with a like or skip
 * from this person.
 */
export function feedbackRows(
  householdId: string,
  userId: string,
  answers: readonly Answer[],
  existing: ReadonlySet<string> = new Set(),
): FeedbackRow[] {
  const seen = new Set(existing);
  const rows: FeedbackRow[] = [];
  for (const answer of answers) {
    if (seen.has(answer.recipeId)) continue;
    seen.add(answer.recipeId);
    rows.push({
      household_id: householdId,
      user_id: userId,
      recipe_id: answer.recipeId,
      signal: answer.signal,
    });
  }
  return rows;
}

/** A swipe gesture's horizontal travel, in points, that counts as an answer. */
export const SWIPE_THRESHOLD = 90;

/** Which answer a finished drag means, or null when it did not travel far enough. */
export function signalForDrag(dx: number, threshold = SWIPE_THRESHOLD): SwipeSignal | null {
  if (dx >= threshold) return "like";
  if (dx <= -threshold) return "skipped";
  return null;
}
