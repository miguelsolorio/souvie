import { describe, expect, it } from "vitest";
import type { ColorMode } from "./tokens";
import { tokens } from "./tokens";

// WCAG 2.x relative luminance and contrast ratio.
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => {
    const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [r = 0, g = 0, b = 0] = channels;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const [lighter = 0, darker = 0] = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

type SemanticName = keyof typeof tokens.color.light;

// Every text token and the surfaces it may sit on. A new text* token with no row here fails
// the coverage test below, so contrast cannot be skipped by forgetting to list it.
const TEXT_ON: Record<string, SemanticName[]> = {
  text: [
    "surface",
    "surfaceRaised",
    "surfaceSunken",
    "surfaceBrand",
    "surfaceSuccess",
    "surfaceWarning",
    "surfaceDanger",
  ],
  textMuted: ["surface", "surfaceRaised", "surfaceSunken"],
  textInverse: ["surfaceInverse"],
  textOnPrimary: ["primary", "primaryPressed"],
  textLink: ["surface", "surfaceRaised", "surfaceBrand"],
  textSuccess: ["surface", "surfaceRaised", "surfaceSuccess"],
  textWarning: ["surface", "surfaceRaised", "surfaceWarning"],
  textDanger: ["surface", "surfaceRaised", "surfaceDanger"],
};

// Non-text elements (WCAG 1.4.11): interactive borders, focus rings, status icons. 3:1.
const UI_ON: Record<string, SemanticName[]> = {
  borderStrong: ["surface", "surfaceRaised"],
  borderFocus: ["surface", "surfaceRaised"],
  primary: ["surface", "surfaceRaised"],
  success: ["surface", "surfaceRaised"],
  warning: ["surface", "surfaceRaised"],
  danger: ["surface", "surfaceRaised"],
};

const MODES: ColorMode[] = ["light", "dark"];
const HEX = /^#[0-9A-F]{6}$/i;

describe("token shape", () => {
  it("has the documented top-level keys", () => {
    expect(Object.keys(tokens).sort()).toEqual(["color", "radius", "shadow", "space", "type"]);
    expect(Object.keys(tokens.color).sort()).toEqual(["dark", "light", "scale"]);
  });

  it("gives light and dark the same semantic names", () => {
    expect(Object.keys(tokens.color.dark).sort()).toEqual(Object.keys(tokens.color.light).sort());
  });

  it("uses 6-digit hex everywhere", () => {
    for (const mode of MODES) {
      for (const [name, value] of Object.entries(tokens.color[mode])) {
        expect(value, `${mode}.${name}`).toMatch(HEX);
      }
    }
    for (const [family, steps] of Object.entries(tokens.color.scale)) {
      for (const [step, value] of Object.entries(steps)) {
        expect(value, `${family}.${step}`).toMatch(HEX);
      }
    }
  });

  it("has the five scales, 50 to 900, getting darker at every step", () => {
    expect(Object.keys(tokens.color.scale).sort()).toEqual([
      "danger",
      "neutral",
      "primary",
      "success",
      "warning",
    ]);
    for (const [family, steps] of Object.entries(tokens.color.scale)) {
      const keys = Object.keys(steps).map(Number);
      expect(keys, family).toEqual([50, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
      const lum = Object.values(steps).map(luminance);
      for (let i = 1; i < lum.length; i += 1) {
        expect(lum[i], `${family} step ${keys[i]}`).toBeLessThan(lum[i - 1] ?? 0);
      }
    }
  });
});

describe("WCAG AA contrast", () => {
  it("lists every text token in TEXT_ON", () => {
    const textTokens = Object.keys(tokens.color.light).filter((name) => name.startsWith("text"));
    expect(Object.keys(TEXT_ON).sort()).toEqual(textTokens.sort());
  });

  for (const mode of MODES) {
    describe(mode, () => {
      const palette = tokens.color[mode];

      for (const [foreground, surfaces] of Object.entries(TEXT_ON)) {
        for (const surface of surfaces) {
          it(`${foreground} on ${surface} is at least 4.5:1`, () => {
            const fg = palette[foreground as SemanticName];
            const bg = palette[surface];
            expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
          });
        }
      }

      for (const [foreground, surfaces] of Object.entries(UI_ON)) {
        for (const surface of surfaces) {
          it(`${foreground} on ${surface} is at least 3:1 (non-text)`, () => {
            const fg = palette[foreground as SemanticName];
            const bg = palette[surface];
            expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
          });
        }
      }
    });
  }

  it("catches a failing pair (the helper is not a no-op)", () => {
    expect(contrast("#777777", "#888888")).toBeLessThan(4.5);
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
  });
});

describe("scales other than color", () => {
  it("keeps the spacing on a 4pt grid", () => {
    for (const [step, value] of Object.entries(tokens.space)) {
      expect(value % 4, `space ${step}`).toBe(0);
      expect(value, `space ${step}`).toBe(Number(step) * 4);
    }
  });

  it("defines display, title, body, and caption with room between lines", () => {
    for (const name of ["display", "title", "body", "caption"] as const) {
      const spec = tokens.type[name];
      expect(spec.lineHeight, name).toBeGreaterThan(spec.size);
    }
    expect(tokens.type.display.size).toBeGreaterThan(tokens.type.title.size);
    expect(tokens.type.title.size).toBeGreaterThan(tokens.type.body.size);
    expect(tokens.type.body.size).toBeGreaterThan(tokens.type.caption.size);
  });

  it("has increasing radius and shadow steps", () => {
    const { none, sm, md, lg, xl } = tokens.radius;
    expect([none, sm, md, lg, xl]).toEqual([...[none, sm, md, lg, xl]].sort((a, b) => a - b));
    expect(tokens.shadow.sm.blur).toBeLessThan(tokens.shadow.md.blur);
    expect(tokens.shadow.md.blur).toBeLessThan(tokens.shadow.lg.blur);
  });
});
