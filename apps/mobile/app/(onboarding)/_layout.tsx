import { Redirect, Stack, useGlobalSearchParams, useSegments } from "expo-router";
import type { ReactNode } from "react";
import { LoadingScreen } from "../../src/components/Screen";
import { SessionGuard } from "../../src/features/auth/SessionGuard";
import { guardOnboardingRoute, isEditParam } from "../../src/features/onboarding/onboardingState";
import { useOnboardingProfile } from "../../src/features/onboarding/useOnboarding";

/**
 * Keeps people on the right screen: nobody opens a screen past the one after their last finished
 * screen (a typed URL cannot skip the allergy question), and once onboarding is done the group
 * sends them home, except that settings can reopen the food preference screens (`?edit=1`). A
 * profile that cannot be read lets the screens render; they report their own errors.
 */
function RouteGuard({ children }: { children: ReactNode }) {
  const segments = useSegments();
  const { edit } = useGlobalSearchParams<{ edit?: string }>();
  const profile = useOnboardingProfile();
  const screen = segments[segments.length - 1];

  if (profile.isPending) return <LoadingScreen />;
  if (profile.data) {
    const to = guardOnboardingRoute(screen, profile.data.onboardingStep, "/", isEditParam(edit));
    if (to) return <Redirect href={to} />;
  }
  return <>{children}</>;
}

/** The eight onboarding screens (WS06). Needs a signed-in user. */
export default function OnboardingLayout() {
  return (
    <SessionGuard>
      <RouteGuard>
        <Stack screenOptions={{ headerShown: false, animation: "none" }} />
      </RouteGuard>
    </SessionGuard>
  );
}
