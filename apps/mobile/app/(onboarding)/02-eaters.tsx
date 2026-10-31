import { EatersInput, eatersToPreferences, PREFERENCE_LIMITS } from "@mp/core";
import { useState } from "react";
import { View } from "react-native";
import { NumberStepper, OnboardingFrame } from "../../src/features/onboarding/components";
import { useOnboarding } from "../../src/features/onboarding/useOnboarding";
import { usePreferencesDraft } from "../../src/features/onboarding/usePreferencesDraft";
import { useStepNav } from "../../src/features/onboarding/useStepNav";

const L = PREFERENCE_LIMITS;

/** Screen 2: adults, kids, and dinners per week. */
export default function EatersStep() {
  const { saved, saveStep, saving } = useOnboarding();
  const { draft, set } = usePreferencesDraft(saved);
  const { goNext, goBack } = useStepNav(2);
  const [error, setError] = useState<string | null>(null);

  const size = draft.household_size ?? { adults: 2, kids: 0 };
  const dinners = draft.dinners_per_week ?? 5;

  async function submit() {
    setError(null);
    const parsed = EatersInput.safeParse({
      adults: size.adults,
      kids: size.kids,
      dinners_per_week: dinners,
    });
    if (!parsed.success) {
      setError("Check the numbers: at least one adult, and 1 to 7 dinners a week.");
      return;
    }
    try {
      await saveStep({ step: 2, patch: eatersToPreferences(parsed.data) });
      goNext();
    } catch {
      setError("We could not save that. Try again.");
    }
  }

  return (
    <OnboardingFrame
      step={2}
      title="Who is eating?"
      subtitle="We use this to size recipes and plan the right number of dinners."
      onBack={goBack}
      onContinue={() => void submit()}
      busy={saving}
      error={error}
    >
      <View className="gap-3">
        <NumberStepper
          testID="adults"
          label="Adults"
          value={size.adults}
          min={L.adults.min}
          max={L.adults.max}
          onChange={(adults) => set("household_size", { ...size, adults })}
        />
        <NumberStepper
          testID="kids"
          label="Kids"
          value={size.kids}
          min={L.kids.min}
          max={L.kids.max}
          onChange={(kids) => set("household_size", { ...size, kids })}
        />
        <NumberStepper
          testID="dinners"
          label="Dinners a week"
          value={dinners}
          min={L.dinnersPerWeek.min}
          max={L.dinnersPerWeek.max}
          onChange={(value) => set("dinners_per_week", value)}
        />
      </View>
    </OnboardingFrame>
  );
}
