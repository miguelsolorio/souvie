// What the primitives read from the design tokens. They style with plain React Native style
// objects built from `tokens`, not with Tailwind classes, so they look right whether or not the app
// has adopted the Tailwind preset (the preset replaces Tailwind's spacing and font-size scales, so
// adopting it is a pass over every screen, not a one-line change).
//
// Light mode only for now: the app's screens are light only, and a dark control on a light screen
// would be worse than none. When the app turns dark mode on, this file is the one place to branch.
import { tokens } from "../tokens";

export const colors = tokens.color.light;
export const radius = tokens.radius;
export const space = tokens.space;
export const type = tokens.type;

export const fontFamily = undefined; // the platform font; the display face is for headings only

/** A React Native shadow from a token. Android reads `elevation`; iOS and web read the rest. */
export function shadow(name: keyof typeof tokens.shadow) {
  const s = tokens.shadow[name];
  return {
    shadowColor: s.color,
    shadowOffset: { width: s.offsetX, height: s.offsetY },
    shadowOpacity: s.opacity,
    shadowRadius: s.blur / 2,
    elevation: s.elevation,
  } as const;
}

/** Text styles from the type tokens. */
export function textStyle(name: "title" | "body" | "caption") {
  const t = tokens.type[name];
  return {
    fontSize: t.size,
    lineHeight: t.lineHeight,
    fontWeight: t.weight,
    letterSpacing: t.letterSpacing,
  } as const;
}
