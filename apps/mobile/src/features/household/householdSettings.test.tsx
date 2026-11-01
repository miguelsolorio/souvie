// Household settings carries the plan setting: where it sits, what it shows for the household's
// saved mode, and who may change it. The section's own behavior is in PlanModeSection.test.
import { beforeEach, describe, expect, it, vi } from "vitest";
import HouseholdSettingsScreen from "../../../app/(app)/household/settings";
import { type RenderedScreen, renderScreen } from "../../testing/renderScreen";

type Household = {
  id: string;
  name: string;
  zip: string | null;
  role: "owner" | "member";
  plan_mode: "simple" | "full";
};

const h = vi.hoisted(() => ({
  household: { data: null as unknown, isPending: false },
  mutate: vi.fn(),
}));

vi.mock("react-native", () => import("../../testing/reactNativeStub"));
vi.mock("react-native-safe-area-context", async () => {
  const { View } = await import("../../testing/reactNativeStub");
  return { SafeAreaView: View };
});
vi.mock("expo-router", async () => {
  const { createElement } = await import("react");
  const { View } = await import("../../testing/reactNativeStub");
  return {
    Redirect: ({ href }: { href: string }) => createElement(View, { testID: "redirect", href }),
    useLocalSearchParams: () => ({}),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  };
});
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));
vi.mock("@mp/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mp/db")>()),
  useSupabase: () => ({}),
  useSession: () => ({ user: { id: "u1" } }),
  useHousehold: () => h.household,
  useHouseholdMembers: () => ({ data: [], isPending: false, isError: false }),
  useSetPlanMode: () => ({ mutate: h.mutate, isError: false, error: null }),
}));
vi.mock("../../lib/confirm", () => ({ confirmAction: vi.fn(async () => false) }));
vi.mock("./InviteSection", () => ({ InviteSection: () => null }));
vi.mock("./MemberRow", () => ({ MemberRow: () => null }));
vi.mock("../onboarding/KrogerSettingsSection", () => ({ KrogerSettingsSection: () => null }));
vi.mock("../tier3/Tier3SettingsSection", () => ({ Tier3SettingsSection: () => null }));

const household = (over: Partial<Household> = {}): Household => ({
  id: "h1",
  name: "Our kitchen",
  zip: null,
  role: "owner",
  plan_mode: "simple",
  ...over,
});

function show(value: Household | null): RenderedScreen {
  h.household.data = value;
  return renderScreen(<HouseholdSettingsScreen />);
}

const selected = (screen: RenderedScreen) =>
  ["simple", "full"].filter(
    (mode) => screen.props(`plan-mode-${mode}`).accessibilityState?.selected,
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.household.isPending = false;
});

describe("household settings", () => {
  it("has the plan setting between the household's name and its food preferences", () => {
    const screen = show(household());
    const { ids } = screen;
    expect(screen.has("plan-mode")).toBe(true);
    expect(ids.indexOf("household-name-input")).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf("household-name-input")).toBeLessThan(ids.indexOf("plan-mode"));
    expect(ids.indexOf("edit-food-preferences")).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf("plan-mode")).toBeLessThan(ids.indexOf("edit-food-preferences"));
    expect(screen.html).toContain("Planning");
    expect(screen.html).toContain("Just dinners");
    expect(screen.html).toContain("Every meal");
  });

  it("shows the household's saved mode", () => {
    expect(selected(show(household({ plan_mode: "simple" })))).toEqual(["simple"]);
    expect(selected(show(household({ plan_mode: "full" })))).toEqual(["full"]);
  });

  it("explains both modes in one line under the choice", () => {
    expect(show(household()).props("plan-mode-sentence").children).toBe(
      "Simple plans one dinner a day. Every meal adds breakfast, lunch and snacks.",
    );
  });

  it("lets the owner change it", () => {
    const screen = show(household({ role: "owner" }));
    expect(screen.props("plan-mode-full").accessibilityState?.disabled).toBe(false);
    screen.press("plan-mode-full");
    expect(h.mutate).toHaveBeenCalledWith({ householdId: "h1", mode: "full" });
  });

  it("shows a member the mode and leaves it alone", () => {
    const screen = show(household({ role: "member", plan_mode: "full" }));
    expect(selected(screen)).toEqual(["full"]);
    expect(screen.props("plan-mode-simple").accessibilityState?.disabled).toBe(true);
    expect(screen.has("plan-mode-owner-only")).toBe(true);
    screen.press("plan-mode-simple");
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it("still sends a person with no household to create one", () => {
    const screen = show(null);
    expect(screen.has("redirect")).toBe(true);
    expect(screen.has("plan-mode")).toBe(false);
  });
});
