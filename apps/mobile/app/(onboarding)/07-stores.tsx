import { StoresInput, storesToPreferences } from "@mp/core";
import { useSession, useSupabase } from "@mp/db";
import type { Store } from "@mp/retailers";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { TextField } from "../../src/components/TextField";
import {
  Note,
  OnboardingFrame,
  OptionRow,
  SectionLabel,
} from "../../src/features/onboarding/components";
import {
  milesLabel,
  nearbyStores,
  OTHER_STORE_ID,
  storeById,
} from "../../src/features/onboarding/stores";
import { WA_STORES } from "../../src/features/onboarding/storesWa.generated";
import { useOnboarding } from "../../src/features/onboarding/useOnboarding";
import { useStepNav } from "../../src/features/onboarding/useStepNav";
import { ConnectionCard } from "../../src/features/retailers/ConnectionCard";
import { ConnectKroger } from "../../src/features/retailers/ConnectKroger";
import { StorePicker } from "../../src/features/retailers/StorePicker";
import {
  useKrogerStores,
  useRetailerConnection,
} from "../../src/features/retailers/useRetailerConnection";

interface Selected {
  id: string;
  label: string;
  /** Set only for a live Kroger store, the one kind the Connect button can act on. */
  kroger?: { chain: string; name: string };
}

function StoreRow({
  label,
  detail,
  selected,
  onPress,
  testID,
}: {
  label: string;
  detail: string;
  selected: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      aria-checked={selected}
      accessibilityLabel={`${label}, ${detail}`}
      onPress={onPress}
      className={`gap-0.5 rounded-xl border p-3 ${selected ? "border-brand bg-brand/5" : "border-neutral-200"}`}
    >
      <Text className="text-base text-neutral-900">{label}</Text>
      <Text className="text-sm text-neutral-600">{detail}</Text>
    </Pressable>
  );
}

/**
 * Screen 7: ZIP, primary store, Costco membership, and (optionally) Connect Kroger.
 *
 * QFC and Fred Meyer stores come live from Kroger through the retailer-oauth function (WS07), in
 * Kroger's own words. Safeway, Albertsons, Haggen, and Costco come from the bundled Washington
 * list. If the live lookup is unavailable, the list's QFC and Fred Meyer rows fill in, but Connect
 * Kroger needs a live store (it needs Kroger's location id), so it waits for one.
 */
