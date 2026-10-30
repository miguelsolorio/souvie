import { useSession } from "@mp/db";
import { Redirect } from "expo-router";
import type { ReactNode } from "react";
import { LoadingScreen } from "../../components/Screen";
import { HOME_ROUTE, joinRoute, SIGN_IN_ROUTE } from "./routes";
import { usePendingInvite } from "./usePendingInvite";

/**
 * Wraps the signed-in part of the app. While the stored session loads it shows a spinner, so a
 * signed-in person never sees a flash of the sign-in screen. Signed-out visitors go to sign-in.
 * Someone who arrived through an invite link and has just signed in is sent back to that link.
 */
export function SessionGuard({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const pending = usePendingInvite();

  if (status === "loading" || pending.loading) return <LoadingScreen />;
  if (status === "signed-out") return <Redirect href={SIGN_IN_ROUTE} />;
  if (pending.token) return <Redirect href={joinRoute(pending.token)} />;
  return <>{children}</>;
}

/** Wraps the sign-in screens. A signed-in person has no business there, so send them home. */
export function SignedOutOnly({ children }: { children: ReactNode }) {
  const { status } = useSession();

  if (status === "loading") return <LoadingScreen />;
  if (status === "signed-in") return <Redirect href={HOME_ROUTE} />;
  return <>{children}</>;
}
