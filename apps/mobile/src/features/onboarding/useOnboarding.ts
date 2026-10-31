import { ProfilePreferences } from "@mp/core";
import { type Json, type MpClient, useHousehold, useSession, useSupabase } from "@mp/db";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { buildProfileUpdate, type SaveStepInput, type StoredProfile } from "./onboardingState";

/** Only the columns onboarding needs. taste_embedding stays on the server. */
const COLUMNS = "user_id, preferences, onboarding_step, costco_member";

export const onboardingProfileKey = (userId: string | undefined) =>
  ["onboarding-profile", userId] as const;

/** The caller's own row. RLS allows no other. Null when the row does not exist yet. */
export async function fetchOnboardingProfile(
  client: MpClient,
  userId: string,
): Promise<StoredProfile | null> {
  const { data, error } = await client
    .from("profiles")
    .select(COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const parsed = ProfilePreferences.safeParse(data.preferences ?? {});
  return {
    // A row that no longer parses counts as unanswered, so the screens ask again.
    preferences: parsed.success ? parsed.data : {},
    onboardingStep: data.onboarding_step,
    costcoMember: data.costco_member,
  };
}

/** Progress and saved answers. Used by the gate and by the screens. */
export function useOnboardingProfile() {
  const client = useSupabase();
  const { user } = useSession();
  const userId = user?.id;
  return useQuery({
    queryKey: onboardingProfileKey(userId),
    enabled: userId !== undefined,
    // Always re-read on mount: the step decides where the app opens.
    staleTime: 0,
    queryFn: () => {
      if (userId === undefined) return Promise.resolve(null);
      return fetchOnboardingProfile(client, userId);
    },
  });
}

/**
 * Everything an onboarding screen needs: the saved profile, the household, and `saveStep`, which
 * writes one screen's answers immediately (so a crash loses at most one screen) and sets
 * profiles.onboarding_step to the screen just completed.
 */
export function useOnboarding() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const { user } = useSession();
  const household = useHousehold();
  const profile = useOnboardingProfile();
  const userId = user?.id;

  const save = useMutation({
    mutationFn: async (input: SaveStepInput) => {
      if (userId === undefined) throw new Error("Sign in first.");
      // Merge into the stored row, not the cache, so a second device's answers are not lost.
      const current = await fetchOnboardingProfile(client, userId);
      const update = buildProfileUpdate(current, input);
      const { error } = await client
        .from("profiles")
        .update({
          preferences: update.preferences as unknown as NonNullable<Json>,
          onboarding_step: update.onboarding_step,
          ...(update.costco_member === undefined ? {} : { costco_member: update.costco_member }),
        })
        .eq("user_id", userId);
      if (error) throw new Error(error.message);
      return update;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: onboardingProfileKey(userId) }),
  });

  return {
    userId,
    profile,
    saved: profile.data?.preferences,
    completedStep: profile.data?.onboardingStep ?? 0,
    household,
    householdId: household.data?.id,
    isOwner: household.data?.role === "owner",
    saveStep: save.mutateAsync,
    saving: save.isPending,
    saveError: save.error,
    resetSaveError: save.reset,
  };
}
