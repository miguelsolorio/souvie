import type { RecipeDraft } from "@mp/db";
import { useState } from "react";
import { View } from "react-native";
import { Button } from "../../components/Button";
import { ErrorText } from "../../components/Screen";
import { TextField } from "../../components/TextField";
import { draftFromForm, type ExistingLine, type FormState, formErrors, hasErrors } from "./draft";
import { MultilineField } from "./MultilineField";

/**
 * The recipe form, shared by the edit screen, the manual tab, and the review of a photo or caption
 * draft. It owns the text boxes; the parent owns saving. `existing` lets the ingredients box keep
 * the parsed fields of lines the person leaves alone.
 */
export function RecipeForm({
  initial,
  existing = [],
  submitLabel,
  submitting,
  error,
  onSubmit,
  onCancel,
  cancelLabel = "Cancel",
}: {
  initial: FormState;
  existing?: readonly ExistingLine[];
  submitLabel: string;
  submitting: boolean;
  /** A save error from the parent. */
  error?: string | null;
  onSubmit: (draft: RecipeDraft) => void;
  onCancel?: () => void;
  cancelLabel?: string;
}) {
  const [form, setForm] = useState<FormState>(initial);
  const [attempted, setAttempted] = useState(false);
  const errors = attempted ? formErrors(form) : {};

  const set = (key: keyof FormState) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  function submit() {
    setAttempted(true);
    if (hasErrors(formErrors(form))) return;
    onSubmit(draftFromForm(form, existing));
  }

  return (
    <View className="gap-5">
      <TextField
        label="Title"
        value={form.title}
        onChangeText={set("title")}
        error={errors.title}
        maxLength={200}
        testID="recipe-title-input"
      />
      <MultilineField
        label="Description"
        value={form.description}
        onChangeText={set("description")}
        lines={3}
        maxLength={4000}
        helper="Optional."
      />
      <View className="flex-row gap-3">
        <View className="flex-1">
          <TextField
            label="Servings"
            value={form.servings}
            onChangeText={set("servings")}
            keyboardType="numbers-and-punctuation"
            error={errors.servings}
            testID="recipe-servings-input"
          />
        </View>
        <View className="flex-1">
          <TextField
            label="Prep (min)"
            value={form.prepMin}
            onChangeText={set("prepMin")}
            keyboardType="number-pad"
            error={errors.prepMin}
          />
        </View>
        <View className="flex-1">
          <TextField
            label="Cook (min)"
            value={form.cookMin}
            onChangeText={set("cookMin")}
            keyboardType="number-pad"
            error={errors.cookMin}
          />
        </View>
      </View>
      <MultilineField
        label="Ingredients"
        value={form.ingredients}
        onChangeText={set("ingredients")}
        lines={8}
        error={errors.ingredients}
        helper={
          'One per line, as written ("2 cups flour"). Start a line with # for a heading such as "# For the sauce".'
        }
        testID="recipe-ingredients-input"
      />
      <MultilineField
        label="Steps"
        value={form.steps}
        onChangeText={set("steps")}
        lines={8}
        helper="One step per line."
        testID="recipe-steps-input"
      />
      <TextField
        label="Cuisine"
        value={form.cuisine}
        onChangeText={set("cuisine")}
        autoCapitalize="none"
        maxLength={80}
        helper="Optional, for example italian."
      />
      <TextField
        label="Tags"
        value={form.tags}
        onChangeText={set("tags")}
        autoCapitalize="none"
        helper="Separate with commas."
      />
      <ErrorText>{errors.form ?? error}</ErrorText>
      <View className="gap-3">
        <Button testID="recipe-save" label={submitLabel} loading={submitting} onPress={submit} />
        {onCancel ? (
          <Button label={cancelLabel} variant="ghost" onPress={onCancel} disabled={submitting} />
        ) : null}
      </View>
    </View>
  );
}
