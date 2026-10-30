import { CreateHouseholdInput } from "@mp/core";
import { createHousehold, identityErrorMessage, useSupabase } from "@mp/db";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "../../../src/components/Button";
import { ErrorText, Screen } from "../../../src/components/Screen";
import { TextField } from "../../../src/components/TextField";
import { parseInviteInput } from "../../../src/features/auth/links";
import { HOME_ROUTE, joinRoute } from "../../../src/features/auth/routes";

export default function CreateHouseholdScreen() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [name, setName] = useState("");
  const [inviteText, setInviteText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (householdName: string) => createHousehold(client, householdName),
    onSuccess: async () => {
      // The new household is now the active one. Wait for the refetch so home does not flash.
      await queryClient.invalidateQueries({ queryKey: ["household"] });
      router.replace(HOME_ROUTE);
    },
    onError: (cause) => setError(identityErrorMessage(cause)),
  });

  function submit() {
    setError(null);
    const parsed = CreateHouseholdInput.safeParse({ name });
    if (!parsed.success) {
      setError("Give your household a name, up to 80 characters.");
      return;
    }
    create.mutate(parsed.data.name);
  }

  function joinWithLink() {
    setInviteError(null);
    const token = parseInviteInput(inviteText);
    if (!token) {
      setInviteError("That does not look like an invite link.");
      return;
    }
    router.push(joinRoute(token));
  }

  return (
    <Screen
      title="Create your household"
      subtitle="A household is the group you plan and shop with. You can invite others once it exists."
    >
      <View className="gap-3">
        <TextField
          label="Household name"
          value={name}
          onChangeText={setName}
          placeholder="Our kitchen"
          maxLength={80}
          returnKeyType="done"
          onSubmitEditing={submit}
          testID="household-name"
        />
        <Button
          testID="create-household"
          label="Create household"
          loading={create.isPending}
          disabled={name.trim().length === 0}
          onPress={submit}
        />
        <ErrorText>{error}</ErrorText>
      </View>

      <View className="gap-3 border-t border-neutral-200 pt-6">
        <Text className="text-lg font-semibold text-neutral-900">Have an invite?</Text>
        <TextField
          label="Invite link"
          value={inviteText}
          onChangeText={setInviteText}
          placeholder="Paste the link you were sent"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          onSubmitEditing={joinWithLink}
          error={inviteError}
          testID="invite-link-input"
        />
        <Button
          testID="join-with-link"
          label="Join with link"
          variant="secondary"
          disabled={inviteText.trim().length === 0}
          onPress={joinWithLink}
        />
      </View>
    </Screen>
  );
}
