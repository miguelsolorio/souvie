import {
  CUISINE_OPTIONS,
  DislikesCuisinesInput,
  dislikesCuisinesToPreferences,
  PREFERENCE_LIMITS,
} from "@mp/core";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Button } from "../../src/components/Button";
import { TextField } from "../../src/components/TextField";
import {
  Chip,
  ChipGroup,
  Note,
  OnboardingFrame,
  SectionLabel,
} from "../../src/features/onboarding/components";
import { titleCase } from "../../src/features/onboarding/labels";
import { toggleItem } from "../../src/features/onboarding/onboardingState";
import { useIngredientSuggestions } from "../../src/features/onboarding/useIngredientSuggestions";
import { useOnboarding } from "../../src/features/onboarding/useOnboarding";
import { usePreferencesDraft } from "../../src/features/onboarding/usePreferencesDraft";
import { useStepNav } from "../../src/features/onboarding/useStepNav";

const MAX = PREFERENCE_LIMITS.dislikes.maxItems;

/** Screen 4: foods they will not eat (with ingredient autocomplete) and favorite cuisines. */
export default function DislikesCuisinesStep() {
  const { saved, saveStep, saving } = useOnboarding();
  const { draft, update } = usePreferencesDraft(saved);
  const { goNext, goBack } = useStepNav(4);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  const dislikes = draft.dislikes ?? [];
  const cuisines = draft.cuisines ?? [];
  const suggestions = useIngredientSuggestions(typed);
  const atLimit = dislikes.length >= MAX;

  function add(text: string) {
    const value = text.trim().toLowerCase().replace(/\s+/g, " ");
    if (value.length < 2 || atLimit) return;
    update("dislikes", (current) =>
      (current ?? []).includes(value) ? (current ?? []) : [...(current ?? []), value],
    );
    setTyped("");
  }

  function remove(item: string) {
    update("dislikes", (current) => (current ?? []).filter((d) => d !== item));
  }

  function toggleCuisine(cuisine: string) {
    update("cuisines", (current) => toggleItem(current, cuisine));
  }

  async function submit() {
    setError(null);
    const parsed = DislikesCuisinesInput.safeParse({ dislikes, cuisines });
    if (!parsed.success) {
      setError(`Keep it to ${MAX} foods, and each one to 60 characters.`);
      return;
    }
    try {
      await saveStep({ step: 4, patch: dislikesCuisinesToPreferences(parsed.data) });
      goNext();
    } catch {
      setError("We could not save that. Try again.");
    }
  }

  const options = (suggestions.data ?? []).filter((name) => !dislikes.includes(name));

  return (
    <OnboardingFrame
      step={4}
      title="What do you avoid, and what do you love?"
      subtitle="Skip any food you will not eat, and pick the cuisines you cook most. Both are optional."
      onBack={goBack}
      onContinue={() => void submit()}
      busy={saving}
      error={error}
    >
      <View className="gap-3">
        <SectionLabel>Foods you will not eat</SectionLabel>
        <TextField
          label="Add a food"
          value={typed}
          onChangeText={setTyped}
          placeholder="cilantro, mushrooms, olives"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!atLimit}
          returnKeyType="done"
          onSubmitEditing={() => add(typed)}
          helper={atLimit ? `That is the limit of ${MAX}.` : "Pick a suggestion or press Add."}
          testID="dislike-input"
        />
        {options.length > 0 ? (
          <View
            accessibilityRole="list"
            className="overflow-hidden rounded-xl border border-neutral-200"
          >
            {options.map((name) => (
              <Pressable
                key={name}
                testID={`suggestion-${name}`}
                accessibilityRole="button"
                accessibilityLabel={`Add ${name}`}
                onPress={() => add(name)}
                className="min-h-11 justify-center border-b border-neutral-100 px-4 py-2"
              >
                <Text className="text-base text-neutral-900">{name}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <Button
          testID="dislike-add"
          label="Add"
          variant="secondary"
          disabled={typed.trim().length < 2 || atLimit}
          onPress={() => add(typed)}
        />
        {dislikes.length > 0 ? (
          <ChipGroup>
            {dislikes.map((item) => (
              <Chip
                key={item}
                testID={`dislike-${item}`}
                label={`${item}  x`}
                selected
                onPress={() => remove(item)}
              />
            ))}
          </ChipGroup>
        ) : null}
        <Note>
          {dislikes.length} of {MAX}. Tap a food to remove it. We leave out recipes that list it.
        </Note>
      </View>

      <View className="gap-3">
        <SectionLabel>Favorite cuisines</SectionLabel>
        <ChipGroup>
          {CUISINE_OPTIONS.map((cuisine) => (
            <Chip
              key={cuisine}
              testID={`cuisine-${cuisine}`}
              label={titleCase(cuisine)}
              selected={cuisines.includes(cuisine)}
              onPress={() => toggleCuisine(cuisine)}
            />
          ))}
        </ChipGroup>
      </View>
    </OnboardingFrame>
  );
}
