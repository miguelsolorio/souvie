import { HouseholdNameInput } from "@mp/core";
import { createHousehold, identityErrorMessage, redeemInvite, useSupabase } from "@mp/db";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "../../src/components/Button";
import { ErrorText, LoadingScreen } from "../../src/components/Screen";
import { TextField } from "../../src/components/TextField";
import { parseInviteInput } from "../../src/features/auth/links";
import { useSignOut } from "../../src/features/auth/useSignOut";
import { OnboardingFrame, OptionRow } from "../../src/features/onboarding/components";
import { useOnboarding } from "../../src/features/onboarding/useOnboarding";
import { useStepNav } from "../../src/features/onboarding/useStepNav";

type Mode = "create" | "join";

/** Screen 1: create a household or join one with an invite. A person already in one just continues. */
export default function HouseholdStep() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const { household, saveStep, saving } = useOnboarding();
  const { goNext } = useStepNav(1);
  const signOut = useSignOut();

  const [mode, setMode] = useState<Mode>("create");
  const [name, setName] = useState("");
  const [invite, setInvite] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  if (household.isPending) return <LoadingScreen />;

  async function refreshHousehold() {
    await queryClient.invalidateQueries({ queryKey: ["household"] });
    await queryClient.invalidateQueries({ queryKey: ["household-members"] });
  }

  async function finish() {
    await saveStep({ step: 1 });
    goNext();
  }

  async function submit() {
    setError(null);
    if (household.data) {
      try {
        await finish();
      } catch {
        setError("We could not save that. Try again.");
      }
      return;
    }
    setWorking(true);
    try {
      if (mode === "create") {
        const parsed = HouseholdNameInput.safeParse({ name });
        if (!parsed.success) {
          setError("Give your household a name of 2 to 40 characters.");
          return;
        }
        await createHousehold(client, parsed.data.name);
      } else {
        const token = parseInviteInput(invite);
        if (!token) {
          setError("That does not look like an invite link or code.");
          return;
        }
        await redeemInvite(client, token);
      }
      await refreshHousehold();
      await finish();
    } catch (cause) {
      setError(identityErrorMessage(cause));
    } finally {
      setWorking(false);
    }
  }

  const existing = household.data;
  const canContinue = existing
    ? true
    : mode === "create"
      ? name.trim().length > 0
      : invite.trim().length > 0;

  return (
    <OnboardingFrame
      step={1}
      title={existing ? "Your household" : "Set up your household"}
      subtitle={
        existing
          ? "This is who you plan and shop with."
          : "A household is the group you plan and shop with. Create one, or join one you were invited to."
      }
      onContinue={() => void submit()}
      canContinue={canContinue}
      busy={saving || working}
      error={error}
      footer={
        <View className="gap-1 border-t border-neutral-200 pt-4">
          <Text className="text-sm text-neutral-500">Wrong account?</Text>
          <Button
            testID="sign-out"
            label="Sign out"
            variant="ghost"
            loading={signOut.isPending}
            onPress={() => signOut.mutate()}
          />
          <ErrorText>{signOut.isError ? "Could not sign out. Try again." : null}</ErrorText>
        </View>
      }
    >
      {existing ? (
        <View className="gap-1 rounded-xl border border-neutral-200 p-4">
          <Text testID="household-existing-name" className="text-xl font-semibold text-neutral-900">
            {existing.name}
          </Text>
          <Text className="text-sm text-neutral-600">
            {existing.role === "owner" ? "You are the owner." : "You are a member."}
          </Text>
        </View>
      ) : (
        <View className="gap-4">
          <View accessibilityRole="radiogroup" className="gap-2">
            <OptionRow
              testID="household-mode-create"
              label="Create a household"
              selected={mode === "create"}
              onPress={() => setMode("create")}
            />
            <OptionRow
              testID="household-mode-join"
              label="Join with an invite"
              description="Paste the link or code you were sent."
              selected={mode === "join"}
              onPress={() => setMode("join")}
            />
          </View>
          {mode === "create" ? (
            <TextField
              label="Household name"
              value={name}
              onChangeText={setName}
              placeholder="Our kitchen"
              maxLength={40}
              returnKeyType="done"
              testID="household-name"
            />
          ) : (
            <TextField
              label="Invite link or code"
              value={invite}
              onChangeText={setInvite}
              placeholder="Paste it here"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              testID="invite-input"
            />
          )}
        </View>
      )}
    </OnboardingFrame>
  );
}
