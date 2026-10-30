import {
  EQUIPMENT_OPTIONS,
  PREFERENCE_LIMITS,
  SKILLS,
  TimeSkillInput,
  timeSkillToPreferences,
} from "@mp/core";
import { useState } from "react";
import { View } from "react-native";
import {
  Chip,
  ChipGroup,
  NumberStepper,
  OnboardingFrame,
  OptionRow,
  SectionLabel,
} from "../../src/features/onboarding/components";
import { titleCase } from "../../src/features/onboarding/labels";
import { toggleItem } from "../../src/features/onboarding/onboardingState";
import { useOnboarding } from "../../src/features/onboarding/useOnboarding";
import { usePreferencesDraft } from "../../src/features/onboarding/usePreferencesDraft";
import { useStepNav } from "../../src/features/onboarding/useStepNav";

const L = PREFERENCE_LIMITS;
const PRESETS = [15, 30, 45, 60, 90];

const SKILL_TEXT: Record<(typeof SKILLS)[number], { label: string; description: string }> = {
  beginner: { label: "Beginner", description: "Simple steps, few techniques." },
  comfortable: { label: "Comfortable", description: "Most weeknight recipes are fine." },
  confident: { label: "Confident", description: "Bring on the long recipes." },
};

/** Screen 5: how long a weeknight dinner may take, cooking skill, and equipment. */
export default function TimeSkillStep() {
  const { saved, saveStep, saving } = useOnboarding();
  const { draft, set, update } = usePreferencesDraft(saved);
  const { goNext, goBack } = useStepNav(5);
  const [error, setError] = useState<string | null>(null);

  const minutes = draft.weeknight_minutes ?? 45;
  const skill = draft.skill ?? "comfortable";
  const equipment = draft.equipment ?? [];

  function toggleEquipment(item: string) {
    update("equipment", (current) => toggleItem(current, item));
  }

  async function submit() {
    setError(null);
    const parsed = TimeSkillInput.safeParse({ weeknight_minutes: minutes, skill, equipment });
    if (!parsed.success) {
      setError(
        `Weeknight time must be ${L.weeknightMinutes.min} to ${L.weeknightMinutes.max} minutes.`,
      );
      return;
    }
    try {
      await saveStep({ step: 5, patch: timeSkillToPreferences(parsed.data) });
      goNext();
    } catch {
      setError("We could not save that. Try again.");
    }
  }

  return (
    <OnboardingFrame
      step={5}
      title="Time and skill"
      subtitle="Dinners we suggest will fit the time you have on a weeknight."
      onBack={goBack}
      onContinue={() => void submit()}
      busy={saving}
      error={error}
    >
      <View className="gap-3">
        <SectionLabel>Weeknight dinner time</SectionLabel>
        <NumberStepper
          testID="minutes"
          label="Minutes"
          value={minutes}
          min={L.weeknightMinutes.min}
          max={L.weeknightMinutes.max}
          step={5}
          onChange={(value) => set("weeknight_minutes", value)}
        />
        <ChipGroup>
          {PRESETS.map((preset) => (
            <Chip
              key={preset}
              testID={`minutes-${preset}`}
              label={`${preset} min`}
              selected={minutes === preset}
              onPress={() => set("weeknight_minutes", preset)}
            />
          ))}
        </ChipGroup>
      </View>

      <View className="gap-3">
        <SectionLabel>Cooking skill</SectionLabel>
        <View accessibilityRole="radiogroup" className="gap-2">
          {SKILLS.map((level) => (
            <OptionRow
              key={level}
              testID={`skill-${level}`}
              label={SKILL_TEXT[level].label}
              description={SKILL_TEXT[level].description}
              selected={skill === level}
              onPress={() => set("skill", level)}
            />
          ))}
        </View>
      </View>

      <View className="gap-3">
        <SectionLabel>Equipment you have</SectionLabel>
        <ChipGroup>
          {EQUIPMENT_OPTIONS.map((item) => (
            <Chip
              key={item}
              testID={`equipment-${item}`}
              label={titleCase(item)}
              selected={equipment.includes(item)}
              onPress={() => toggleEquipment(item)}
            />
          ))}
        </ChipGroup>
      </View>
    </OnboardingFrame>
  );
}
