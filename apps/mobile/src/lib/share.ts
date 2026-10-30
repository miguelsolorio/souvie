import * as Clipboard from "expo-clipboard";
import { Platform, Share } from "react-native";

export async function copyText(text: string): Promise<void> {
  await Clipboard.setStringAsync(text);
}

/**
 * Opens the system share sheet for a link. Web uses the Web Share API when the browser has it.
 * Returns false when nothing was shared (cancelled, or no share sheet), so the caller can fall
 * back to the copy button.
 */
export async function shareLink(url: string, message: string): Promise<boolean> {
  if (Platform.OS === "web") {
    const nav = (
      globalThis as {
        navigator?: { share?: (data: { url: string; text: string }) => Promise<void> };
      }
    ).navigator;
    if (!nav?.share) return false;
    try {
      await nav.share({ url, text: message });
      return true;
    } catch {
      return false;
    }
  }
  const result = await Share.share({ message: `${message} ${url}`, url });
  return result.action === Share.sharedAction;
}
