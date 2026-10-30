import { Stack } from "expo-router";
import { SignedOutOnly } from "../../src/features/auth/SessionGuard";

export default function AuthLayout() {
  return (
    <SignedOutOnly>
      <Stack screenOptions={{ headerShown: false }} />
    </SignedOutOnly>
  );
}
