import { Stepper } from "@mp/ui/primitives";

export const SERVINGS_MIN = 1;
export const SERVINGS_MAX = 100;

/**
 * The servings control: how many people this meal is for. It writes on every press (the planner
 * saves in the background and queues quick presses in order), so the number on screen is always
 * the number the household sees.
 */
export function ServingsStepper({
  value,
  onChange,
  disabled = false,
  testID = "servings-stepper",
}: {
  value: number;
  onChange: (servings: number) => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Stepper
      testID={testID}
      label="Servings"
      unit="serving"
      unitPlural="servings"
      value={value}
      min={SERVINGS_MIN}
      max={SERVINGS_MAX}
      step={1}
      disabled={disabled}
      onChange={onChange}
    />
  );
}