export default function StoresStep() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const { user } = useSession();
  const { saved, profile, saveStep, saving, household, householdId, isOwner } = useOnboarding();
  const { goNext, goBack } = useStepNav(7);
  const connection = useRetailerConnection(householdId, user?.id);
  const [error, setError] = useState<string | null>(null);

  const [zipEdit, setZipEdit] = useState<string | null>(null);
  const [pick, setPick] = useState<Selected | null>(null);
  const [costcoEdit, setCostcoEdit] = useState<boolean | null | undefined>(undefined);

  const zip = zipEdit ?? household.data?.zip ?? "";
  const validZip = /^\d{5}$/.test(zip);
  const costco = costcoEdit === undefined ? (profile.data?.costcoMember ?? null) : costcoEdit;

  const savedId = saved?.primary_store_id;
  const savedStore = storeById(savedId, WA_STORES);
  const selected: Selected | null =
    pick ??
    (savedStore
      ? { id: savedStore.id, label: savedStore.name }
      : savedId === OTHER_STORE_ID
        ? { id: OTHER_STORE_ID, label: "My store is not listed" }
        : savedId
          ? { id: savedId, label: "Your saved store" }
          : null);

  // Shares its query with the StorePicker below, so there is one request per ZIP.
  const kroger = useKrogerStores(validZip ? zip : "");
  const krogerUnavailable = validZip && kroger.isError;

  const { center, stores } = nearbyStores(validZip ? zip : "", WA_STORES, {
    banners: krogerUnavailable
      ? undefined
      : (["safeway", "albertsons", "haggen", "costco"] as const),
    limit: 10,
  });

  const canContinue = validZip && selected !== null && costco !== null;

  function chooseKroger(store: Store) {
    setPick({ id: store.id, label: store.name, kroger: { chain: store.chain, name: store.name } });
  }

  async function submit() {
    setError(null);
    const parsed = StoresInput.safeParse({
      zip,
      primary_store_id: selected?.id,
      costco_member: costco,
    });
    if (!parsed.success) {
      setError("Enter a 5 digit ZIP, choose a store, and answer the Costco question.");
      return;
    }
    try {
      // Only the owner may change the household's ZIP. A member still uses the ZIP they typed to
      // find stores; it just is not saved for the household.
      if (isOwner && householdId && household.data?.zip !== parsed.data.zip) {
        const { error: zipError } = await client
          .from("households")
          .update({ zip: parsed.data.zip })
          .eq("id", householdId);
        if (zipError) throw new Error(zipError.message);
        await queryClient.invalidateQueries({ queryKey: ["household"] });
      }
      await saveStep({
        step: 7,
        patch: storesToPreferences(parsed.data),
        costcoMember: parsed.data.costco_member,
      });
      goNext();
    } catch {
      setError("We could not save that. Try again.");
    }
  }

  const ownConnection = connection.own;

  return (
    <OnboardingFrame
      step={7}
      title="Where do you shop?"
      subtitle="Pick the store you shop at most. We use it for prices and, if you like, to fill your cart."
      onBack={goBack}
      onContinue={() => void submit()}
      canContinue={canContinue}
      busy={saving}
      error={error}
    >
      <TextField
        label="ZIP code"
        value={zip}
        onChangeText={(value) => setZipEdit(value.replace(/\D/g, "").slice(0, 5))}
        keyboardType="number-pad"
        maxLength={5}
        placeholder="98019"
        helper={
          !isOwner && !household.data?.zip
            ? "Only the household owner can save a ZIP for the household. We will use this one to find stores."
            : undefined
        }
        testID="zip"
      />

      {validZip ? (
        <>
          <View className="gap-3">
            <SectionLabel>QFC and Fred Meyer</SectionLabel>
            <StorePicker
              key={zip}
              initialZip={zip}
              selectedId={selected?.kroger ? selected.id : undefined}
              onSelect={chooseKroger}
            />
          </View>

          <View className="gap-3">
            <SectionLabel>
              {krogerUnavailable ? "Stores near you" : "Other stores near you"}
            </SectionLabel>
            {center && !center.exact ? (
              <Note>
                We do not have a store in that ZIP, so we placed it by the closest ZIP we know.
                Distances are rough.
              </Note>
            ) : null}
            {stores.length === 0 ? (
              <Text className="text-sm text-neutral-600">
                No stores on our list within 25 miles. You can still continue below.
              </Text>
            ) : null}
            <View accessibilityRole="radiogroup" className="gap-2">
              {stores.map((store) => (
                <StoreRow
                  key={store.id}
                  testID={`store-${store.id}`}
                  label={store.name}
                  detail={`${store.address}, ${milesLabel(store.miles)}`}
                  selected={selected?.id === store.id}
                  onPress={() => setPick({ id: store.id, label: store.name })}
                />
              ))}
              <OptionRow
                testID="store-other"
                label="My store is not listed"
                description="We will ask again when your store is supported."
                selected={selected?.id === OTHER_STORE_ID}
                onPress={() => setPick({ id: OTHER_STORE_ID, label: "My store is not listed" })}
              />
            </View>
            <Note>
              Addresses come from public store lists and distances are approximate. Check hours with
              the store.
            </Note>
          </View>
        </>
      ) : (
        <Note>Enter your ZIP to see stores near you.</Note>
      )}

      <View className="gap-3">
        <SectionLabel>Do you have a Costco membership?</SectionLabel>
        <View accessibilityRole="radiogroup" className="gap-2">
          <OptionRow
            testID="costco-yes"
            label="Yes"
            selected={costco === true}
            onPress={() => setCostcoEdit(true)}
          />
          <OptionRow
            testID="costco-no"
            label="No"
            selected={costco === false}
            onPress={() => setCostcoEdit(false)}
          />
        </View>
        <Note>Costco orders online are for members, so this tells us how to shop there.</Note>
      </View>

      {selected?.kroger || ownConnection ? (
        <View className="gap-3">
          <SectionLabel>{`Fill your ${selected?.kroger?.chain === "FRED" ? "Fred Meyer" : "QFC"} cart`}</SectionLabel>
          {ownConnection ? (
            <ConnectionCard
              connection={ownConnection}
              isHolder
              isOwner={isOwner}
              zip={household.data?.zip}
            />
          ) : selected?.kroger ? (
            <ConnectKroger
              householdId={householdId}
              store={{ id: selected.id, name: selected.kroger.name, chain: selected.kroger.chain }}
              onConnected={() => void connection.refetch()}
            />
          ) : null}
          <Note>You can connect now or later in household settings.</Note>
        </View>
      ) : null}
    </OnboardingFrame>
  );
}
