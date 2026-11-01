// The plan setting in household settings: the owner changes it with a tap, a member only reads it.
// The harness renders once, so a change is shown the way the app shows it: the cache switches the
// household's mode, and the section is drawn again with the new value.
import { IdentityError } from "@mp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type RenderedScreen, renderScreen } from "../../testing/renderScreen";
import { PLAN_MODE_SENTENCE } from "../onboarding/PlanModeChoice";
import { PlanModeSection } from "./PlanModeSection";

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  update: { isError: false, error: null as unknown },
}));

vi.mock("react-native", () => import("../../testing/reactNativeStub"));
vi.mock("react-native-safe-area-context", async () => {
  const { View } = await import("../../testing/reactNativeStub");
  return { SafeAreaView: View };
});
vi.mock("expo-router", () => ({ useLocalSearchParams: () => ({}) }));
vi.mock("@mp/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mp/db")>()),
  useSetPlanMode: () => ({ mutate: h.mutate, ...h.update }),
}));

const section = (mode: "simple" | "full", isOwner = true): RenderedScreen =>
  renderScreen(<PlanModeSection householdId="h1" mode={mode} isOwner={isOwner} />);

const selected = (screen: RenderedScreen) =>
  ["simple", "full"].filter(
    (mode) => screen.props(`plan-mode-${mode}`).accessibilityState?.selected,
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.update.isError = false;
  h.update.error = null;
});

describe("for the owner", () => {
  it("shows the saved mode and the sentence that explains both", () => {
    const screen = section("simple");
    expect(screen.html).toContain("Planning");
    expect(screen.html).toContain("How much do you want to plan?");
    expect(selected(screen)).toEqual(["simple"]);
    expect(screen.props("plan-mode-sentence").children).toBe(
      "Simple plans one dinner a day. Every meal adds breakfast, lunch and snacks.",
    );
    expect(PLAN_MODE_SENTENCE).toBe(
      "Simple plans one dinner a day. Every meal adds breakfast, lunch and snacks.",
    );
    expect(screen.has("plan-mode-owner-only")).toBe(false);
    expect(screen.props("plan-mode-simple").accessibilityState?.disabled).toBe(false);
  });

  it("switches to Every meal with one tap", () => {
    section("simple").press("plan-mode-full");
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.mutate).toHaveBeenCalledWith({ householdId: "h1", mode: "full" });
  });

  it("round-trips: once the household says full, the choice shows full and switches back", () => {
    section("simple").press("plan-mode-full");
    expect(h.mutate).toHaveBeenLastCalledWith({ householdId: "h1", mode: "full" });

    const afterSwitch = section("full");
    expect(selected(afterSwitch)).toEqual(["full"]);
    afterSwitch.press("plan-mode-simple");
    expect(h.mutate).toHaveBeenLastCalledWith({ householdId: "h1", mode: "simple" });

    const afterSwitchBack = section("simple");
    expect(selected(afterSwitchBack)).toEqual(["simple"]);
    expect(h.mutate).toHaveBeenCalledTimes(2);
  });

  it("does not write when the choice is the one already saved", () => {
    section("simple").press("plan-mode-simple");
    section("full").press("plan-mode-full");
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it("says why when the change is refused, in plain words", () => {
    h.update.isError = true;
    h.update.error = new IdentityError("not_owner");
    expect(section("simple").html).toContain("Only the household owner can do that.");
  });

  it("says nothing about errors when there are none", () => {
    expect(section("simple").html).not.toContain("went wrong");
  });
});

describe("for a member", () => {
  it("shows the mode but not as something to change", () => {
    const screen = section("full", false);
    expect(selected(screen)).toEqual(["full"]);
    expect(screen.props("plan-mode-simple").accessibilityState?.disabled).toBe(true);
    expect(screen.props("plan-mode-full").accessibilityState?.disabled).toBe(true);
    expect(screen.props("plan-mode-owner-only").children).toBe("Only the owner can change this.");
    expect(screen.has("plan-mode-sentence")).toBe(true);
  });

  it("writes nothing, however the rows are tapped", () => {
    const screen = section("simple", false);
    screen.press("plan-mode-full");
    screen.press("plan-mode-simple");
    expect(h.mutate).not.toHaveBeenCalled();
  });
});

describe("copy", () => {
  it("has no em dash", () => {
    const emDash = String.fromCharCode(0x2014);
    expect(section("simple").html).not.toContain(emDash);
    expect(section("full", false).html).not.toContain(emDash);
  });
});
