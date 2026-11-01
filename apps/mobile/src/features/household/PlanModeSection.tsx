import type { PlanMode } from "@mp/core";
import { identityErrorMessage, useSetPlanMode } from "@mp/db";
import { Text } from "react-native";
import { ErrorText, Section } from "../../components/Screen";
import { PLAN_MODE_SENTENCE, PlanModeChoice } from "../onboarding/PlanModeChoice";

/**
 * Household settings: how much the household plans, Just dinners or Every meal. The owner changes
 * it with one tap and the planner follows at once. A member sees the choice and cannot change it.
 * Switching never deletes a meal: what the new mode does not draw waits under "More meals" and
 * still goes on the grocery list.
 */
export function PlanModeSection({
  householdId,
  mode,
  isOwner,
}: {
  householdId: string;
  mode: PlanMode;
  isOwner: boolean;
}) {
  const update = useSetPlanMode();

  function choose(next: PlanMode) {
    if (!isOwner || next === mode) return;
    update.mutate({ householdId, mode: next });
  }

  return (
    <Section title="Planning">
      <PlanModeChoice value={mode} onChange={choose} disabled={!isOwner} />
      <Text testID="plan-mode-sentence" className="text-sm text-neutral-600">
        {PLAN_MODE_SENTENCE}
      </Text>
      {isOwner ? null : (
        <Text testID="plan-mode-owner-only" className="text-sm text-neutral-500">
          Only the owner can change this.
        </Text>
      )}
      <ErrorText>{update.isError ? identityErrorMessage(update.error) : null}</ErrorText>
    </Section>
  );
}
