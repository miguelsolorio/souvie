# @mp/ui

The design system for `apps/mobile` and the brand source for `apps/marketing`: tokens, NativeWind primitives, icons, and theming.

## Status

- **Tokens and brand assets (WS14):** `src/tokens.ts`, `tailwind.preset.js`, `assets/`. Done.
- **Primitives (WS04):** `Sheet`, `Stepper`, `SegmentedControl`, `EmptyState`. Done. See Primitives below.

`apps/mobile/tailwind.config.js` still carries WS00's one placeholder color, and WS04 did not switch it to the preset below. The preset replaces Tailwind's spacing, font-size, radius and shadow scales instead of extending them, so every existing screen's `text-sm`, `text-base` and `gap-1.5` would stop resolving. Adopting it is a pass over every screen, so it is the orchestrator's call, not a side effect of a feature workstream.

## Primitives

```tsx
import { EmptyState, SegmentedControl, Sheet, Stepper } from "@mp/ui/primitives";
```

They live behind `@mp/ui/primitives`, not the package root, because the root also loads in Node (the Tailwind preset, the marketing site's sync script) and the primitives need `react-native`.

| Primitive | What it is |
|---|---|
| `Sheet` | A bottom sheet on a phone, a centered dialog from 640 px wide. A modal: it traps focus, closes on Escape, Back and a backdrop tap, lifts above the keyboard, and scrolls. Pass `bottomInset` the safe-area bottom inset |
| `Stepper` | A number with 44 point minus and plus buttons. For a screen reader it is one adjustable element with a spoken value ("4 servings") |
| `SegmentedControl` | Two to four exclusive choices in a row, announced as tabs with the selected one marked |
| `EmptyState` | A title, a reason, and an optional next step, for a list with nothing in it |

They are styled with React Native style objects built from `tokens` (`src/primitives/theme.ts`), not Tailwind classes, so they look right with or without the preset and need no `content` entry in a Tailwind config. They are light mode only, like the app's screens today; `theme.ts` is the one place to branch when dark mode arrives. The stepping, formatting and layout rules are in `src/primitives/logic.ts`, which loads in Node and is unit tested.

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

The name is Souvie, said "SOO-vee" (docs/08-brand.md §1). It appears as text in `logo.svg` and `logo-wordmark.svg` and as the `<title>` of every SVG here. Only those two files carry the wordmark. The mark, the icons, and the splash are the bowl alone, so a rename never needs new PNGs in `apps/mobile/assets/`.

### Wordmark fit

The wordmark is live `<text>`, so the font is the reader's: Charter, then Georgia and the rest of the stack in the `font-family` attribute, then whatever `serif` is. A box sized for Charter clips the last letters in Georgia, which is about 14% wider (the placeholder name did exactly that). The `viewBox` has to hold the widest serif the stack can reach.

To change the name:

1. Change the text inside `<text id="wordmark">` and the `<title>` in `logo.svg` and `logo-wordmark.svg`. Also change `apps/marketing/src/config.ts` and `apps/marketing/src/assets/og.svg`.
2. Size the box. `src/assets.test.ts` computes where the text ends in the widest bold serif (Georgia, DejaVu Serif, or Noto Serif, whichever is widest per letter) and fails if it plus 4 units does not fit. Raise the `viewBox` width until it passes. In `logo.svg`, also set the `width` and `height` of the logo `<img>` in `apps/marketing/src/layouts/Base.astro` to the new `viewBox` size.
3. Look at it. Render each system serif on a canvas wider than the box and check that no ink passes the edge. For `Souvie` the ink ends at 103 in Charter, 116 in Georgia, and about 124 in DejaVu Serif Bold, inside a 132-unit wordmark.
4. Run `pnpm --filter marketing tokens` to copy the SVGs into `apps/marketing/public/`, and re-render `og.png` (see `apps/marketing/README.md`).

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
