import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { JPEG_QUALITY, MAX_WIDTH_PX, type PickRecipePhoto } from "./pickRecipePhoto.types";

export type { PickedPhoto } from "./pickRecipePhoto.types";

/**
 * The phone version (iOS and Android): the system camera or photo library through expo-image-picker.
 * The web version is pickRecipePhoto.ts. See pickRecipePhoto.types.ts for the contract.
 */
export const pickRecipePhoto: PickRecipePhoto = async (source) => {
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
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_QUALITY });

  const response = await fetch(saved.uri);
  return { bytes: await response.arrayBuffer(), contentType: "image/jpeg" };
};
