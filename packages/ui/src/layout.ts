// The one breakpoint system (WS13). Pure: no React, no react-native, so Node and Vitest load it.
//
// Three widths, in CSS pixels of the window:
//   phone    under 768   one column, bottom sheets
//   tablet   768 to 1023 one column that may be wider, centered dialogs instead of bottom sheets
//   desktop  1024 and up the planner shows seven columns, the grocery list two panes, a run a table
//
// `useBreakpoint` (apps/mobile/src/lib/useBreakpoint.ts) reads the window width and calls
// `breakpointFor`. The Sheet primitive calls it too. Add a new threshold here, never a second
// copy somewhere else.

export type Breakpoint = "phone" | "tablet" | "desktop";

/** The smallest window width that counts as a tablet. */
export const BREAKPOINT_TABLET_MIN = 768;

/** The smallest window width that counts as a desktop. */
export const BREAKPOINT_DESKTOP_MIN = 1024;

export function breakpointFor(width: number): Breakpoint {
  if (width >= BREAKPOINT_DESKTOP_MIN) return "desktop";
  if (width >= BREAKPOINT_TABLET_MIN) return "tablet";
  return "phone";
}
