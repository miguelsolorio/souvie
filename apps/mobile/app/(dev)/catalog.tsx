// Dev-only catalog explorer (WS07): connect Kroger, pick a store, search with that store's live
// prices, add an item to your own Kroger cart, then open Kroger checkout to see it there.
// Reach it at souvie://catalog in a development build. Release builds redirect home.
//
// Kroger data here lives in component state only: no query cache, no persistence. Only Kroger
// prices are on this screen.
import { useHousehold, useSession, useSupabase } from "@mp/db";
import type { Product, Store } from "@mp/retailers";
import { useMutation } from "@tanstack/react-query";
import { Redirect } from "expo-router";
import { useState } from "react";
import { Linking, Text, View } from "react-native";
import { Button } from "../../src/components/Button";
import { ErrorText, LoadingScreen, Screen, Section } from "../../src/components/Screen";
import { TextField } from "../../src/components/TextField";
import { SessionGuard } from "../../src/features/auth/SessionGuard";
import {
  addToKrogerCart,
  retailerErrorMessage,
  searchKrogerProducts,
} from "../../src/features/retailers/api";
import { ConnectionCard } from "../../src/features/retailers/ConnectionCard";
import { ConnectKroger } from "../../src/features/retailers/ConnectKroger";
import { ProductRow } from "../../src/features/retailers/ProductRow";
import { StorePicker } from "../../src/features/retailers/StorePicker";
import { useRetailerConnection } from "../../src/features/retailers/useRetailerConnection";

const DEFAULT_CHECKOUT = "https://www.kroger.com/checkout";

function CatalogExplorer() {
  const client = useSupabase();
  const { user } = useSession();
  const household = useHousehold();
  const householdId = household.data?.id;
  const { connection, own, isPending } = useRetailerConnection(householdId, user?.id);
  const [chosen, setChosen] = useState<Store | null>(null);
  const [query, setQuery] = useState("milk");
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);

  const storeId = connection?.storeId ?? chosen?.id ?? null;
  const chain = chosen?.id === storeId ? chosen?.chain : null;

  const search = useMutation({
    mutationFn: (q: string) => {
      if (!householdId || !storeId) throw new Error("Pick a store first.");
      return searchKrogerProducts(client, { householdId, storeId, q });
    },
  });

  const add = useMutation({
    mutationFn: (product: Product) => {
      if (own?.status !== "active") throw new Error("Connect your own Kroger account first.");
      return addToKrogerCart(client, {
        connectionId: own.id,
        items: [{ productId: product.id, upc: product.upc, quantityDelta: 1 }],
      });
    },
    onMutate: (product) => setAddingId(product.id),
    onSettled: () => setAddingId(null),
    onSuccess: ({ result, checkoutUrl: url }) => {
      setCheckoutUrl(url);
      setNotice(
        result.rejected.length === 0
          ? "Added to your Kroger cart."
          : `Kroger did not take it: ${result.rejected[0]?.reason ?? "unknown reason"}`,
      );
    },
  });

  if (household.isPending || isPending) return <LoadingScreen />;
  if (!householdId) return <Redirect href="/household/create" />;

  return (
    <Screen title="Catalog explorer" subtitle="Development only. Kroger prices for one store.">
      <Section title="Kroger account">
        {connection ? (
          <ConnectionCard
            connection={connection}
            isHolder={connection.userId === user?.id}
            isOwner={household.data?.role === "owner"}
            zip={household.data?.zip}
          />
        ) : (
          <View className="gap-4">
            <StorePicker
              initialZip={household.data?.zip ?? "98019"}
              selectedId={chosen?.id}
              onSelect={setChosen}
            />
            <ConnectKroger householdId={householdId} store={chosen} />
          </View>
        )}
      </Section>

      <Section title="Search">
        <TextField
          label="Product"
          value={query}
          onChangeText={setQuery}
          returnKeyType="search"
          onSubmitEditing={() => search.mutate(query)}
          testID="catalog-query"
        />
        <Button
          label="Search"
          loading={search.isPending}
          disabled={!storeId || query.trim().length < 3}
          onPress={() => search.mutate(query)}
          testID="catalog-search"
        />
        {!storeId ? (
          <Text className="text-sm text-neutral-600">Pick a store to see prices.</Text>
        ) : null}
        <ErrorText>{search.isError ? retailerErrorMessage(search.error) : null}</ErrorText>
        <View className="gap-3">
          {(search.data ?? []).map((product) => (
            <ProductRow
              key={product.id}
              product={product}
              chain={chain}
              adding={addingId === product.id}
              disabled={own?.status !== "active" || addingId !== null}
              onAdd={() => add.mutate(product)}
            />
          ))}
        </View>
      </Section>

      <Section title="Checkout">
        {notice ? <Text className="text-sm text-neutral-700">{notice}</Text> : null}
        <ErrorText>{add.isError ? retailerErrorMessage(add.error) : null}</ErrorText>
        <Button
          label="Open Kroger checkout"
          variant="secondary"
          onPress={() => void Linking.openURL(checkoutUrl ?? DEFAULT_CHECKOUT)}
          testID="open-checkout"
        />
        <Text className="text-xs text-neutral-500">
          Opens in Safari or Chrome, where you review the cart and pay on Kroger's site.
        </Text>
      </Section>
    </Screen>
  );
}

export default function CatalogScreen() {
  if (!__DEV__) return <Redirect href="/" />;
  return (
    <SessionGuard>
      <CatalogExplorer />
    </SessionGuard>
  );
}
