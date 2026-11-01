import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ width: 390 }));

vi.mock("react-native", () => ({
  useWindowDimensions: () => ({ width: h.width, height: 800, scale: 1, fontScale: 1 }),
}));

import { useBreakpoint, useIsDesktop } from "./useBreakpoint";

describe("useBreakpoint", () => {
  beforeEach(() => {
    h.width = 390;
  });

  it("is phone at the brief's 390 px phone width", () => {
    expect(useBreakpoint()).toBe("phone");
    expect(useIsDesktop()).toBe(false);
  });

  it("is tablet from 768 px", () => {
    h.width = 767;
    expect(useBreakpoint()).toBe("phone");
    h.width = 768;
    expect(useBreakpoint()).toBe("tablet");
    expect(useIsDesktop()).toBe(false);
  });

  it("is desktop from 1024 px, including the brief's 1280 by 800 window", () => {
    h.width = 1023;
    expect(useBreakpoint()).toBe("tablet");
    h.width = 1024;
    expect(useBreakpoint()).toBe("desktop");
    h.width = 1280;
    expect(useBreakpoint()).toBe("desktop");
    expect(useIsDesktop()).toBe(true);
  });
});
