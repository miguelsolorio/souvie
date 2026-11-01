// Onboarding screen 1 driven the way a person drives it: the screen is rendered with
// react-test-renderer (so state changes re-render), a choice is tapped, Continue is tapped, and
// the calls behind Continue are read back in the order they happened. householdStep.test.ts
// covers the same order with fakes at the function level; this covers the screen's own wiring:
// the choice's onChange, the mode the question shows, and the mutation handed to the step.
// react-native is stood in by src/testing/reactNativeStub.tsx, which draws plain elements.
import { act, type ReactElement } from "react";
import TestRenderer, { type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HouseholdStep from "../../../app/(onboarding)/01-household";

type Existing = {
  id: string;
  name: string;
  role: "owner" | "member";
  plan_mode: "simple" | "full";
};

const INVITE = "0123456789abcdef0123456789abcdef";

const h = vi.hoisted(() => ({
  /** Every call the screen makes that matters, in the order it happens. */
  order: [] as string[],
  household: { data: null as unknown, isPending: false },
  saveStep: vi.fn(),
  goNext: vi.fn(),
  setPlanMode: vi.fn(),
  createHousehold: vi.fn(),
  redeemInvite: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("react-native", () => import("../../testing/reactNativeStub"));
vi.mock("react-native-safe-area-context", async () => {
  const { View } = await import("../../testing/reactNativeStub");
  return { SafeAreaView: View };
});
vi.mock("expo-router", () => ({ useLocalSearchParams: () => ({}) }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: h.invalidateQueries }),
}));
vi.mock("@mp/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mp/db")>()),
  useSupabase: () => ({}),
  createHousehold: (_client: unknown, name: string) => h.createHousehold(name),
  redeemInvite: (_client: unknown, token: string) => h.redeemInvite(token),
  useSetPlanMode: () => ({ mutateAsync: h.setPlanMode }),
}));
vi.mock("../auth/useSignOut", () => ({
  useSignOut: () => ({ isPending: false, isError: false, mutate: vi.fn() }),
}));
vi.mock("./useOnboarding", () => ({
  useOnboarding: () => ({ household: h.household, saveStep: h.saveStep, saving: false }),
}));
vi.mock("./useStepNav", () => ({ useStepNav: () => ({ goNext: h.goNext }) }));

// The harness for this file: React's act environment on, and the deprecation notice that
// react-test-renderer prints on every render kept out of the test output.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let screen: ReactTestRenderer | null = null;

async function show(household: Existing | null): Promise<ReactTestRenderer> {
  h.household.data = household;
  let created: ReactTestRenderer | null = null;
  await act(async () => {
    created = TestRenderer.create((<HouseholdStep />) as ReactElement);
  });
  if (!created) throw new Error("the screen did not render");
  screen = created;
  return created;
}

/** The elements that carry a `testID` and a handler, as the stand-in components pass them on. */
function handlerOf(root: ReactTestRenderer, testID: string, handler: "onPress" | "onChangeText") {
  const matches: ReactTestInstance[] = root.root.findAll(
    (node) => node.props.testID === testID && typeof node.props[handler] === "function",
  );
  const first = matches[0];
  if (!first) throw new Error(`nothing with testID "${testID}" has ${handler} on screen`);
  return first.props[handler] as (arg?: string) => void;
}

async function press(root: ReactTestRenderer, testID: string) {
  const onPress = handlerOf(root, testID, "onPress");
  await act(async () => {
    onPress();
  });
}

async function type(root: ReactTestRenderer, testID: string, text: string) {
  const onChangeText = handlerOf(root, testID, "onChangeText");
  await act(async () => {
    onChangeText(text);
  });
}

const has = (root: ReactTestRenderer, testID: string) =>
  root.root.findAll((node) => node.props.testID === testID).length > 0;

const propsOf = (root: ReactTestRenderer, testID: string) => {
  // Wrapper components (OptionRow, Button) pass their testID down: the last match is the element
  // the stand-in finally draws, with the props it was given.
  const found = root.root.findAll((node) => node.props.testID === testID);
  const last = found[found.length - 1];
  if (!last) throw new Error(`nothing with testID "${testID}" on screen`);
  return last.props as Record<string, unknown> & {
    accessibilityState?: { selected?: boolean };
    disabled?: boolean;
  };
};

const selectedModes = (root: ReactTestRenderer) =>
  (["simple", "full"] as const).filter(
    (mode) => propsOf(root, `plan-mode-${mode}`).accessibilityState?.selected,
  );

/** Continue, then wait for the step to have been saved and the screen to move on. */
async function continueAndWait(root: ReactTestRenderer) {
  await press(root, "onboarding-continue");
  await act(async () => {
    await vi.waitFor(() => expect(h.goNext).toHaveBeenCalled());
  });
}

const owner = (plan_mode: Existing["plan_mode"] = "simple"): Existing => ({
  id: "h1",
  name: "Our kitchen",
  role: "owner",
  plan_mode,
});
const member = (plan_mode: Existing["plan_mode"] = "simple"): Existing => ({
  id: "h1",
  name: "Our kitchen",
  role: "member",
  plan_mode,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  h.order.length = 0;
  h.household.isPending = false;
  h.household.data = null;
  h.createHousehold.mockImplementation(async (name: string) => {
    h.order.push(`create:${name}`);
    return "h-new";
  });
  h.redeemInvite.mockImplementation(async (token: string) => {
    h.order.push(`redeem:${token}`);
    return "h-joined";
  });
  h.invalidateQueries.mockImplementation(async ({ queryKey }: { queryKey: string[] }) => {
    h.order.push(`reload:${queryKey[0]}`);
  });
  h.setPlanMode.mockImplementation(async ({ householdId, mode }) => {
    h.order.push(`mode:${householdId}:${mode}`);
  });
  h.saveStep.mockImplementation(async ({ step }: { step: number }) => {
    h.order.push(`save:${step}`);
  });
  h.goNext.mockImplementation(() => {
    h.order.push("next");
  });
});

