// The web and desktop version of pickRecipePhoto (WS13). A browser has no camera permission
// screen to walk through and no photo library: it opens the operating system's file picker. On a
// phone's browser the picker offers the camera too. The phone app's version is
// pickRecipePhoto.native.ts; pickRecipePhoto.types.ts holds the contract both keep.
//
// Everything that touches the page (the file input, the canvas) is behind `PhotoDeps`, so the
// steps in between (the size to shrink to, what to throw) are unit-tested without a browser.
import {
  JPEG_QUALITY,
  MAX_WIDTH_PX,
  type PickedPhoto,
  type PickRecipePhoto,
} from "./pickRecipePhoto.types";

export type { PickedPhoto } from "./pickRecipePhoto.types";

export interface PhotoDeps {
  /** Opens the file picker. Null when the person closed it without choosing. */
  chooseFile: (capture: boolean) => Promise<Blob | null>;
  /** Reads the pixels' size. Throws when the file is not an image the browser can decode. */
  measure: (file: Blob) => Promise<{ width: number; height: number }>;
  /** Draws the image at `width` by `height` and encodes it as JPEG. */
  encode: (file: Blob, width: number, height: number, quality: number) => Promise<Blob>;
}

/** `width` by `height`, scaled down to `maxWidth` wide if it is wider, keeping the proportions. */
export function fitWithin(
  width: number,
  height: number,
  maxWidth: number,
): { width: number; height: number } {
  if (width <= maxWidth) return { width, height };
  const scale = maxWidth / width;
  return { width: maxWidth, height: Math.max(1, Math.round(height * scale)) };
}

export const UNREADABLE_PHOTO =
  "That file could not be read as a photo. Choose a JPEG or PNG picture of the recipe.";

export function createPickRecipePhoto(deps: PhotoDeps): PickRecipePhoto {
  return async (source) => {
    // The file picker only opens from a tap, so nothing may be awaited before this call.
    const file = await deps.chooseFile(source === "camera");
    if (!file) return null;

    let size: { width: number; height: number };
    try {
      size = await deps.measure(file);
    } catch {
      throw new Error(UNREADABLE_PHOTO);
    }
    const target = fitWithin(size.width, size.height, MAX_WIDTH_PX);

    let jpeg: Blob;
    try {
      jpeg = await deps.encode(file, target.width, target.height, JPEG_QUALITY);
    } catch {
      throw new Error(UNREADABLE_PHOTO);
    }
    const result: PickedPhoto = { bytes: await jpeg.arrayBuffer(), contentType: "image/jpeg" };
    return result;
  };
}

// ---------------------------------------------------------------------------------------
// The browser's parts
// ---------------------------------------------------------------------------------------

/** How long after the window regains focus to wait for a `change` event before giving up. */
const FOCUS_GRACE_MS = 1000;

function chooseFile(capture: boolean): Promise<Blob | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    // On a phone's browser this opens the camera. A computer ignores it and shows its files.
    if (capture) input.setAttribute("capture", "environment");
    input.style.display = "none";

    let settled = false;
    const finish = (file: Blob | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", onFocus);
      input.remove();
      resolve(file);
    };
    // Browsers without the `cancel` event give no sign that the picker was closed, except that
    // the window gets focus back. Wait a moment for a late `change`, then take what is there.
    const onFocus = () => {
      setTimeout(() => finish(input.files?.[0] ?? null), FOCUS_GRACE_MS);
    };

    input.addEventListener("change", () => finish(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => finish(null));
    window.addEventListener("focus", onFocus, { once: true });
    document.body.append(input);
    input.click();
  });
}

async function measure(file: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

async function encode(file: Blob, width: number, height: number, quality: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d canvas");
    // A PNG with transparency would turn black as a JPEG, so paint white under it first.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("encode failed"))),
        "image/jpeg",
        quality,
      );
    });
  } finally {
    bitmap.close();
  }
}

export const pickRecipePhoto: PickRecipePhoto = createPickRecipePhoto({
  chooseFile,
  measure,
  encode,
});
