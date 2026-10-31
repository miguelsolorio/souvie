import type { Profile } from "@mp/core";
import { useQuery } from "@tanstack/react-query";
import type { MpClient } from "../client";
import { useSupabase } from "../context";
import { toIdentityError } from "../identity";
import { useSession } from "./useSession";

export const profileQueryKey = (userId: string | undefined) => ["profile", userId] as const;

/**
 * Every profiles column except taste_embedding. That column is a 1024 number vector (about 20 KB as
 * text) that only the suggest function uses, so a screen that reads a profile never fetches it. A
 * column added later is added here on purpose, not picked up by a `select *`.
 */
export const PROFILE_COLUMNS =
  "user_id, display_name, avatar_url, preferences, onboarding_step, costco_member, created_at, updated_at";

/** The caller's own profile. RLS allows no other row. */
export async function fetchProfile(client: MpClient, userId: string): Promise<Profile | null> {
  const { data, error } = await client
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw toIdentityError(error);
  return data as Profile | null;
}

export function useProfile() {
  const client = useSupabase();
  const { user } = useSession();
  const userId = user?.id;

  return useQuery({
    queryKey: profileQueryKey(userId),
    enabled: userId !== undefined,
    queryFn: () => {
      if (userId === undefined) return Promise.resolve(null);
      return fetchProfile(client, userId);
    },
  });
}
