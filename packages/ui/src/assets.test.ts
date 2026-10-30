import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The wordmark is live <text>, so its width depends on the reader's font. The font stack is
// Charter, Bitstream Charter, Sitka Text, Cambria, Iowan Old Style, Georgia, serif. The review of
// the first WS14 round found the old placeholder name clipped at Georgia, so this test holds the
// name to the widest serif a fallback can reach.
//
// ADVANCE_PER_MILLE is, per character, the larger of the bold advance widths of Georgia, DejaVu
// Serif and Noto Serif, in thousandths of an em, rounded up. DejaVu is the generic serif on many
// Linux systems. Kerning is ignored. Charter, Iowan Old Style and Times are narrower than this.
// To add a character, read its `hmtx` advance from those three fonts and take the largest.
const ADVANCE_PER_MILLE: Record<string, number> = {
  " ": 349,
  A: 776,
  B: 846,
  C: 796,
  D: 868,
  E: 763,
  F: 710,
  G: 855,
  H: 945,
  I: 468,
  J: 596,
  K: 870,
  L: 704,
  M: 1107,
  N: 915,
  O: 872,
  P: 752,
  Q: 872,
  R: 832,
  S: 723,
  T: 745,
  U: 873,
  V: 776,
  W: 1127,
  X: 809,
  Y: 732,
  Z: 730,
  a: 648,
  b: 700,
  c: 609,
  d: 700,
  e: 637,
  f: 431,
  g: 700,
  h: 728,
  i: 380,
  j: 362,
  k: 693,
  l: 380,
  m: 1059,
  n: 728,
  o: 667,
  p: 700,
  q: 700,
  r: 527,
  s: 563,
  t: 462,
  u: 728,
  v: 606,
  w: 864,
  x: 646,
  y: 582,
  z: 568,
  "0": 702,
  "1": 696,
  "2": 696,
  "3": 696,
  "4": 696,
  "5": 696,
  "6": 696,
  "7": 696,
  "8": 696,
  "9": 696,
};

/** Units of clear space to keep between the widest fallback and the viewBox edge. */
const MARGIN = 4;

const asset = (name: string) => readFileSync(new URL(`../assets/${name}`, import.meta.url), "utf8");

function attr(source: string, name: string): string {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(source);
  if (!match) throw new Error(`no ${name} attribute in: ${source.slice(0, 80)}`);
  return match[1] as string;
}

function parseLogo(name: string) {
  const svg = asset(name);
  const viewBox = attr(svg, "viewBox").split(" ").map(Number) as [number, number, number, number];
  const text = /<text\b([^>]*)>([^<]*)<\/text>/.exec(svg);
  if (!text) throw new Error(`${name} has no <text>`);
  const title = /<title\b[^>]*>([^<]*)<\/title>/.exec(svg)?.[1];
  return {
    width: viewBox[2],
    height: viewBox[3],
    title,
    word: text[2] as string,
    x: Number(attr(text[1] as string, "x")),
    y: Number(attr(text[1] as string, "y")),
    size: Number(attr(text[1] as string, "font-size")),
    spacing: Number(attr(text[1] as string, "letter-spacing")),
  };
}

/** Where the pen ends for the widest fallback: start x plus advances plus letter spacing. */
function widestEnd(logo: ReturnType<typeof parseLogo>): number {
  let end = logo.x;
  for (const char of logo.word) {
    const perMille = ADVANCE_PER_MILLE[char];
    if (perMille === undefined) {
      throw new Error(
        `Add the width of "${char}" to ADVANCE_PER_MILLE (see the comment above it).`,
      );
    }
    end += (perMille / 1000) * logo.size;
  }
  return end + logo.spacing * (logo.word.length - 1);
}

describe("wordmark", () => {
  for (const name of ["logo-wordmark.svg", "logo.svg"]) {
    describe(name, () => {
      const logo = parseLogo(name);

      it("says the same name in <title> and in the live text", () => {
        expect(logo.title).toBe(logo.word);
      });

      it("fits the widest fallback serif with room to spare, so it cannot clip", () => {
        expect(widestEnd(logo) + MARGIN).toBeLessThanOrEqual(logo.width);
      });

      it("has the text inside the box vertically", () => {
        expect(logo.y - logo.size * 0.95).toBeGreaterThanOrEqual(0);
        expect(logo.y + logo.size * 0.3).toBeLessThanOrEqual(logo.height);
      });
    });
  }

  it("the lockup and the wordmark spell the name the same way", () => {
    expect(parseLogo("logo.svg").word).toBe(parseLogo("logo-wordmark.svg").word);
  });

  it("the check would have caught the old placeholder: 'Meal Planner' in a 212-unit box", () => {
    const old = { ...parseLogo("logo-wordmark.svg"), word: "Meal Planner", x: 0, width: 212 };
    expect(widestEnd(old) + MARGIN).toBeGreaterThan(old.width);
  });
});

describe("icon and mark assets", () => {
  it("carry the mark only: no <text>, so renaming never forces new PNGs", () => {
    for (const name of [
      "logo-mark.svg",
      "app-icon.svg",
      "app-icon-foreground.svg",
      "splash-icon.svg",
      "favicon.svg",
    ]) {
      expect(asset(name), name).not.toMatch(/<text\b/);
    }
  });
});
