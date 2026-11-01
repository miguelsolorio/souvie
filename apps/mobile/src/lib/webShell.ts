// Text and CSS for the web export's HTML shell (app/+html.tsx). Plain strings and one function, so
// a test can check them without rendering the shell.
import { tokens } from "@mp/ui";

export const DOCUMENT_TITLE = "Souvie";

export const DOCUMENT_DESCRIPTION = "Plan the week, build one grocery list, and shop in one place.";

/**
 * A focus ring for keyboard users. `:focus-visible` shows it for Tab and arrow keys and not for a
 * mouse click, so it does not clutter a pointer user's screen. The color is the design system's
 * `borderFocus` token (light mode, since the app is light only), which meets 3:1 on white.
 *
 * One rule, so every focusable control has the same ring whatever react-native-web draws for it.
 */
export function focusRingCss(): string {
  const ring = tokens.color.light.borderFocus;
  return [
    `:root{--mp-focus-ring:${ring}}`,
    ":focus-visible{outline:3px solid var(--mp-focus-ring);outline-offset:2px}",
    // Text fields already have a border; pull the ring in so it does not collide with the label.
    "input:focus-visible,textarea:focus-visible{outline-offset:0}",
  ].join("\n");
}
