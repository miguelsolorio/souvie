// What the add-recipe screen says about sharing, on the web and in the desktop app (WS13). A
// browser has no share sheet to receive from, so the screen points at pasting instead. The phone
// version is shareCapability.native.ts.

/** A line under the link box, or null for none. */
export const LINK_TAB_HINT: string | null =
  "There is no share sheet on the web. Copy the recipe's link and paste it here, or copy a post's caption and paste it on the Paste tab.";

/** Shown when the pasted link is to a video platform, whose videos are never downloaded (R11). */
export const VIDEO_LINK_ADVICE =
  "We do not download videos. Copy the post's caption and paste it on the Paste tab, or paste the recipe text.";
