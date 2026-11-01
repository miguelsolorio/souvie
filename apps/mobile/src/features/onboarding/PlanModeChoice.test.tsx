// The Just dinners / Every meal choice, shared by onboarding and household settings.
import { PLAN_MODES } from "@mp/core";
import { describe, expect, it, vi } from "vitest";
import { renderScreen } from "../../testing/renderScreen";
import { PLAN_MODE_CHOICES, PLAN_MODE_QUESTION, PlanModeChoice } from "./PlanModeChoice";

vi.mock("react-native", () => import("../../testing/reactNativeStub"));
vi.mock("expo-router", () => ({ useLocalSearchParams: () => ({}) }));
vi.mock("react-native-safe-area-context", async () => {
  const { View } = await import("../../testing/reactNativeStub");
  return { SafeAreaView: View };
});

describe("PlanModeChoice", () => {
  it("offers exactly the two modes, Just dinners first", () => {
    expect(PLAN_MODE_CHOICES.map((choice) => choice.value)).toEqual([...PLAN_MODES]);
    expect(PLAN_MODE_CHOICES.map((choice) => choice.label)).toEqual(["Just dinners", "Every meal"]);
    expect(PLAN_MODE_QUESTION).toBe("How much do you want to plan?");
  });

  it("marks the chosen row and only that row", () => {
    for (const value of PLAN_MODES) {
      const screen = renderScreen(<PlanModeChoice value={value} onChange={vi.fn()} />);
      for (const mode of PLAN_MODES) {
        expect(screen.props(`plan-mode-${mode}`).accessibilityState?.selected).toBe(mode === value);
      }
    }
  });

  it("reports the row that is tapped", () => {
    const onChange = vi.fn();
    const screen = renderScreen(<PlanModeChoice value="simple" onChange={onChange} />);
    screen.press("plan-mode-full");
    expect(onChange).toHaveBeenCalledWith("full");
    screen.press("plan-mode-simple");
    expect(onChange).toHaveBeenLastCalledWith("simple");
  });

  it("ignores taps when disabled, and says the rows are disabled", () => {
    const onChange = vi.fn();
    const screen = renderScreen(<PlanModeChoice value="simple" onChange={onChange} disabled />);
    expect(screen.props("plan-mode-full").accessibilityState?.disabled).toBe(true);
    screen.press("plan-mode-full");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("recommends Just dinners only when asked to", () => {
    const plain = renderScreen(<PlanModeChoice value="simple" onChange={vi.fn()} />);
    expect(plain.html).not.toContain("Recommended");
    const onboarding = renderScreen(<PlanModeChoice value="simple" onChange={vi.fn()} recommend />);
    expect(onboarding.props("plan-mode-simple").accessibilityLabel).toContain("Recommended.");
    expect(onboarding.props("plan-mode-full").accessibilityLabel).not.toContain("Recommended");
  });

  it("uses no em dash", () => {
    const screen = renderScreen(<PlanModeChoice value="simple" onChange={vi.fn()} recommend />);
    expect(screen.html).not.toContain(String.fromCharCode(0x2014));
  });
});
