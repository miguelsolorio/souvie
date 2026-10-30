import { identityErrorMessage, redeemInvite, useSession, useSupabase } from "@mp/db";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { Button } from "../../src/components/Button";
import { ErrorText, LoadingScreen, Screen } from "../../src/components/Screen";
import { isValidInviteToken } from "../../src/features/auth/links";
import { clearPendingInvite, setPendingInvite } from "../../src/features/auth/pendingInvite";
import { HOME_ROUTE, SIGN_IN_ROUTE } from "../../src/features/auth/routes";

/**
 * mealplanner://join/<token> on native and /join/<token> on web.
 *
 * Signed out: remember the token, send the person to sign in, and come back here afterwards
 * (the (app) layout resumes the join). Signed in: ask before joining, then redeem the invite.
 */
export default function JoinScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const client = useSupabase();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { status } = useSession();
  const [stored, setStored] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validToken = isValidInviteToken(token) ? token : null;

  useEffect(() => {
    if (!validToken || status !== "signed-out") return;
    let active = true;
    setPendingInvite(validToken).finally(() => {
      if (active) setStored(true);
    });
    return () => {
      active = false;
    };
  }, [validToken, status]);

  const join = useMutation({
    mutationFn: (inviteToken: string) => redeemInvite(client, inviteToken),
    onSuccess: async () => {
      await clearPendingInvite();
      // The joined household is now the newest membership, so it becomes the active one.
      await queryClient.invalidateQueries({ queryKey: ["household"] });
      await queryClient.invalidateQueries({ queryKey: ["household-members"] });
      router.replace(HOME_ROUTE);
    },
    onError: async (cause) => {
      // A bad link will not get better on retry. Drop it so the person is not sent back here.
      await clearPendingInvite();
      setError(identityErrorMessage(cause));
    },
  });

  if (!validToken) {
    return (
      <Screen title="Invite link not valid">
        <Text className="text-base text-neutral-700">
          This link is missing part of its code. Ask for a new invite.
        </Text>
        <Button label="Continue" onPress={() => router.replace(HOME_ROUTE)} />
      </Screen>
    );
  }

  if (status === "loading") return <LoadingScreen />;

  if (status === "signed-out") {
    return stored ? <Redirect href={SIGN_IN_ROUTE} /> : <LoadingScreen />;
  }

  return (
    <Screen
      title="Join a household?"
      subtitle="You were invited to share plans and grocery lists with a household."
    >
      <Button
        testID="join-household"
        label="Join household"
        loading={join.isPending}
        onPress={() => {
          setError(null);
          join.mutate(validToken);
        }}
      />
      <Button
        label="Not now"
        variant="ghost"
        disabled={join.isPending}
        onPress={async () => {
          await clearPendingInvite();
          router.replace(HOME_ROUTE);
        }}
      />
      <ErrorText>{error}</ErrorText>
    </Screen>
  );
}
