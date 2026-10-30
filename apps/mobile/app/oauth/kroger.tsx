// souvie://oauth/kroger, the Kroger OAuth redirect (docs/01 §Deep links, WS07). On iOS the auth
// session catches the redirect itself; this screen covers Android and any case where the app was
// opened by the link instead. completeKrogerRedirect spends each code once, so the two paths
// never race.
import { useSupabase } from "@mp/db";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { Button } from "../../src/components/Button";
import { LoadingScreen, Screen } from "../../src/components/Screen";
import { SessionGuard } from "../../src/features/auth/SessionGuard";
import { retailerErrorMessage } from "../../src/features/retailers/api";
import { completeKrogerRedirect, redirectFromParams } from "../../src/features/retailers/oauth";

function FinishKrogerConnect() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const router = useRouter();
  const params = useLocalSearchParams<Record<string, string>>();
  const [error, setError] = useState<string | null>(null);
  const url = redirectFromParams(params);

  useEffect(() => {
    let active = true;
    completeKrogerRedirect(client, url)
      .then(async () => {
        await queryClient.invalidateQueries({ queryKey: ["retailer-connections"] });
        if (!active) return;
        if (router.canGoBack()) router.back();
        else router.replace("/");
      })
      .catch((cause) => {
        if (active) setError(retailerErrorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [client, queryClient, router, url]);

  if (!error) return <LoadingScreen label="Connecting your Kroger account" />;
  return (
    <Screen title="Kroger is not connected">
      <Text accessibilityRole="alert" className="text-base text-neutral-700">
        {error}
      </Text>
      <Button label="Back" onPress={() => router.replace("/")} />
    </Screen>
  );
}

export default function KrogerRedirectScreen() {
  return (
    <SessionGuard>
      <FinishKrogerConnect />
    </SessionGuard>
  );
}
