// The shape both pickRecipePhoto files share (WS13): pickRecipePhoto.native.ts for iOS and Android,
// pickRecipePhoto.ts for the web and the desktop app. Metro picks the .native file on a phone and
// the other everywhere else, and TypeScript holds the two to this one signature.

/** Phones shoot 12 MP or more. A recipe card reads fine at this width and uploads in a moment. */
export const MAX_WIDTH_PX = 1600;

/** JPEG quality for the shrunken photo, 0 to 1. */
export const JPEG_QUALITY = 0.8;

export interface PickedPhoto {
  bytes: ArrayBuffer;
  contentType: "image/jpeg";
}

/**
 * Takes a photo with the camera or chooses one from the library or the computer's files, shrinks
 * it to at most MAX_WIDTH_PX wide, and returns JPEG bytes ready for `uploadRecipeImage`. Returns
 * null if the person cancelled. Throws an Error with a message fit to show when the photo cannot
 * be read or the camera permission is refused.
 */
export type PickRecipePhoto = (source: "camera" | "library") => Promise<PickedPhoto | null>;
