import { describe, expect, it } from "vitest";
import { initialsOf } from "./initials";

describe("initialsOf", () => {
  it("uses the first and last word", () => {
    expect(initialsOf("Alice Jones")).toBe("AJ");
    expect(initialsOf("alice marie jones")).toBe("AJ");
  });

  it("handles one word, extra spaces, and nothing", () => {
    expect(initialsOf("alice")).toBe("A");
    expect(initialsOf("  Alice   Jones  ")).toBe("AJ");
    expect(initialsOf("")).toBe("?");
    expect(initialsOf(null)).toBe("?");
    expect(initialsOf(undefined)).toBe("?");
  });
});
