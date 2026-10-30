// Tailwind and NativeWind preset built from the token object in src/tokens.ts (WS14).
//
// Use it from a Tailwind config:
//   presets: [require("nativewind/preset"), require("@mp/ui/tailwind.preset")],
//
// Semantic colors are CSS variables so one class works in both modes:
//   bg-surface, bg-surface-raised, text-content, text-content-muted, border-line, bg-primary.
// The variables are defined for `:root` (light) and `:root[class~="dark"]` (dark), a form
// NativeWind reads when `darkMode` is "class". Fixed scales stay available as bg-primary-600.
//
// Loading this file needs Node 22.18 or newer: it imports TypeScript source and relies on
// Node's built-in type stripping. Metro, Tailwind CLI, and Vitest all run under that Node.

import { colorVars, kebab, shadowCss } from "./src/css.ts";
import { tokens } from "./src/tokens.ts";

/** `rgb(var(--color-surface) / <alpha-value>)`, so opacity modifiers like bg-surface/50 work. */
const semantic = (name) => `rgb(var(--color-${kebab(name)}) / <alpha-value>)`;

const px = (value) => `${value}px`;

const entries = (object, map) =>
  Object.fromEntries(Object.entries(object).map(([k, v]) => [k, map(v, k)]));

/** Keep only the semantic names that start with `prefix`, keyed without it. */
function group(prefix, keys) {
  const out = {};
  for (const key of keys) {
    const rest = key === prefix ? "DEFAULT" : kebab(key.slice(prefix.length));
    out[rest] = semantic(key);
  }
  return out;
}

const names = Object.keys(tokens.color.light);
const starting = (prefix) => names.filter((name) => name === prefix || name.startsWith(prefix));

const fontSize = Object.fromEntries(
  Object.entries(tokens.type)
    .filter(([name]) => name !== "fontFamily")
    .map(([name, spec]) => [
      name,
      [
        px(spec.size),
        {
          lineHeight: px(spec.lineHeight),
          fontWeight: spec.weight,
          letterSpacing: px(spec.letterSpacing),
        },
      ],
    ]),
);

/** @type {Partial<import('tailwindcss').Config>} */
const preset = {
  darkMode: "class",
  theme: {
    // The 4pt grid, in px so NativeWind's 14px rem never skews it.
    spacing: { px: "1px", ...entries(tokens.space, px) },
    borderRadius: { DEFAULT: px(tokens.radius.md), ...entries(tokens.radius, px) },
    boxShadow: entries(tokens.shadow, shadowCss),
    fontSize,
    extend: {
      colors: {
        // Fixed scales. `DEFAULT` follows the mode for the accents that have a semantic fill.
        primary: {
          ...tokens.color.scale.primary,
          DEFAULT: semantic("primary"),
          pressed: semantic("primaryPressed"),
        },
        neutral: tokens.color.scale.neutral,
        success: { ...tokens.color.scale.success, DEFAULT: semantic("success") },
        warning: { ...tokens.color.scale.warning, DEFAULT: semantic("warning") },
        danger: { ...tokens.color.scale.danger, DEFAULT: semantic("danger") },
        // Mode-aware semantic aliases.
        surface: group("surface", starting("surface")),
        content: group("text", starting("text")),
        line: group("border", starting("border")),
      },
      fontFamily: {
        sans: [tokens.type.fontFamily.sans],
        display: [tokens.type.fontFamily.display],
      },
    },
  },
  plugins: [
    // A bare function is a valid Tailwind plugin. No import from tailwindcss is needed.
    // The dark selector is an attribute match, not `.dark:root`: Tailwind drops base rules
    // that contain a class unless the class shows up in `content`.
    ({ addBase }) => {
      addBase({
        ":root": colorVars("light", "triplet"),
        ':root[class~="dark"]': colorVars("dark", "triplet"),
      });
    },
  ],
};

export default preset;

// Lets a CommonJS Tailwind config (apps/mobile/tailwind.config.js) call
// `require("@mp/ui/tailwind.preset")` and get the preset itself instead of `{ default }`.
export { preset as "module.exports" };
