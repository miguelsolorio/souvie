// What the add-recipe screen says about sharing, on iOS and Android (WS13). A phone can have a post
// shared into the app (ShareIntentReceiver.native.tsx), so the screen needs no hint about pasting.
// The web version is shareCapability.ts.

/** A line under the link box, or null for none. */
export const LINK_TAB_HINT: string | null = null;

/** Shown when the pasted link is to a video platform, whose videos are never downloaded (R11). */
export const VIDEO_LINK_ADVICE =
  "We do not download videos. Share the post into this app to import its caption, or paste the recipe text.";
