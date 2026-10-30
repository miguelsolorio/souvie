import { BANNER_CHAIN_NAMES, type Store } from "@mp/retailers";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { ErrorText } from "../../components/Screen";
import { TextField } from "../../components/TextField";
import { retailerErrorMessage } from "./api";
import { useKrogerStores } from "./useRetailerConnection";

/**
 * QFC and Fred Meyer stores near a ZIP, from Kroger Locations. Names and addresses are shown as
 * Kroger returned them. Picking a store sets the price list every later search uses.
 */
export function StorePicker({
  initialZip,
  selectedId,
  onSelect,
}: {
  initialZip?: string | null | undefined;
  selectedId?: string | null | undefined;
  onSelect: (store: Store) => void;
}) {
  const [zip, setZip] = useState(initialZip ?? "");
  const stores = useKrogerStores(zip.trim());

  return (
    <View className="gap-3">
      <TextField
        label="ZIP code"
        value={zip}
        onChangeText={(value) => setZip(value.replace(/\D/g, "").slice(0, 5))}
        keyboardType="number-pad"
        maxLength={5}
        placeholder="98019"
        testID="store-zip"
      />
      {stores.isFetching ? <ActivityIndicator color="#2F6B4F" /> : null}
      <ErrorText>{stores.isError ? retailerErrorMessage(stores.error) : null}</ErrorText>
      {stores.data && stores.data.length === 0 ? (
        <Text className="text-sm text-neutral-600">No QFC or Fred Meyer stores near that ZIP.</Text>
      ) : null}
      <View accessibilityRole="radiogroup" className="gap-2">
        {(stores.data ?? []).map((store) => {
          const selected = store.id === selectedId;
          return (
            <Pressable
              key={store.id}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={`${store.name}, ${store.address}`}
              onPress={() => onSelect(store)}
              testID={`store-${store.id}`}
              className={`gap-0.5 rounded-xl border p-3 ${selected ? "border-brand bg-brand/5" : "border-neutral-200"}`}
            >
              <Text className="text-xs font-semibold text-neutral-500">
                {BANNER_CHAIN_NAMES[store.chain] ?? store.chain}
              </Text>
              <Text className="text-base text-neutral-900">{store.name}</Text>
              <Text className="text-sm text-neutral-600">{store.address}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
