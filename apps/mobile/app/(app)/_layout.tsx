import { Stack } from "expo-router";
import { SessionGuard } from "../../src/features/auth/SessionGuard";
import { OnboardingGate } from "../../src/features/onboarding/OnboardingGate";
import { ShareIntentReceiver } from "../../src/features/recipes/ShareIntentReceiver";

/** Everything in (app) needs a signed-in user. The guard handles loading and signed-out. */
export default function AppLayout() {
  return (
    <SessionGuard>
      {/* WS06: a person who has not finished onboarding resumes it before anything else. */}
      <OnboardingGate>
        {/* WS02: posts and links shared in from other apps open the add-recipe screen. */}
        <ShareIntentReceiver />
        <Stack screenOptions={{ headerTitleAlign: "center", headerShadowVisible: false }}>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="household/create" options={{ title: "Create household" }} />
          <Stack.Screen name="household/settings" options={{ title: "Household" }} />
          <Stack.Screen name="profile" options={{ title: "Profile" }} />
        </Stack>
      </OnboardingGate>
    </SessionGuard>
  );
}
