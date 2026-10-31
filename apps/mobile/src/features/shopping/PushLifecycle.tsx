// Push notifications for shopping runs (WS09; WS11 adds the other types and the preferences).
//
// After sign-in on a phone it asks for permission once, registers this device's Expo push token in
// push_tokens (the signed-in user's own row, under RLS), and opens the run a notification names
// when the person taps it. On the web it does nothing. Without an EAS project id (a fresh clone,
// Expo Go without one) there is no token to register, and the app works the same without pushes.
import { useSession, useSupabase } from "@mp/db";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";
import { routeForPush } from "./routes";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;
}

export function PushLifecycle() {
  const client = useSupabase();
  const router = useRouter();
  const { status, user } = useSession();
  const userId = user?.id;

  useEffect(() => {
    if (Platform.OS === "web" || status !== "signed-in" || !userId) return;
    let cancelled = false;
    void (async () => {
      try {
        const current = await Notifications.getPermissionsAsync();
        const granted = current.granted || (await Notifications.requestPermissionsAsync()).granted;
        const id = projectId();
        if (!granted || !id || cancelled) return;
        const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: id });
        if (cancelled) return;
        await client
          .from("push_tokens")
          .upsert(
            { token, platform: Platform.OS === "ios" ? "ios" : "android" },
            { onConflict: "user_id,token", ignoreDuplicates: true },
          );
      } catch (error) {
        if (__DEV__) console.warn("push registration skipped", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, status, userId]);

  useEffect(() => {
    if (Platform.OS === "web") return;
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const route = routeForPush(response.notification.request.content.data);
      if (route) router.push(route);
    });
    return () => subscription.remove();
  }, [router]);

  return null;
}
