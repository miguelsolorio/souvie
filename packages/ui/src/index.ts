// @mp/ui: Design system: tokens, NativeWind primitives, icons, theming.
// WS14 adds the tokens. WS04 adds the first primitives. See README.md.
//
// CSS helpers live behind `@mp/ui/css`, not here: they use `.ts` import paths so Node can load
// them directly (tailwind.preset.js, apps/marketing/scripts/sync-brand.mjs), and app code never
// needs them.
export const packageName = "@mp/ui";

export type { ColorMode, Tokens } from "./tokens";
export { tokens } from "./tokens";
