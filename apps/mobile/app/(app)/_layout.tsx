import { Stack } from "expo-router";
import { SessionGuard } from "../../src/features/auth/SessionGuard";

/** Everything in (app) needs a signed-in user. The guard handles loading and signed-out. */
export default function AppLayout() {
  return (
    <SessionGuard>
      <Stack screenOptions={{ headerTitleAlign: "center", headerShadowVisible: false }}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="household/create" options={{ title: "Create household" }} />
        <Stack.Screen name="household/settings" options={{ title: "Household" }} />
        <Stack.Screen name="profile" options={{ title: "Profile" }} />
      </Stack>
    </SessionGuard>
  );
}
