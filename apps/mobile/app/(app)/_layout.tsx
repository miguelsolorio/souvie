import { Stack } from "expo-router";
import { SessionGuard } from "../../src/features/auth/SessionGuard";
import { ShareIntentReceiver } from "../../src/features/recipes/ShareIntentReceiver";

/** Everything in (app) needs a signed-in user. The guard handles loading and signed-out. */
export default function AppLayout() {
  return (
    <SessionGuard>
      {/* WS02: posts and links shared in from other apps open the add-recipe screen. */}
      <ShareIntentReceiver />
      <Stack screenOptions={{ headerTitleAlign: "center", headerShadowVisible: false }}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        {/* WS04: the planner is the home screen. */}
        <Stack.Screen name="plan/index" options={{ title: "Plan" }} />
        <Stack.Screen name="plan/[date]" options={{ title: "Day" }} />
        <Stack.Screen name="plan/pick" options={{ title: "Add a recipe", presentation: "modal" }} />
        <Stack.Screen name="menu" options={{ title: "Menu" }} />
        <Stack.Screen name="household/create" options={{ title: "Create household" }} />
        <Stack.Screen name="household/settings" options={{ title: "Household" }} />
        <Stack.Screen name="profile" options={{ title: "Profile" }} />
      </Stack>
    </SessionGuard>
  );
}
