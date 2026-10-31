import {
  BudgetLeftoversInput,
  budgetLeftoversToPreferences,
  LEFTOVERS,
  PREFERENCE_LIMITS,
} from "@mp/core";
import { useState } from "react";
import { View } from "react-native";
import { TextField } from "../../src/components/TextField";
import { OnboardingFrame, OptionRow, SectionLabel } from "../../src/features/onboarding/components";
import { parseBudgetText } from "../../src/features/onboarding/onboardingState";
import { useOnboarding } from "../../src/features/onboarding/useOnboarding";
import { usePreferencesDraft } from "../../src/features/onboarding/usePreferencesDraft";
import { useStepNav } from "../../src/features/onboarding/useStepNav";
import { MultilineField } from "../../src/features/recipes/MultilineField";

const B = PREFERENCE_LIMITS.budgetPerWeekUsd;

const LEFTOVER_TEXT: Record<(typeof LEFTOVERS)[number], { label: string; description: string }> = {
  avoid: { label: "Avoid leftovers", description: "Plan one meal for each dinner." },
  ok: { label: "A few are fine", description: "A little extra is welcome." },
  prefer: { label: "Love leftovers", description: "Cook extra for lunches." },
};

/** Screen 6: weekly grocery budget (optional), leftovers, and the one note we keep. */
export default function BudgetLeftoversStep() {
  const { saved, saveStep, saving } = useOnboarding();
  const { draft, set } = usePreferencesDraft(saved);
  const { goNext, goBack } = useStepNav(6);
  const [error, setError] = useState<string | null>(null);
  // null until the person types; then the text box wins over the saved budget.
  const [budgetText, setBudgetText] = useState<string | null>(null);
  const [noteText, setNoteText] = useState<string | null>(null);

  const shownBudget =
    budgetText ?? (saved?.budget_per_week_usd ? String(saved.budget_per_week_usd) : "");
  const shownNote = noteText ?? saved?.notes ?? "";
  const leftovers = draft.leftovers ?? "ok";

  async function submit() {
    setError(null);
    const parsed = BudgetLeftoversInput.safeParse({
      budget_per_week_usd: parseBudgetText(shownBudget),
      leftovers,
      notes: shownNote.trim() || undefined,
    });
    if (!parsed.success) {
      const budgetIssue = parsed.error.issues.some((i) => i.path[0] === "budget_per_week_usd");
      setError(
        budgetIssue
          ? `Enter a budget from $${B.min} to $${B.max}, or leave it empty to skip.`
          : "Check your answers and try again.",
      );
      return;
    }
    try {
      await saveStep({ step: 6, patch: budgetLeftoversToPreferences(parsed.data) });
      goNext();
    } catch {
      setError("We could not save that. Try again.");
    }
  }

  return (
    <OnboardingFrame
      step={6}
      title="Budget and leftovers"
      subtitle="Both help us pick dinners that fit. You can change them later."
      onBack={goBack}
      onContinue={() => void submit()}
      busy={saving}
      error={error}
    >
      <TextField
        label="Weekly grocery budget in dollars (optional)"
        value={shownBudget}
        onChangeText={(value) => setBudgetText(value.replace(/[^0-9.]/g, "").slice(0, 7))}
        keyboardType="number-pad"
        placeholder="150"
        helper={`From $${B.min} to $${B.max}. Leave it empty to skip.`}
        testID="budget"
      />

      <View className="gap-3">
        <SectionLabel>Leftovers</SectionLabel>
        <View accessibilityRole="radiogroup" className="gap-2">
          {LEFTOVERS.map((stance) => (
            <OptionRow
              key={stance}
              testID={`leftovers-${stance}`}
              label={LEFTOVER_TEXT[stance].label}
              description={LEFTOVER_TEXT[stance].description}
              selected={leftovers === stance}
              onPress={() => set("leftovers", stance)}
            />
          ))}
        </View>
      </View>

      <MultilineField
        label="Anything else we should know? (optional)"
        value={shownNote}
        onChangeText={setNoteText}
        lines={3}
        maxLength={PREFERENCE_LIMITS.notes.max}
        placeholder="We eat early on school nights."
        helper="We read this when we suggest dinners."
        testID="notes"
      />
    </OnboardingFrame>
  );
}
