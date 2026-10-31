import { Stepper } from "@mp/ui/primitives";
import { useDraftNumber } from "./useDraftNumber";

export const SERVINGS_MIN = 1;
export const SERVINGS_MAX = 100;

/** The servings control: how many people a meal is for. Controlled; every press calls onChange. */
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

/**
 * The servings of a planned meal. Presses show at once and are saved once, a moment after the
 * last one, so a quick run of presses is one write of the final number.
 */
export function EntryServingsStepper({
  servings,
  onCommit,
}: {
  servings: number;
  onCommit: (servings: number) => void;
}) {
  const draft = useDraftNumber(servings, onCommit);
  return <ServingsStepper value={draft.value} onChange={draft.change} />;
}
