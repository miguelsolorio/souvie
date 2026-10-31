import { describe, expect, it } from "vitest";
import {
  canStep,
  clamp,
  formatStepValue,
  MIN_TARGET,
  nextSegment,
  SHEET_DIALOG_MIN_WIDTH,
  sheetLayout,
  stepperSpeech,
  stepValue,
} from "./logic";

const servings = { min: 1, max: 12, step: 1 };

describe("stepValue", () => {
  it("steps up and down by one", () => {
    expect(stepValue(4, 1, servings)).toBe(5);
    expect(stepValue(4, -1, servings)).toBe(3);
  });

  it("stops at the bounds", () => {
    expect(stepValue(12, 1, servings)).toBe(12);
    expect(stepValue(1, -1, servings)).toBe(1);
  });

  it("pulls an out-of-range value back inside", () => {
    expect(stepValue(40, 1, servings)).toBe(12);
    expect(stepValue(-3, -1, servings)).toBe(1);
  });

  it("snaps a between-steps value to the next boundary instead of skipping one", () => {
    // A recipe that makes 2.5 servings: plus goes to 3, minus to 2.
    expect(stepValue(2.5, 1, servings)).toBe(3);
    expect(stepValue(2.5, -1, servings)).toBe(2);
  });

  it("handles half steps without float drift", () => {
    const half = { min: 0.5, max: 10, step: 0.5 };
    let value = 0.5;
    for (let i = 0; i < 9; i++) value = stepValue(value, 1, half);
    expect(value).toBe(5);
    expect(stepValue(0.1 + 0.2, 1, { min: 0, max: 5, step: 0.1 })).toBe(0.4);
  });
});

describe("canStep", () => {
  it("is false at a bound in that direction only", () => {
    expect(canStep(12, 1, servings)).toBe(false);
    expect(canStep(12, -1, servings)).toBe(true);
    expect(canStep(1, -1, servings)).toBe(false);
    expect(canStep(1, 1, servings)).toBe(true);
  });
});

describe("formatting", () => {
  it("shows whole numbers plainly and fractions to two places", () => {
    expect(formatStepValue(4)).toBe("4");
    expect(formatStepValue(2.5)).toBe("2.5");
    expect(formatStepValue(2.333333)).toBe("2.33");
  });

  it("speaks the value with its unit, singular at one", () => {
    expect(stepperSpeech(4, "serving", "servings")).toBe("4 servings");
    expect(stepperSpeech(1, "serving", "servings")).toBe("1 serving");
    expect(stepperSpeech(3, undefined)).toBe("3");
    expect(stepperSpeech(3, "person")).toBe("3 person");
  });
});

describe("clamp", () => {
  it("limits a value to a range", () => {
    expect(clamp(5, 1, 3)).toBe(3);
    expect(clamp(-5, 1, 3)).toBe(1);
    expect(clamp(2, 1, 3)).toBe(2);
  });
});

describe("sheetLayout", () => {
  it("rises from the bottom on a phone and centers on a wide screen", () => {
    expect(sheetLayout(390)).toBe("sheet");
    expect(sheetLayout(SHEET_DIALOG_MIN_WIDTH - 1)).toBe("sheet");
    expect(sheetLayout(SHEET_DIALOG_MIN_WIDTH)).toBe("dialog");
    expect(sheetLayout(1280)).toBe("dialog");
  });
});

describe("nextSegment", () => {
  it("moves one segment and wraps at the ends", () => {
    expect(nextSegment(3, 0, 1)).toBe(1);
    expect(nextSegment(3, 2, 1)).toBe(0);
    expect(nextSegment(3, 0, -1)).toBe(2);
    expect(nextSegment(0, 0, 1)).toBe(0);
  });
});

describe("tap targets", () => {
  it("are at least 44 points", () => {
    expect(MIN_TARGET).toBeGreaterThanOrEqual(44);
  });
});
