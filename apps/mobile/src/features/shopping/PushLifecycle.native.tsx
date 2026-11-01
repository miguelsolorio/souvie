// Push notifications on a phone (WS09; WS11 adds the other types, the preferences and the cleanup).
//
// After sign-in it asks for permission once, registers this device's Expo push token with
// register_push_token (the device belongs to whoever signed in on it last; every launch refreshes
// the row and never makes a second one), and opens what a notification names when the person taps
// it (routes.ts). Signing out deletes the row (useSignOut), and a session that ends without a
// sign-out (revoked from another device) forgets the token by value here, so the phone stops
// receiving the household's pushes. The web build uses PushLifecycle.tsx, which does nothing.
// Without an EAS project id (a fresh clone, Expo Go without one) there is no token to register,
// and the app works the same without pushes.
import { forgetPushTokenBySecret, registerPushToken, useSession, useSupabase } from "@mp/db";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { forgetPushToken, registerDevice, trackRegistration } from "./pushToken";
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

/** Permission, then this device's Expo token. Null when the person said no or there is no project. */
async function getExpoToken(): Promise<string | null> {
  const current = await Notifications.getPermissionsAsync();
  const granted = current.granted || (await Notifications.requestPermissionsAsync()).granted;
  const id = projectId();
  if (!granted || !id) return null;
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId: id });
  return data;
}

export function PushLifecycle() {
  const client = useSupabase();
  const router = useRouter();
  const { status, user } = useSession();
  const userId = user?.id;
  const previous = useRef(status);

  useEffect(() => {
    if (Platform.OS === "web" || status !== "signed-in" || !userId) return;
    let cancelled = false;
    void trackRegistration(
      registerDevice({
        getToken: getExpoToken,
        register: (token) =>
          registerPushToken(client, token, Platform.OS === "ios" ? "ios" : "android"),
        forgetBySecret: (token) => forgetPushTokenBySecret(client, token),
        isCancelled: () => cancelled,
      }).catch((error) => {
        if (__DEV__) console.warn("push registration skipped", error);
        return null;
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [client, status, userId]);

  // The session went from signed in to signed out. useSignOut has already forgotten the token when
  // the person pressed Sign out; if one is still remembered, the session ended some other way and
  // the token is forgotten by value, which needs no session.
  useEffect(() => {
    const was = previous.current;
    previous.current = status;
    if (Platform.OS === "web" || was !== "signed-in" || status !== "signed-out") return;
    void forgetPushToken((token) => forgetPushTokenBySecret(client, token));
  }, [client, status]);

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