afterEach(async () => {
  const mounted = screen;
  screen = null;
  if (mounted) {
    await act(async () => {
      mounted.unmount();
    });
  }
  vi.restoreAllMocks();
});

describe("creating a household and picking Every meal", () => {
  it("writes full after the household is reloaded and before the step is saved", async () => {
    const root = await show(null);
    expect(selectedModes(root)).toEqual(["simple"]);

    await type(root, "household-name", "Our kitchen");
    expect(propsOf(root, "onboarding-continue").disabled).toBe(false);

    await press(root, "plan-mode-full");
    expect(selectedModes(root)).toEqual(["full"]);

    await continueAndWait(root);

    expect(h.setPlanMode).toHaveBeenCalledTimes(1);
    expect(h.setPlanMode).toHaveBeenCalledWith({ householdId: "h-new", mode: "full" });
    expect(h.order).toEqual([
      "create:Our kitchen",
      "reload:household",
      "reload:household-members",
      "mode:h-new:full",
      "save:1",
      "next",
    ]);
  });

  it("writes nothing when the preselected Just dinners is kept", async () => {
    const root = await show(null);
    await type(root, "household-name", "Our kitchen");
    await continueAndWait(root);

    expect(h.setPlanMode).not.toHaveBeenCalled();
    expect(h.order).toEqual([
      "create:Our kitchen",
      "reload:household",
      "reload:household-members",
      "save:1",
      "next",
    ]);
  });

  it("writes nothing when the person picks Every meal and then changes their mind", async () => {
    const root = await show(null);
    await type(root, "household-name", "Our kitchen");
    await press(root, "plan-mode-full");
    await press(root, "plan-mode-simple");
    expect(selectedModes(root)).toEqual(["simple"]);
    await continueAndWait(root);

    expect(h.setPlanMode).not.toHaveBeenCalled();
  });

  it("stays on the screen and keeps the pick when the mode write fails, so Continue can try again", async () => {
    h.setPlanMode.mockRejectedValueOnce(new Error("offline"));
    const root = await show(null);
    await type(root, "household-name", "Our kitchen");
    await press(root, "plan-mode-full");

    await press(root, "onboarding-continue");
    await act(async () => {
      await vi.waitFor(() => expect(h.setPlanMode).toHaveBeenCalledTimes(1));
    });
    expect(h.goNext).not.toHaveBeenCalled();
    expect(h.saveStep).not.toHaveBeenCalled();
    expect(selectedModes(root)).toEqual(["full"]);
  });
});

describe("joining with an invite", () => {
  it("takes the question away, and a pick made before switching never reaches the household", async () => {
    const root = await show(null);
    await press(root, "plan-mode-full");
    expect(has(root, "plan-mode")).toBe(true);

    await press(root, "household-mode-join");
    expect(has(root, "plan-mode")).toBe(false);
    expect(has(root, "plan-mode-full")).toBe(false);

    await type(root, "invite-input", INVITE);
    await continueAndWait(root);

    expect(h.setPlanMode).not.toHaveBeenCalled();
    expect(h.order).toEqual([
      `redeem:${INVITE}`,
      "reload:household",
      "reload:household-members",
      "save:1",
      "next",
    ]);
  });

  it("brings the question back when the person switches to creating", async () => {
    const root = await show(null);
    await press(root, "household-mode-join");
    expect(has(root, "plan-mode")).toBe(false);
    await press(root, "household-mode-create");
    expect(has(root, "plan-mode")).toBe(true);
    expect(selectedModes(root)).toEqual(["simple"]);
  });
});

describe("an owner who already has a household", () => {
  it("picks Every meal and writes full for their household before the step is saved", async () => {
    const root = await show(owner("simple"));
    expect(selectedModes(root)).toEqual(["simple"]);

    await press(root, "plan-mode-full");
    expect(selectedModes(root)).toEqual(["full"]);

    await continueAndWait(root);

    expect(h.setPlanMode).toHaveBeenCalledTimes(1);
    expect(h.setPlanMode).toHaveBeenCalledWith({ householdId: "h1", mode: "full" });
    expect(h.createHousehold).not.toHaveBeenCalled();
    expect(h.order).toEqual(["mode:h1:full", "save:1", "next"]);
  });

  it("goes back to Just dinners from a saved Every meal", async () => {
    const root = await show(owner("full"));
    expect(selectedModes(root)).toEqual(["full"]);

    await press(root, "plan-mode-simple");
    await continueAndWait(root);

    expect(h.setPlanMode).toHaveBeenCalledWith({ householdId: "h1", mode: "simple" });
    expect(h.order).toEqual(["mode:h1:simple", "save:1", "next"]);
  });

  it("writes nothing when the saved mode is left alone", async () => {
    const root = await show(owner("full"));
    await continueAndWait(root);

    expect(h.setPlanMode).not.toHaveBeenCalled();
    expect(h.order).toEqual(["save:1", "next"]);
  });
});

describe("a member of the household", () => {
  it("is not asked, and Continue saves the step without touching the mode", async () => {
    const root = await show(member("full"));
    expect(has(root, "plan-mode")).toBe(false);
    expect(has(root, "plan-mode-full")).toBe(false);

    await continueAndWait(root);

    expect(h.setPlanMode).not.toHaveBeenCalled();
    expect(h.order).toEqual(["save:1", "next"]);
  });
});
