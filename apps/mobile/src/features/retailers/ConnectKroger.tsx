import { type Banner, bannerForChain, type Modality, type Store } from "@mp/retailers";
import { Platform, Text, View } from "react-native";
import { Button } from "../../components/Button";
import { ErrorText } from "../../components/Screen";
import { retailerErrorMessage } from "./api";
import { useConnectKroger } from "./useRetailerConnection";

const BANNER_LABEL: Record<Banner, string> = { qfc: "QFC", fredmeyer: "Fred Meyer" };

/**
 * Connect Kroger. Opens Kroger's own sign-in page in the system browser, branded for the
 * household's store (QFC or Fred Meyer). The person signs in there; we never see the password.
 */
export function ConnectKroger({
  householdId,
  store,
  modality = "PICKUP",
  label,
  onConnected,
}: {
  householdId: string | undefined;
  /**
   * The household's store. Its chain picks the banner. A reconnect knows only the id and name;
   * the function then looks the chain up from the id.
   */
  store?: (Pick<Store, "id" | "name"> & Partial<Pick<Store, "chain">>) | null | undefined;
  modality?: Modality;
  label?: string;
  onConnected?: () => void;
}) {
  const connect = useConnectKroger(householdId);
  const banner = bannerForChain(store?.chain);
  const name = banner ? BANNER_LABEL[banner] : "Kroger";

  if (Platform.OS === "web") {
    return (
      <Text className="text-sm text-neutral-600">
        Connect your {name} account from the iOS or Android app.
      </Text>
    );
  }

  return (
    <View className="gap-2">
      <Button
        testID="connect-kroger"
        label={label ?? `Connect ${name}`}
        loading={connect.isPending}
        disabled={!householdId}
        onPress={() =>
          connect.mutate(
            { banner, store: store ? { id: store.id, name: store.name } : null, modality },
            {
              onSuccess: (outcome) => {
                if (outcome === "connected") onConnected?.();
              },
            },
          )
        }
      />
      <Text className="text-sm text-neutral-600">
        You sign in on Kroger's page. We keep a key that lets us add items to your cart; you still
        review and pay in the {name} app or on the website.
      </Text>
      {connect.data === "cancelled" ? (
        <Text className="text-sm text-neutral-600">Sign-in was cancelled.</Text>
      ) : null}
      <ErrorText>{connect.isError ? retailerErrorMessage(connect.error) : null}</ErrorText>
    </View>
  );
}
