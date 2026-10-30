# @mp/ui

The design system for `apps/mobile` and the brand source for `apps/marketing`: tokens, NativeWind primitives, icons, and theming.

## Status

- **Tokens and brand assets (WS14):** `src/tokens.ts`, `tailwind.preset.js`, `assets/`. Done.
- **Primitives (WS04):** `Sheet`, `Stepper`, `SegmentedControl`, `EmptyState`. Not started.

`apps/mobile/tailwind.config.js` still carries WS00's one placeholder color until WS04 switches it to the preset below.

## Tokens

`src/tokens.ts` exports one object, `tokens`, and its type, `Tokens`:

```ts
import { tokens, type Tokens } from "@mp/ui";   // or "@mp/ui/tokens"

tokens.color.scale.primary[600]   // fixed scales: primary, neutral, success, warning, danger, 50 to 900
tokens.color.light.surface        // semantic aliases per mode
tokens.color.dark.text
tokens.type.body                  // { size, lineHeight, weight, letterSpacing } in px
tokens.space[4]                   // 16: a 4pt grid, the key is the step
tokens.radius.md
tokens.shadow.md
```

Use the semantic names (`surface`, `surfaceRaised`, `text`, `textMuted`, `primary`, `border`, and so on) in screens. They exist for both modes and `src/tokens.test.ts` checks that every text token meets WCAG AA 4.5:1 on each surface it may sit on, in light and dark. Add a new text token and the test fails until you say which surfaces it is for.

## NativeWind and Tailwind

```js
// apps/mobile/tailwind.config.js (WS04 wires this)
presets: [require("nativewind/preset"), require("@mp/ui/tailwind.preset")],
darkMode: "class",
```

The preset reads `tokens`, so there is one source. It gives you:

- Fixed scales: `bg-primary-600`, `text-danger-700`, `border-neutral-200`.
- Mode-aware aliases, defined as CSS variables on `:root` and `:root[class~="dark"]`: `bg-surface`, `bg-surface-raised`, `text-content`, `text-content-muted`, `border-line`, `bg-primary`, `bg-primary-pressed`. One class works in both modes. Toggle dark with NativeWind's `colorScheme`.
- Type: `text-display`, `text-title`, `text-body`, `text-caption` (size, line height, weight, tracking).
- Spacing on the 4pt grid in px (`p-4` is 16), `rounded-md`, `shadow-md`.

The preset is ESM that imports TypeScript, so loading it needs Node 22.18 or newer (built-in type stripping). `require()` from a CommonJS config returns the preset itself.

## CSS for the web

`@mp/ui/css` has `tokensCss()`, which `apps/marketing/scripts/sync-brand.mjs` writes to `apps/marketing/src/styles/tokens.css`. Do not hand-edit that file.

## Assets

`assets/` holds the logo and the icon sources. Everything here is SVG.

| File | What |
|---|---|
| `logo-mark.svg` | The mark alone: a bowl with two leaves |
| `logo-wordmark.svg` | The name alone, as live `<text>` |
| `logo.svg` | Mark plus wordmark |
| `app-icon.svg`, `app-icon-foreground.svg`, `splash-icon.svg`, `favicon.svg` | Sources for the PNGs in `apps/mobile/assets/` |

The wordmark is the placeholder "Meal Planner". To swap the name, change the text inside `<text id="wordmark">` and the `<title>` in `logo.svg` and `logo-wordmark.svg`. Widen the `viewBox` if the new name is longer.

Regenerate the PNGs with `rsvg-convert` (`brew install librsvg`):

```bash
rsvg-convert -w 1024 -h 1024 assets/app-icon.svg            -o ../../apps/mobile/assets/icon.png
rsvg-convert -w 1024 -h 1024 assets/app-icon-foreground.svg -o ../../apps/mobile/assets/adaptive-icon.png
rsvg-convert -w 1024 -h 1024 assets/splash-icon.svg         -o ../../apps/mobile/assets/splash-icon.png
rsvg-convert -w 48   -h 48   assets/favicon.svg             -o ../../apps/mobile/assets/favicon.png
```

`icon.png` is opaque with no rounded corners: iOS and Android apply their own masks. The adaptive icon's background color (`#2F6B4F`) and the splash background are set in `apps/mobile/app.json`.

## Scripts

```bash
pnpm --filter @mp/ui typecheck
pnpm --filter @mp/ui lint
pnpm --filter @mp/ui test
```
