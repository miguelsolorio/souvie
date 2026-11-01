// The pure parts of the primitives, so they can be tested without a renderer. No React, no
// react-native: this file loads in Node.
import { BREAKPOINT_TABLET_MIN, breakpointFor } from "../layout";

/** Smallest tap target that works for most thumbs (Apple HIG and Material both say 44 to 48). */
export const MIN_TARGET = 44;

/**
 * At and above this width a Sheet becomes a centered dialog instead of rising from the bottom.
 * It is the tablet breakpoint (../layout.ts), so the Sheet and every screen share one system.
 */
export const SHEET_DIALOG_MIN_WIDTH = BREAKPOINT_TABLET_MIN;

export interface StepBounds {
  min: number;
  max: number;
  step: number;
}

/** Rounds away the 0.1 + 0.2 kind of drift so a half-step stepper never shows 2.5000000000000004. */
function tidy(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * One press of plus (direction 1) or minus (direction -1). Stays inside [min, max], and a value
 * that is between steps (the recipe makes 2.5 servings and the step is 1) snaps to the next
 * step boundary on the way instead of skipping a whole step.
 */
export function stepValue(value: number, direction: 1 | -1, bounds: StepBounds): number {
  const { min, max, step } = bounds;
  const onGrid = tidy((value - min) / step);
  const index = Number.isInteger(onGrid)
    ? onGrid + direction
    : direction === 1
      ? Math.ceil(onGrid)
      : Math.floor(onGrid);
  return clamp(tidy(min + index * step), min, max);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function canStep(value: number, direction: 1 | -1, bounds: StepBounds): boolean {
  return stepValue(value, direction, bounds) !== clamp(value, bounds.min, bounds.max);
}

/** "4", "2.5": whole numbers without a decimal point, anything else to two places at most. */
export function formatStepValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

/** The spoken value for a stepper: "4 servings", "1 serving". */
export function stepperSpeech(value: number, unit: string | undefined, unitPlural = unit): string {
  const text = formatStepValue(value);
  if (!unit) return text;
  return `${text} ${value === 1 ? unit : (unitPlural ?? unit)}`;
}

export type SheetLayout = "sheet" | "dialog";

export function sheetLayout(windowWidth: number): SheetLayout {
  return breakpointFor(windowWidth) === "phone" ? "sheet" : "dialog";
}

/** The index of the option after a left or right arrow, wrapping at the ends. */
export function nextSegment(count: number, current: number, direction: 1 | -1): number {
  if (count <= 0) return 0;
  return (current + direction + count) % count;
}
