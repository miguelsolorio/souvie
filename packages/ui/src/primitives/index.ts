// Primitives (WS04): Sheet, Stepper, SegmentedControl, EmptyState.
//
// Import them from "@mp/ui/primitives", not from "@mp/ui": the package root also loads in Node
// (tailwind.preset.js, the marketing site's sync script), and these files need react-native.
export { EmptyState, type EmptyStateProps } from "./EmptyState";
export {
  canStep,
  clamp,
  formatStepValue,
  MIN_TARGET,
  nextSegment,
  SHEET_DIALOG_MIN_WIDTH,
  type SheetLayout,
  type StepBounds,
  sheetLayout,
  stepperSpeech,
  stepValue,
} from "./logic";
export {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentOption,
} from "./SegmentedControl";
export { Sheet, type SheetProps } from "./Sheet";
export { Stepper, type StepperProps } from "./Stepper";
