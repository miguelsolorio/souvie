// What Continue does on the first onboarding screen, "Your household" (WS04 follow-up: simple
// mode). The screen holds the form; this holds the order of the calls, so the order is tested.
//
// The screen also asks "How much do you want to plan?" (Just dinners or Every meal). Only the
// household's owner is asked, because only an owner may change the setting: a person who creates a
// household is its owner, a person who joins one is a member and is never asked, and a person who
// comes back to this screen is asked again only if they own the household they are in.
import { HouseholdNameInput, type HouseholdRole, type PlanMode } from "@mp/core";
import { identityErrorMessage } from "@mp/db";
import { parseInviteInput } from "../auth/links";

/** A new household starts here (the column's default), so choosing it needs no write. */
export const NEW_HOUSEHOLD_PLAN_MODE: PlanMode = "simple";

/** The household the person is already in, as far as this screen cares. */
export interface ExistingHousehold {
  id: string;
  role: HouseholdRole;
  plan_mode: PlanMode;
}

/** The two ways to get a household. Ignored when the person already has one. */
export type HouseholdAction = { kind: "create"; name: string } | { kind: "join"; invite: string };

/** Whether the plan question is on the screen: for an owner, now or once their household exists. */
export function asksPlanMode(
  existing: Pick<ExistingHousehold, "role"> | null,
  kind: HouseholdAction["kind"],
): boolean {
  return existing ? existing.role === "owner" : kind === "create";
}

/** What the question shows: the person's pick, else the household's saved mode, else the default. */
export function shownPlanMode(
  picked: PlanMode | null,
  existing: Pick<ExistingHousehold, "plan_mode"> | null,
): PlanMode {
  return picked ?? existing?.plan_mode ?? NEW_HOUSEHOLD_PLAN_MODE;
}

export interface HouseholdStepDeps {
  createHousehold: (name: string) => Promise<string>;
  redeemInvite: (token: string) => Promise<unknown>;
  /** Reload the household, so the screen and the rest of the app see it. */
  refreshHousehold: () => Promise<void>;
  setPlanMode: (input: { householdId: string; mode: PlanMode }) => Promise<unknown>;
  /** Save step 1 and move on to the next screen. */
  finish: () => Promise<void>;
}

export type HouseholdStepResult = { ok: true } | { ok: false; error: string };

export const SAVE_FAILED = "We could not save that. Try again.";

/**
 * Continue on the household screen.
 *
 * - Already in a household: an owner whose pick differs from the saved mode writes it, then the
 *   step finishes. A member just finishes.
 * - Creating: the household is made and reloaded first. Only then is the mode written, and only if
 *   the person picked Every meal (a new household already is Just dinners). The reload comes
 *   first on purpose: if the write fails, the screen already shows an existing household, so
 *   Continue tries the write again and never creates a second household.
 * - Joining: the person becomes a member. No question, no write.
 *
 * Returns the message to show, or `{ ok: true }` once the step has finished.
 */
export async function submitHouseholdStep(
  input: { existing: ExistingHousehold | null; action: HouseholdAction; planMode: PlanMode },
  deps: HouseholdStepDeps,
): Promise<HouseholdStepResult> {
  const { existing, action, planMode } = input;

  if (existing) {
    try {
      if (existing.role === "owner" && planMode !== existing.plan_mode) {
        await deps.setPlanMode({ householdId: existing.id, mode: planMode });
      }
      await deps.finish();
      return { ok: true };
    } catch {
      return { ok: false, error: SAVE_FAILED };
    }
  }

  try {
    let createdId: string | null = null;
    if (action.kind === "create") {
      const parsed = HouseholdNameInput.safeParse({ name: action.name });
      if (!parsed.success) {
        return { ok: false, error: "Give your household a name of 2 to 40 characters." };
      }
      createdId = await deps.createHousehold(parsed.data.name);
    } else {
      const token = parseInviteInput(action.invite);
      if (!token) return { ok: false, error: "That does not look like an invite link or code." };
      await deps.redeemInvite(token);
    }
    await deps.refreshHousehold();
    if (createdId !== null && planMode !== NEW_HOUSEHOLD_PLAN_MODE) {
      await deps.setPlanMode({ householdId: createdId, mode: planMode });
    }
    await deps.finish();
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: identityErrorMessage(cause) };
  }
}
