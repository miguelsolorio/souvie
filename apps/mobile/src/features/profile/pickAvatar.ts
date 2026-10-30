import { type MpClient, uploadAvatar } from "@mp/db";
import * as Crypto from "expo-crypto";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";

const AVATAR_SIZE_PX = 512;

/**
 * Lets the person pick a photo, crops it square, shrinks it to 512 px, and uploads it to
 * `avatars/<user_id>/<uuid>.jpg`. The bucket policy rejects any other path. Returns the stored
 * path, or null if the person cancelled.
 */
export async function chooseAndUploadAvatar(
  client: MpClient,
  args: { userId: string; previousPath: string | null },
): Promise<string | null> {
  const picked = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1,
  });
  const asset = picked.canceled ? undefined : picked.assets[0];
  if (!asset) return null;

  const context = ImageManipulator.manipulate(asset.uri).resize({ width: AVATAR_SIZE_PX });
  const rendered = await context.renderAsync();
  const result = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.8 });

  const response = await fetch(result.uri);
  const bytes = await response.arrayBuffer();

  return uploadAvatar(client, {
    userId: args.userId,
    fileId: Crypto.randomUUID(),
    bytes,
    contentType: "image/jpeg",
    previousPath: args.previousPath,
  });
}
