import { useSupabase } from "@mp/db";
import * as AppleAuthentication from "expo-apple-authentication";
import { useEffect, useState } from "react";
import { Platform, View } from "react-native";
import { Button } from "../../components/Button";
import { describeAuthError } from "./authMessages";
import { type SignInOutcome, signInWithApple, signInWithGoogle } from "./signIn";

type Provider = "apple" | "google";

/**
 * "Continue with Apple" and "Continue with Google". On iOS the Apple button is the system's own
 * and opens the native sheet; elsewhere both are plain buttons that start the OAuth redirect.
 * A successful sign-in updates the session, and the auth layout moves the person on.
 */
export function ProviderButtons({ onError }: { onError: (message: string | null) => void }) {
  const client = useSupabase();
  const [busy, setBusy] = useState<Provider | null>(null);
  const [nativeApple, setNativeApple] = useState(false);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    let active = true;
    AppleAuthentication.isAvailableAsync()
      .then((available) => {
        if (active) setNativeApple(available);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  async function run(
    provider: Provider,
    flow: (client: ReturnType<typeof useSupabase>) => Promise<SignInOutcome>,
  ) {
    onError(null);
    setBusy(provider);
    try {
      await flow(client);
    } catch (error) {
      onError(describeAuthError(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <View className="gap-3">
      {nativeApple ? (
        <AppleAuthentication.AppleAuthenticationButton
          buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
          buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
          cornerRadius={12}
          style={{ height: 48, width: "100%", opacity: busy ? 0.5 : 1 }}
          onPress={() => {
            if (!busy) void run("apple", signInWithApple);
          }}
        />
      ) : (
        <Button
          testID="sign-in-apple"
          label="Continue with Apple"
          loading={busy === "apple"}
          disabled={busy !== null}
          onPress={() => void run("apple", signInWithApple)}
        />
      )}
      <Button
        testID="sign-in-google"
        label="Continue with Google"
        variant="secondary"
        loading={busy === "google"}
        disabled={busy !== null}
        onPress={() => void run("google", signInWithGoogle)}
      />
    </View>
  );
}
