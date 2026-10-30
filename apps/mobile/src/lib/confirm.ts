import { Alert, Platform } from "react-native";

/**
 * Asks the person to confirm an action. React Native's Alert.alert does nothing on web, so the
 * browser's confirm dialog stands in there. Resolves true only on an explicit yes.
 */
export function confirmAction(options: {
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
}): Promise<boolean> {
  const { title, message, confirmLabel, destructive = false } = options;

  if (Platform.OS === "web") {
    const ask = (globalThis as { confirm?: (text: string) => boolean }).confirm;
    return Promise.resolve(ask ? ask(`${title}\n\n${message}`) : false);
  }

  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        {
          text: confirmLabel,
          style: destructive ? "destructive" : "default",
          onPress: () => resolve(true),
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
