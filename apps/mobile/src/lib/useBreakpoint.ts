// The window's breakpoint: phone, tablet or desktop (WS13). The thresholds live in
// @mp/ui/layout so the Sheet primitive and every screen read the same ones. Do not compare
// window widths to numbers anywhere else.
import { type Breakpoint, breakpointFor } from "@mp/ui/layout";
import { useWindowDimensions } from "react-native";

export type { Breakpoint };

/** `phone` under 768, `tablet` from 768, `desktop` from 1024. Follows a resized browser window. */
export function useBreakpoint(): Breakpoint {
  const { width } = useWindowDimensions();
  return breakpointFor(width);
}

/** True at the desktop breakpoint: the seven-column planner, the two-pane list, the run table. */
export function useIsDesktop(): boolean {
  return useBreakpoint() === "desktop";
}
