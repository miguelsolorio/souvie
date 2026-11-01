import { describe, expect, it } from "vitest";
import { BREAKPOINT_DESKTOP_MIN, BREAKPOINT_TABLET_MIN, breakpointFor } from "./layout";

describe("breakpointFor", () => {
  it("uses the thresholds 0, 768 and 1024", () => {
    expect(BREAKPOINT_TABLET_MIN).toBe(768);
    expect(BREAKPOINT_DESKTOP_MIN).toBe(1024);
  });

  it("calls a phone a phone, from zero up to the tablet threshold", () => {
    expect(breakpointFor(0)).toBe("phone");
    expect(breakpointFor(320)).toBe("phone");
    expect(breakpointFor(390)).toBe("phone");
    expect(breakpointFor(767)).toBe("phone");
    expect(breakpointFor(767.5)).toBe("phone");
  });

  it("calls 768 to 1023 a tablet", () => {
    expect(breakpointFor(768)).toBe("tablet");
    expect(breakpointFor(834)).toBe("tablet");
    expect(breakpointFor(1023)).toBe("tablet");
  });

  it("calls 1024 and up a desktop", () => {
    expect(breakpointFor(1024)).toBe("desktop");
    expect(breakpointFor(1280)).toBe("desktop");
    expect(breakpointFor(2560)).toBe("desktop");
  });
});
