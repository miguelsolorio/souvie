import {
  ALLERGENS,
  type Allergen,
  DIETS,
  type Diet,
  DietsAllergiesInput,
  dietsAllergiesToPreferences,
} from "@mp/core";
import { useState } from "react";
import { Text, View } from "react-native";
import {
  Chip,
  ChipGroup,
  Note,
  OnboardingFrame,
  SectionLabel,
} from "../../src/features/onboarding/components";
import {
  ALLERGEN_LABEL,
  ALLERGY_NOTE,
  DIET_LABEL,
  DIET_NOTE,
} from "../../src/features/onboarding/labels";
import { hasAnsweredAllergies, toggleItem } from "../../src/features/onboarding/onboardingState";
import { useFinishStep } from "../../src/features/onboarding/useFinishStep";
import { useOnboarding } from "../../src/features/onboarding/useOnboarding";
import { usePreferencesDraft } from "../../src/features/onboarding/usePreferencesDraft";

/**
 * Screen 3: diets and allergies. The allergy question cannot be skipped: Continue stays off until
 * the person picks at least one allergen or says "No allergies" out loud.
 */
export default function DietsAllergiesStep() {
  const { saved, saveStep, saving } = useOnboarding();
  const { draft, set, update } = usePreferencesDraft(saved);
  const { goBack, finish, checking } = useFinishStep(3);
  const [error, setError] = useState<string | null>(null);
  // Undefined until the person touches the chip; then it is their answer. Before that, the saved answer.
  const [noAllergiesEdit, setNoAllergiesEdit] = useState<boolean | undefined>(undefined);

  const diets = (draft.diets ?? []) as Diet[];
  const allergies = (draft.allergies ?? []) as Allergen[];
  const answeredBefore = hasAnsweredAllergies(saved) && (saved?.allergies?.length ?? 0) === 0;
  const noAllergies = noAllergiesEdit ?? answeredBefore;
  const canContinue = noAllergies || allergies.length > 0;

  function toggleDiet(diet: Diet) {
    update("diets", (current) => toggleItem(current, diet));
  }

  function toggleAllergen(allergen: Allergen) {
    setNoAllergiesEdit(false);
    update("allergies", (current) => toggleItem(current, allergen));
  }

  function chooseNone() {
    setNoAllergiesEdit(true);
    set("allergies", []);
  }

  async function submit() {
    setError(null);
    const parsed = DietsAllergiesInput.safeParse({ diets, allergies, noAllergies });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Choose your allergens, or choose No allergies.");
      return;
    }
    try {
      await saveStep({ step: 3, patch: dietsAllergiesToPreferences(parsed.data) });
    } catch {
      setError("We could not save that. Try again.");
      return;
    }
    // In edit mode this also re-checks the planned weeks against the new answers.
    const problem = await finish();
    if (problem) setError(problem);
  }

  const noteDiets = DIETS.filter((d) => diets.includes(d) && DIET_NOTE[d]);

  return (
    <OnboardingFrame
      step={3}
      title="Diets and allergies"
      subtitle="Allergies are hard rules. We never suggest a recipe that mentions one."
      onBack={goBack}
      onContinue={() => void submit()}
      canContinue={canContinue}
      busy={saving || checking}
      error={error}
    >
      <View className="gap-3">
        <SectionLabel>Any allergies?</SectionLabel>
        <ChipGroup>
          <Chip
            testID="allergy-none"
            label="No allergies"
            selected={noAllergies}
            onPress={chooseNone}
          />
          {ALLERGENS.map((allergen) => (
            <Chip
              key={allergen}
              testID={`allergen-${allergen}`}
              label={ALLERGEN_LABEL[allergen]}
              tone="alert"
              selected={allergies.includes(allergen)}
              onPress={() => toggleAllergen(allergen)}
            />
          ))}
        </ChipGroup>
        {!canContinue ? (
          <Text testID="allergy-required" className="text-sm text-neutral-700">
            Choose your allergens, or choose No allergies, to continue.
          </Text>
        ) : null}
        <Note>{ALLERGY_NOTE}</Note>
      </View>

      <View className="gap-3">
        <SectionLabel>Any diets?</SectionLabel>
        <ChipGroup>
          {DIETS.map((diet) => (
            <Chip
              key={diet}
              testID={`diet-${diet}`}
              label={DIET_LABEL[diet]}
              selected={diets.includes(diet)}
              onPress={() => toggleDiet(diet)}
            />
          ))}
        </ChipGroup>
        {noteDiets.map((diet) => (
          <Note key={diet}>
            {DIET_LABEL[diet]}: {DIET_NOTE[diet]}
          </Note>
        ))}
      </View>
    </OnboardingFrame>
  );
}
