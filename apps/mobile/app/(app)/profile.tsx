import { ProfileUpdateInput } from "@mp/core";
import {
  identityErrorMessage,
  updateDisplayName,
  useProfile,
  useSession,
  useSupabase,
} from "@mp/db";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { Avatar } from "../../src/components/Avatar";
import { Button } from "../../src/components/Button";
import { ErrorText, LoadingScreen, Screen, Section } from "../../src/components/Screen";
import { TextField } from "../../src/components/TextField";
import { useSignOut } from "../../src/features/auth/useSignOut";
import { chooseAndUploadAvatar } from "../../src/features/profile/pickAvatar";

export default function ProfileScreen() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const { user } = useSession();
  const profile = useProfile();
  const [draftName, setDraftName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const userId = user?.id;
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["profile"] });
    await queryClient.invalidateQueries({ queryKey: ["household-members"] });
    await queryClient.invalidateQueries({ queryKey: ["avatar-url"] });
  };

  const saveName = useMutation({
    mutationFn: (name: string) => {
      if (!userId) throw new Error("Not signed in");
      return updateDisplayName(client, userId, name);
    },
    onSuccess: async () => {
      setDraftName(null);
      setError(null);
      await refresh();
    },
    onError: (cause) => setError(identityErrorMessage(cause)),
  });

  const changePhoto = useMutation({
    mutationFn: () => {
      if (!userId) throw new Error("Not signed in");
      return chooseAndUploadAvatar(client, {
        userId,
        previousPath: profile.data?.avatar_url ?? null,
      });
    },
    onSuccess: async (path) => {
      if (path) await refresh();
      setError(null);
    },
    onError: (cause) =>
      setError(
        cause instanceof Error && cause.message ? cause.message : identityErrorMessage(cause),
      ),
  });

  // This device only: signing out here does not end the session on the person's other devices.
  const signOut = useSignOut({ onError: () => setError("Could not sign out. Try again.") });

  if (profile.isPending) return <LoadingScreen />;

  const shownName = draftName ?? profile.data?.display_name ?? "";
  const parsed = ProfileUpdateInput.safeParse({ display_name: shownName });
  const dirty = draftName !== null && draftName.trim() !== (profile.data?.display_name ?? "");

  return (
    <Screen title="Profile">
      <View className="items-center gap-3">
        <Avatar path={profile.data?.avatar_url} name={profile.data?.display_name} size={96} />
        <Button
          testID="change-photo"
          label={profile.data?.avatar_url ? "Change photo" : "Add a photo"}
          variant="secondary"
          loading={changePhoto.isPending}
          onPress={() => changePhoto.mutate()}
        />
      </View>

      <Section title="Name">
        <TextField
          label="Display name"
          value={shownName}
          onChangeText={setDraftName}
          maxLength={80}
          autoComplete="name"
          textContentType="name"
          helper="Housemates see this name."
          testID="display-name-input"
        />
        <Button
          testID="save-display-name"
          label="Save name"
          loading={saveName.isPending}
          disabled={!dirty || !parsed.success}
          onPress={() => parsed.success && saveName.mutate(parsed.data.display_name)}
        />
      </Section>

      <Section title="Account">
        <Text className="text-base text-neutral-700">{user?.email ?? "Signed in"}</Text>
        <Button
          testID="sign-out"
          label="Sign out"
          variant="secondary"
          loading={signOut.isPending}
          onPress={() => signOut.mutate()}
        />
      </Section>

      <ErrorText>{error}</ErrorText>
    </Screen>
  );
}
