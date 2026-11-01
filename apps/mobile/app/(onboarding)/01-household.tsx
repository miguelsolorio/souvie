import type { PlanMode } from "@mp/core";
import { createHousehold, redeemInvite, useSetPlanMode, useSupabase } from "@mp/db";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "../../src/components/Button";
import { ErrorText, LoadingScreen } from "../../src/components/Screen";
import { TextField } from "../../src/components/TextField";
import { useSignOut } from "../../src/features/auth/useSignOut";
import { OnboardingFrame, OptionRow } from "../../src/features/onboarding/components";
import {
  asksPlanMode,
  shownPlanMode,
  submitHouseholdStep,
} from "../../src/features/onboarding/householdStep";
import { PlanModeChoice } from "../../src/features/onboarding/PlanModeChoice";
import { useOnboarding } from "../../src/features/onboarding/useOnboarding";
import { useStepNav } from "../../src/features/onboarding/useStepNav";

type Mode = "create" | "join";

/**
 * Screen 1: create a household or join one with an invite. A person already in one just continues.
 * The owner of a household (a person who creates one, or comes back to one they own) is also asked
 * how much they want to plan, Just dinners by default. A member is not asked, because only an
 * owner can change it.
 */
export default function HouseholdStep() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const { household, saveStep, saving } = useOnboarding();
  const { goNext } = useStepNav(1);
  const signOut = useSignOut();
  const setPlanMode = useSetPlanMode();

  const [mode, setMode] = useState<Mode>("create");
  const [name, setName] = useState("");
  const [invite, setInvite] = useState("");
  // null until the person touches the question, so it follows the household's saved mode.
  const [planPick, setPlanPick] = useState<PlanMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  if (household.isPending) return <LoadingScreen />;

  async function refreshHousehold() {
    await queryClient.invalidateQueries({ queryKey: ["household"] });
    await queryClient.invalidateQueries({ queryKey: ["household-members"] });
  }

  async function submit() {
    setError(null);
    setWorking(true);
    try {
      const result = await submitHouseholdStep(
        {
          existing: household.data ?? null,
          action: mode === "create" ? { kind: "create", name } : { kind: "join", invite },
          planMode: shownPlanMode(planPick, household.data ?? null),
        },
        {
          createHousehold: (householdName) => createHousehold(client, householdName),
          redeemInvite: (token) => redeemInvite(client, token),
          refreshHousehold,
          setPlanMode: setPlanMode.mutateAsync,
          finish: async () => {
            await saveStep({ step: 1 });
            goNext();
          },
        },
      );
      if (!result.ok) setError(result.error);
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
  const planQuestion = asksPlanMode(existing ?? null, mode) ? (
    <PlanModeChoice
      value={shownPlanMode(planPick, existing ?? null)}
      onChange={setPlanPick}
      recommend
    />
  ) : null;

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
        <View className="gap-6">
          <View className="gap-1 rounded-xl border border-neutral-200 p-4">
            <Text
              testID="household-existing-name"
              className="text-xl font-semibold text-neutral-900"
            >
              {existing.name}
            </Text>
            <Text className="text-sm text-neutral-600">
              {existing.role === "owner" ? "You are the owner." : "You are a member."}
            </Text>
          </View>
          {planQuestion}
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
          {planQuestion}
        </View>
      )}
    </OnboardingFrame>
  );
}
