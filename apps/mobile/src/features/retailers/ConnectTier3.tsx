// Connect a Tier 3 store (WS08): Safeway, Albertsons, Haggen or Costco, which the agent shops by
// driving the store's own website in the app. Consent first when the household needs it
// (features/tier3/ConsentScreen), then the store's own sign-in page in the WebView. The Kroger
// connect (ConnectKroger) is the OAuth path beside it.
import { useSupabase } from "@mp/db";
import { useQueryClient } from "@tanstack/react-query";
import { Platform, Text } from "react-native";
import { tier3ConnectionsKey, tier3ConsentKey, useTier3Consent } from "../tier3/api";
import type { Tier3Store } from "../tier3/stores";
import { Tier3ConnectFlow } from "../tier3/Tier3ConnectFlow";
import { Tier3Login } from "../tier3/Tier3Login";

export function ConnectTier3({
  householdId,
  store,
  onConnected,
  onCancel,
}: {
  householdId: string;
  store: Tier3Store;
  onConnected?: (connectionId: string) => void;
  onCancel?: () => void;
}) {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const consent = useTier3Consent(client, householdId);

  if (Platform.OS === "web") {
    return (
      <Text className="text-sm text-neutral-600">
        Connect {store.name} from the iOS or Android app. It opens {store.name}'s site in the app.
      </Text>
    );
  }
  if (consent.isPending) return <Text className="text-sm text-neutral-500">Loading</Text>;

  return (
    <Tier3ConnectFlow
      store={store}
      householdId={householdId}
      consent={consent.data ?? null}
      client={client}
      onConsented={() =>
        void queryClient.invalidateQueries({ queryKey: tier3ConsentKey(householdId) })
      }
      {...(onCancel ? { onCancel } : {})}
      renderSignIn={() => (
        <Tier3Login
          store={store}
          householdId={householdId}
          client={client}
          {...(onCancel ? { onCancel } : {})}
          onConnected={(id) => {
            void queryClient.invalidateQueries({ queryKey: tier3ConnectionsKey(householdId) });
            onConnected?.(id);
          }}
        />
      )}
    />
  );
}
