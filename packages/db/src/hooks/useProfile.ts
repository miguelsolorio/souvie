import type { Profile } from "@mp/core";
import { useQuery } from "@tanstack/react-query";
import type { MpClient } from "../client";
import { useSupabase } from "../context";
import { toIdentityError } from "../identity";
import { useSession } from "./useSession";

export const profileQueryKey = (userId: string | undefined) => ["profile", userId] as const;

/** The caller's own profile. RLS allows no other row. */
export async function fetchProfile(client: MpClient, userId: string): Promise<Profile | null> {
  const { data, error } = await client
    .from("profiles")
    .select("*")
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
