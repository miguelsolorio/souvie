import { type Household, type HouseholdRole, PlanMode } from "@mp/core";
import { useQuery } from "@tanstack/react-query";
import type { MpClient } from "../client";
import { useSupabase } from "../context";
import { toIdentityError } from "../identity";
import { useSession } from "./useSession";

/**
 * The household the app is acting in, with the caller's role in it and how much it plans.
 * `plan_mode` is a column on the household row (migration 20261031120000); `Household` in
 * @mp/core does not list it yet, so it is added here.
 */
export type ActiveHousehold = Household & { role: HouseholdRole; plan_mode: PlanMode };

/** How much a household plans when the row does not say: one dinner a day, the column's default. */
export const DEFAULT_PLAN_MODE: PlanMode = "simple";

/**
 * A household row's `plan_mode` as a PlanMode. A copy saved on the device before the column
 * existed has none, and a value this build does not know (a mode added later) is not guessed at:
 * both count as the default, so the planner always has slots to draw.
 */
export function planModeOf(value: unknown): PlanMode {
  const parsed = PlanMode.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_PLAN_MODE;
}

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

  const row = data?.[0] as
    | { role: HouseholdRole; households: Household & { plan_mode?: unknown } }
    | undefined;
  return row
    ? { ...row.households, plan_mode: planModeOf(row.households.plan_mode), role: row.role }
    : null;
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

/**
 * How much the active household plans. Just dinners until the household has loaded, and for a
 * copy saved on the device before the setting existed. Screens that draw the planner wait for the
 * household before they draw, so this default never shows a wrong grid.
 */
export function usePlanMode(): PlanMode {
  const household = useHousehold();
  return household.data?.plan_mode ?? DEFAULT_PLAN_MODE;
}
