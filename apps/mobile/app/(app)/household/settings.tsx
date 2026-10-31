import {
  identityErrorMessage,
  leaveHousehold,
  removeMember,
  renameHousehold,
  useHousehold,
  useHouseholdMembers,
  useSession,
  useSupabase,
} from "@mp/db";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "../../../src/components/Button";
import { ErrorText, LoadingScreen, Screen, Section } from "../../../src/components/Screen";
import { TextField } from "../../../src/components/TextField";
import { CREATE_HOUSEHOLD_ROUTE, HOME_ROUTE } from "../../../src/features/auth/routes";
import { InviteSection } from "../../../src/features/household/InviteSection";
import { MemberRow } from "../../../src/features/household/MemberRow";
import { RecheckNoticeLine } from "../../../src/features/onboarding/components";
import { KrogerSettingsSection } from "../../../src/features/onboarding/KrogerSettingsSection";
import { EDIT_START_HREF } from "../../../src/features/onboarding/onboardingState";
import { confirmAction } from "../../../src/lib/confirm";

export default function HouseholdSettingsScreen() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const router = useRouter();
  // The result of re-checking the planned weeks, when the person just edited food preferences.
  const { notice } = useLocalSearchParams<{ notice?: string }>();
  const { user } = useSession();
  const household = useHousehold();
  const members = useHouseholdMembers(household.data?.id);

  // null means "show what the server has"; a string is an unsaved edit.
  const [draftName, setDraftName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["household"] });
  const refreshMembers = () => queryClient.invalidateQueries({ queryKey: ["household-members"] });

  const rename = useMutation({
    mutationFn: (name: string) => {
      if (!household.data) throw new Error("No household");
      return renameHousehold(client, household.data.id, name);
    },
    onSuccess: async () => {
      setDraftName(null);
      setError(null);
      await refresh();
    },
    onError: (cause) => setError(identityErrorMessage(cause)),
  });

  const remove = useMutation({
    mutationFn: (userId: string) => {
      if (!household.data) throw new Error("No household");
      return removeMember(client, household.data.id, userId);
    },
    onSuccess: async () => {
      setError(null);
      await refreshMembers();
    },
    onError: (cause) => setError(identityErrorMessage(cause)),
    onSettled: () => setRemovingId(null),
  });

  const leave = useMutation({
    mutationFn: () => {
      if (!household.data) throw new Error("No household");
      return leaveHousehold(client, household.data.id);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["household"] });
      await queryClient.invalidateQueries({ queryKey: ["household-members"] });
      router.replace(HOME_ROUTE);
    },
    onError: (cause) => setError(identityErrorMessage(cause)),
  });

  if (household.isPending) return <LoadingScreen />;
  if (!household.data) return <Redirect href={CREATE_HOUSEHOLD_ROUTE} />;

  const current = household.data;
  const isOwner = current.role === "owner";
  const shownName = draftName ?? current.name;
  const dirty = draftName !== null && draftName.trim() !== current.name;

  async function confirmRemove(userId: string, displayName: string | null) {
    const ok = await confirmAction({
      title: "Remove member",
      message: `${displayName?.trim() || "This person"} will lose access to the household.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    setRemovingId(userId);
    remove.mutate(userId);
  }

  async function confirmLeave() {
    const ok = await confirmAction({
      title: "Leave household",
      message: isOwner
        ? "You are an owner. If no other owner exists, the member who joined first becomes the owner. If you are the last person here, the household is closed."
        : "You will lose access to this household's plans and lists.",
      confirmLabel: "Leave",
      destructive: true,
    });
    if (ok) leave.mutate();
  }

  return (
    <Screen title={current.name} subtitle={isOwner ? "You are the owner." : "You are a member."}>
      <Section title="Name">
        <TextField
          label="Household name"
          value={shownName}
          onChangeText={setDraftName}
          editable={isOwner}
          maxLength={80}
          helper={isOwner ? undefined : "Only the owner can rename the household."}
          testID="household-name-input"
        />
        {isOwner ? (
          <Button
            testID="save-household-name"
            label="Save name"
            loading={rename.isPending}
            disabled={!dirty || shownName.trim().length === 0}
            onPress={() => rename.mutate(shownName)}
          />
        ) : null}
      </Section>

      <Section title="Food preferences">
        <Text className="text-sm text-neutral-600">
          Who you cook for, diets and allergies, dislikes, time, and budget. Your allergies and
          diets are applied to the whole household's plan.
        </Text>
        <RecheckNoticeLine value={notice} />
        <Button
          testID="edit-food-preferences"
          label="Edit food preferences"
          variant="secondary"
          onPress={() => router.push(EDIT_START_HREF)}
        />
      </Section>

      <Section title="Members">
        {members.isPending ? <Text className="text-sm text-neutral-500">Loading</Text> : null}
        {members.isError ? (
          <Text className="text-sm text-red-700">Could not load the members.</Text>
        ) : null}
        <View className="gap-4">
          {(members.data ?? []).map((member) => (
            <MemberRow
              key={member.user_id}
              member={member}
              isSelf={member.user_id === user?.id}
              canRemove={isOwner && member.role === "member" && member.user_id !== user?.id}
              removing={removingId === member.user_id}
              onRemove={() => void confirmRemove(member.user_id, member.display_name)}
            />
          ))}
        </View>
      </Section>

      {isOwner ? <InviteSection householdId={current.id} /> : null}

      <Section title="Kroger (QFC and Fred Meyer)">
        <KrogerSettingsSection householdId={current.id} isOwner={isOwner} zip={current.zip} />
      </Section>

      <ErrorText>{error}</ErrorText>

      <Section title="Leave">
        <Button
          testID="leave-household"
          label="Leave household"
          variant="danger"
          loading={leave.isPending}
          onPress={() => void confirmLeave()}
        />
      </Section>
    </Screen>
  );
}
