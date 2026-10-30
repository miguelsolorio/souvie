import { createInvite, identityErrorMessage, useSupabase } from "@mp/db";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "../../components/Button";
import { ErrorText, Section } from "../../components/Screen";
import { publicEnv } from "../../lib/env";
import { copyText, shareLink } from "../../lib/share";
import { buildInviteUrl } from "../auth/links";

/**
 * Owner only. Creates a single-use invite link that lasts 7 days, then offers the share sheet
 * and a copy button. The link opens the web app or, with the mealplanner:// scheme, the native
 * app; either way the token is redeemed after sign-in.
 */
export function InviteSection({ householdId }: { householdId: string }) {
  const client = useSupabase();
  const [url, setUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => createInvite(client, householdId),
    onSuccess: (token) => {
      setError(null);
      setNotice(null);
      // On web the app's own origin is a fine fallback when no public origin is configured.
      const browserOrigin = (globalThis as { location?: { origin?: string } }).location?.origin;
      setUrl(buildInviteUrl(token, publicEnv.webOrigin || browserOrigin));
    },
    onError: (cause) => setError(identityErrorMessage(cause)),
  });

  async function share() {
    if (!url) return;
    const shared = await shareLink(url, "Join my household on Meal Planner:");
    if (!shared) {
      await copyText(url);
      setNotice("Link copied.");
    }
  }

  async function copy() {
    if (!url) return;
    await copyText(url);
    setNotice("Link copied.");
  }

  return (
    <Section title="Invite someone">
      <Text className="text-sm text-neutral-600">
        Each link works once and expires in 7 days. Anyone with the link can join, so send it only
        to the person you mean.
      </Text>
      <Button
        testID="create-invite"
        label={url ? "Create a new link" : "Create invite link"}
        variant="secondary"
        loading={create.isPending}
        onPress={() => create.mutate()}
      />
      {url ? (
        <View className="gap-3">
          <Text
            testID="invite-url"
            selectable
            className="rounded-xl bg-neutral-100 p-3 text-sm text-neutral-800"
          >
            {url}
          </Text>
          <View className="flex-row gap-3">
            <View className="flex-1">
              <Button label="Share" onPress={() => void share()} />
            </View>
            <View className="flex-1">
              <Button label="Copy link" variant="secondary" onPress={() => void copy()} />
            </View>
          </View>
        </View>
      ) : null}
      {notice ? <Text className="text-sm text-neutral-600">{notice}</Text> : null}
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}
