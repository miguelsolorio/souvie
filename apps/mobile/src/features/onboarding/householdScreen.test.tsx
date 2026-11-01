// Onboarding screen 1, "Your household": who sees the plan question and what Continue does with
// it. The screen is rendered to markup with react-native stood in by src/testing, so these tests
// cover what is on screen for a given household and what its buttons call. The order of the calls
// behind Continue (create, reload, write the mode, save the step) is covered in householdStep.test.
import { beforeEach, describe, expect, it, vi } from "vitest";
import HouseholdStep from "../../../app/(onboarding)/01-household";
import { type RenderedScreen, renderScreen } from "../../testing/renderScreen";
import { PLAN_MODE_QUESTION } from "./PlanModeChoice";

type Existing = {
  id: string;
  name: string;
  role: "owner" | "member";
  plan_mode: "simple" | "full";
};

const h = vi.hoisted(() => ({
  household: {
    data: null as unknown,
    isPending: false,
  },
  saveStep: vi.fn(),
  goNext: vi.fn(),
  setPlanMode: vi.fn(),
}));

vi.mock("react-native", () => import("../../testing/reactNativeStub"));
vi.mock("react-native-safe-area-context", async () => {
  const { View } = await import("../../testing/reactNativeStub");
  return { SafeAreaView: View };
});
vi.mock("expo-router", () => ({ useLocalSearchParams: () => ({}) }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(async () => undefined) }),
}));
vi.mock("@mp/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mp/db")>()),
  useSupabase: () => ({}),
  useSetPlanMode: () => ({ mutateAsync: h.setPlanMode }),
}));
vi.mock("../auth/useSignOut", () => ({
  useSignOut: () => ({ isPending: false, isError: false, mutate: vi.fn() }),
}));
vi.mock("./useOnboarding", () => ({
  useOnboarding: () => ({ household: h.household, saveStep: h.saveStep, saving: false }),
}));
vi.mock("./useStepNav", () => ({ useStepNav: () => ({ goNext: h.goNext }) }));

const owns = (plan_mode: Existing["plan_mode"] = "simple"): Existing => ({
  id: "h1",
  name: "Our kitchen",
  role: "owner",
  plan_mode,
});
const joined = (plan_mode: Existing["plan_mode"] = "simple"): Existing => ({
  id: "h1",
  name: "Our kitchen",
  role: "member",
  plan_mode,
});

function show(household: Existing | null): RenderedScreen {
  h.household.data = household;
  return renderScreen(<HouseholdStep />);
}

const selected = (screen: RenderedScreen) =>
  ["simple", "full"].filter(
    (mode) => screen.props(`plan-mode-${mode}`).accessibilityState?.selected,
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.household.isPending = false;
  h.saveStep.mockResolvedValue(undefined);
  h.setPlanMode.mockResolvedValue(undefined);
});

describe("the plan question", () => {
  it("is on screen for a person setting up a household, with Just dinners preselected", () => {
    const screen = show(null);
    expect(screen.has("plan-mode")).toBe(true);
    expect(screen.html).toContain(PLAN_MODE_QUESTION);
    expect(PLAN_MODE_QUESTION).toBe("How much do you want to plan?");
    expect(selected(screen)).toEqual(["simple"]);
    // The household form is still there, and the question sits under it.
    expect(screen.has("household-name")).toBe(true);
    expect(screen.ids.indexOf("household-name")).toBeLessThan(screen.ids.indexOf("plan-mode"));
  });

  it("offers the two choices, Just dinners recommended", () => {
    const screen = show(null);
    expect(screen.props("plan-mode-simple").accessibilityLabel).toBe(
      "Just dinners. Recommended. One dinner a day.",
    );
    expect(screen.props("plan-mode-full").accessibilityLabel).toBe(
      "Every meal. Breakfast, lunch, dinner and snacks.",
    );
  });

  it("is on screen for the owner of the household they are in, showing its saved mode", () => {
    const simple = show(owns("simple"));
    expect(simple.has("plan-mode")).toBe(true);
    expect(simple.props("household-existing-name").children).toBe("Our kitchen");
    expect(selected(simple)).toEqual(["simple"]);

    const full = show(owns("full"));
    expect(full.has("plan-mode")).toBe(true);
    expect(selected(full)).toEqual(["full"]);
  });

  it("is not on screen for a member who joined an existing household", () => {
    const screen = show(joined("full"));
    expect(screen.has("plan-mode")).toBe(false);
    expect(screen.has("plan-mode-simple")).toBe(false);
    expect(screen.has("plan-mode-full")).toBe(false);
    expect(screen.html).not.toContain(PLAN_MODE_QUESTION);
    expect(screen.props("household-existing-name").children).toBe("Our kitchen");
  });

  it("uses no em dash", () => {
    expect(show(null).html).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("Continue", () => {
  it("saves the step and moves on for a member, without touching the mode", async () => {
    const screen = show(joined("full"));
    screen.press("onboarding-continue");
    await vi.waitFor(() => expect(h.goNext).toHaveBeenCalledTimes(1));
    expect(h.saveStep).toHaveBeenCalledWith({ step: 1 });
    expect(h.setPlanMode).not.toHaveBeenCalled();
  });

  it("leaves the saved mode alone for an owner who did not change it", async () => {
    const screen = show(owns("full"));
    screen.press("onboarding-continue");
    await vi.waitFor(() => expect(h.goNext).toHaveBeenCalledTimes(1));
    expect(h.setPlanMode).not.toHaveBeenCalled();
  });

  it("does not move on when the step cannot be saved", async () => {
    h.saveStep.mockRejectedValue(new Error("offline"));
    const screen = show(owns());
    screen.press("onboarding-continue");
    await vi.waitFor(() => expect(h.saveStep).toHaveBeenCalled());
    expect(h.goNext).not.toHaveBeenCalled();
  });
});

describe("loading", () => {
  it("shows a loading screen until the household is known", () => {
    h.household.isPending = true;
    const screen = show(null);
    expect(screen.has("plan-mode")).toBe(false);
    expect(screen.has("onboarding-continue")).toBe(false);
  });
});
