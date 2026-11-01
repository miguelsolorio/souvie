import type { PlanMode } from "@mp/core";
import { Text, View } from "react-native";
import { OptionRow } from "./components";

/** The question on the first onboarding screen and in household settings. */
export const PLAN_MODE_QUESTION = "How much do you want to plan?";

/** The line under the choice in household settings. */
export const PLAN_MODE_SENTENCE =
  "Just dinners plans one dinner a day. Every meal adds breakfast, lunch and snacks.";

/** The two choices, in the order they are shown. `simple` is the default and the recommendation. */
export const PLAN_MODE_CHOICES: readonly {
  value: PlanMode;
  label: string;
  description: string;
}[] = [
  { value: "simple", label: "Just dinners", description: "One dinner a day." },
  { value: "full", label: "Every meal", description: "Breakfast, lunch, dinner and snacks." },
];

/**
 * How much the household plans: Just dinners (one dinner a day) or Every meal. Two radio rows
 * under the question. Onboarding preselects the recommended one; settings shows the saved one and
 * passes `disabled` to a member, who can read it but not change it.
 */
export function PlanModeChoice({
  value,
  onChange,
  disabled = false,
  recommend = false,
  testID = "plan-mode",
}: {
  value: PlanMode;
  onChange: (mode: PlanMode) => void;
  disabled?: boolean;
  /** Mark Just dinners as the recommended choice (onboarding). */
  recommend?: boolean;
  testID?: string;
}) {
  return (
    <View testID={testID} className="gap-2">
      <Text className="text-base font-semibold text-neutral-900">{PLAN_MODE_QUESTION}</Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={PLAN_MODE_QUESTION}
        className="gap-2"
      >
        {PLAN_MODE_CHOICES.map((choice) => (
          <OptionRow
            key={choice.value}
            testID={`${testID}-${choice.value}`}
            label={choice.label}
            description={
              recommend && choice.value === "simple"
                ? `Recommended. ${choice.description}`
                : choice.description
            }
            selected={value === choice.value}
            disabled={disabled}
            onPress={() => {
              if (!disabled) onChange(choice.value);
            }}
          />
        ))}
      </View>
    </View>
  );
}
