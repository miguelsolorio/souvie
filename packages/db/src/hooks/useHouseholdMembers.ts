import { useQuery } from "@tanstack/react-query";
import { useSupabase } from "../context";
import { listHouseholdMembers } from "../identity";

export const householdMembersQueryKey = (householdId: string | null | undefined) =>
  ["household-members", householdId] as const;

/**
 * The roster of a household with display names and avatar paths, owners first. Housemates read
 * each other's names through the list_household_members function, because profiles themselves
 * are private to each user.
 */
export function useHouseholdMembers(householdId: string | null | undefined) {
  const client = useSupabase();

  return useQuery({
    queryKey: householdMembersQueryKey(householdId),
    enabled: Boolean(householdId),
    queryFn: () => {
      if (!householdId) return Promise.resolve([]);
      return listHouseholdMembers(client, householdId);
    },
  });
}
