import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";

/** Phones shoot 12 MP or more. A recipe card reads fine at this width and uploads in a moment. */
const MAX_WIDTH_PX = 1600;

export interface PickedPhoto {
  bytes: ArrayBuffer;
  contentType: "image/jpeg";
}

/**
 * Takes a photo with the camera or chooses one from the library, shrinks it to at most 1600 px
 * wide, and returns JPEG bytes ready for `uploadRecipeImage`. Returns null if the person
 * cancelled. Throws an Error with a message fit to show when the camera permission is refused.
 */
export async function pickRecipePhoto(source: "camera" | "library"): Promise<PickedPhoto | null> {
  if (source === "camera") {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      throw new Error("Allow camera access in Settings to photograph a recipe, or choose a photo.");
    }
  }

  const picked =
    source === "camera"
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
  const asset = picked.canceled ? undefined : picked.assets[0];
  if (!asset) return null;

  let context = ImageManipulator.manipulate(asset.uri);
  if (asset.width > MAX_WIDTH_PX) context = context.resize({ width: MAX_WIDTH_PX });
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.8 });

  const response = await fetch(saved.uri);
  return { bytes: await response.arrayBuffer(), contentType: "image/jpeg" };
}
