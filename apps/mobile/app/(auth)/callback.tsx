import { useSupabase } from "@mp/db";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Platform, Text } from "react-native";
import { Button } from "../../src/components/Button";
import { LoadingScreen, Screen } from "../../src/components/Screen";
import { describeAuthError } from "../../src/features/auth/authMessages";
import { SIGN_IN_ROUTE } from "../../src/features/auth/routes";
import { completeFromUrl } from "../../src/features/auth/signIn";

// A sign-in code can be exchanged once. React runs effects twice in development, so remember
// which redirects this page load has already handled.
const handled = new Set<string>();

/**
 * Where magic links and OAuth redirects land: souvie://callback on native, /callback on web.
 * Exchanges the one-time code for a session. On success the session changes and the (auth)
 * layout sends the person home, so this screen only has to show failures.
 */
export default function CallbackScreen() {
  const client = useSupabase();
  const router = useRouter();
  const params = useLocalSearchParams<{
    code?: string;
    error?: string;
    error_code?: string;
    error_description?: string;
  }>();
  const [error, setError] = useState<string | null>(null);

  const { code, error: errorParam, error_code, error_description } = params;
  useEffect(() => {
    // Expired links report their error in the #fragment on web, which route params omit.
    const fragment =
      Platform.OS === "web"
        ? ((globalThis as { location?: { hash?: string } }).location?.hash ?? "")
        : "";
    const query = Object.entries({ code, error: errorParam, error_code, error_description })
      .filter(([, value]) => typeof value === "string" && value.length > 0)
      .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
      .join("&");
    const url = `souvie://callback?${query}${fragment}`;

    if (handled.has(url)) return;
    handled.add(url);
    completeFromUrl(client, url).catch((cause) => setError(describeAuthError(cause)));
  }, [client, code, errorParam, error_code, error_description]);

  if (!error) return <LoadingScreen label="Signing you in" />;

  return (
    <Screen title="Could not sign you in">
      <Text accessibilityRole="alert" className="text-base text-neutral-700">
        {error}
      </Text>
      <Button label="Back to sign in" onPress={() => router.replace(SIGN_IN_ROUTE)} />
    </Screen>
  );
}
