import { useState } from "react";
import { Text, View } from "react-native";
import { ErrorText, Screen } from "../../src/components/Screen";
import { EmailSignIn } from "../../src/features/auth/EmailSignIn";
import { ProviderButtons } from "../../src/features/auth/ProviderButtons";
import { usePendingInvite } from "../../src/features/auth/usePendingInvite";

export default function SignInScreen() {
  const [error, setError] = useState<string | null>(null);
  const pendingInvite = usePendingInvite();

  return (
    <Screen
      title="Souvie"
      subtitle={
        pendingInvite.token
          ? "Sign in to join the household you were invited to."
          : "Plan the week, build one grocery list, and shop in one place."
      }
    >
      <ProviderButtons onError={setError} />

      <View className="flex-row items-center gap-3">
        <View className="h-px flex-1 bg-neutral-200" />
        <Text className="text-sm text-neutral-500">or</Text>
        <View className="h-px flex-1 bg-neutral-200" />
      </View>

      <EmailSignIn onError={setError} />
      <ErrorText>{error}</ErrorText>

      <Text className="text-center text-xs text-neutral-500">
        New here? Signing in creates your account.
      </Text>
    </Screen>
  );
}
