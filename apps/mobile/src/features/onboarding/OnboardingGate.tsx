import { Redirect } from "expo-router";
import type { ReactNode } from "react";
import { LoadingScreen } from "../../components/Screen";
import { resumeHref } from "./onboardingState";
import { useOnboardingProfile } from "./useOnboarding";

/**
 * Wraps the signed-in app. Until onboarding is complete it sends the person to the screen after
 * the last one they finished, which is how a quit on screen 5 resumes on screen 5. If the
 * profile cannot be read it lets the app through: a network problem must not lock anyone out of
 * their own household.
 */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const profile = useOnboardingProfile();

  if (profile.isPending) return <LoadingScreen />;
  if (profile.isError || !profile.data) return <>{children}</>;

  const href = resumeHref(profile.data.onboardingStep);
  if (href) return <Redirect href={href} />;
  return <>{children}</>;
}
