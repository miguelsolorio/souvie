import type { Household, HouseholdRole } from "@mp/core";
import { useQuery } from "@tanstack/react-query";
import type { MpClient } from "../client";
import { useSupabase } from "../context";
import { toIdentityError } from "../identity";
import { useSession } from "./useSession";

/** The household the app is acting in, with the caller's role in it. */
export type ActiveHousehold = Household & { role: HouseholdRole };

export const householdQueryKey = (userId: string | undefined) =>
  ["household", "active", userId] as const;

/**
 * The caller's active household, or null when they have none yet. Row Level Security limits the
 * query to households the caller belongs to; nothing here filters as a security boundary.
 *
 * "Active" is the household the caller joined most recently, so creating or joining one makes it
 * the active one with no extra state. Soft-deleted households are skipped. A household switcher
 * is a later concern; the hook's shape will not change when it arrives.
 */
export async function fetchActiveHousehold(
  client: MpClient,
  userId: string,
): Promise<ActiveHousehold | null> {
  const { data, error } = await client
    .from("household_members")
    .select("role, created_at, households!inner(*)")
    .eq("user_id", userId)
    .is("households.deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw toIdentityError(error);

  const row = data?.[0] as { role: HouseholdRole; households: Household } | undefined;
  return row ? { ...row.households, role: row.role } : null;
}

export function useHousehold() {
  const client = useSupabase();
  const { user } = useSession();
  const userId = user?.id;

  return useQuery({
    queryKey: householdQueryKey(userId),
    enabled: userId !== undefined,
    queryFn: () => {
      if (userId === undefined) return Promise.resolve(null);
      return fetchActiveHousehold(client, userId);
    },
  });
}
