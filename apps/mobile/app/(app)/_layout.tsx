import { Stack } from "expo-router";
import { SessionGuard } from "../../src/features/auth/SessionGuard";
import { ListSyncLifecycle } from "../../src/features/list/ListSyncLifecycle";
import { OnboardingGate } from "../../src/features/onboarding/OnboardingGate";
import { ShareIntentReceiver } from "../../src/features/recipes/ShareIntentReceiver";
import { PushLifecycle } from "../../src/features/shopping/PushLifecycle";

/** Everything in (app) needs a signed-in user. The guard handles loading and signed-out. */
export default function AppLayout() {
  return (
    <SessionGuard>
      {/* WS06: a person who has not finished onboarding resumes it before anything else. */}
      <OnboardingGate>
        {/* WS02: posts and links shared in from other apps open the add-recipe screen. */}
        <ShareIntentReceiver />
        {/* WS05: grocery list writes saved on this device are sent whichever screen is open. */}
        <ListSyncLifecycle />
        {/* WS09: this device's push token, and a tapped run notification opens the run. */}
        <PushLifecycle />
        <Stack screenOptions={{ headerTitleAlign: "center", headerShadowVisible: false }}>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          {/* WS04: the planner is the home screen. */}
          <Stack.Screen name="plan/index" options={{ title: "Plan" }} />
          <Stack.Screen name="plan/[date]" options={{ title: "Day" }} />
          <Stack.Screen
            name="plan/pick"
            options={{ title: "Add a recipe", presentation: "modal" }}
          />
          {/* WS05: the grocery list, in-store mode, and the pantry. */}
          <Stack.Screen name="list/index" options={{ title: "Groceries" }} />
          <Stack.Screen name="list/[id]" options={{ title: "Groceries" }} />
          <Stack.Screen name="list/store-mode" options={{ title: "Store mode" }} />
          <Stack.Screen name="pantry/index" options={{ title: "Pantry" }} />
          {/* WS09: shopping runs. */}
          <Stack.Screen name="shopping/index" options={{ title: "Shopping runs" }} />
          <Stack.Screen name="shopping/[id]" options={{ title: "Shopping run" }} />
          <Stack.Screen name="menu" options={{ title: "Menu" }} />
          <Stack.Screen name="household/create" options={{ title: "Create household" }} />
          <Stack.Screen name="household/settings" options={{ title: "Household" }} />
          <Stack.Screen name="profile" options={{ title: "Profile" }} />
        </Stack>
      </OnboardingGate>
    </SessionGuard>
  );
}
