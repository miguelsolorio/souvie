// The add-recipe route reads the picker's return target from its URL params and hands it to the
// AddRecipe body. The route's own parts (household gate, title) are covered by use; this covers
// the one new thing it does.
import { beforeEach, describe, expect, it, vi } from "vitest";
import NewRecipeScreen from "../../../app/(app)/recipes/new";
import { renderScreen } from "../../testing/renderScreen";
import { newRecipeFromPickerRoute } from "../plan/routes";

const h = vi.hoisted(() => ({
  params: {} as Record<string, string | string[]>,
  household: { data: { id: "h1" } as { id: string } | null, isPending: false },
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
    Stack: { Screen: () => null },
    useLocalSearchParams: () => h.params,
  };
});
vi.mock("@mp/db", () => ({ useHousehold: () => h.household }));
vi.mock("./AddRecipe", async () => {
  const { createElement } = await import("react");
  const { View } = await import("../../testing/reactNativeStub");
  return {
    AddRecipe: (props: { returnTo?: unknown }) =>
      createElement(View, { testID: "add-recipe", returnTo: props.returnTo }),
  };
});

function paramsOf(route: string): Record<string, string> {
  return Object.fromEntries(new URL(route, "https://app.test").searchParams);
}

beforeEach(() => {
  h.params = {};
  h.household.data = { id: "h1" };
  h.household.isPending = false;
});

describe("the add-recipe route", () => {
  it("passes the picker's date, slot and swap target on as the return target", () => {
    h.params = paramsOf(
      newRecipeFromPickerRoute({ date: "2026-11-03", slot: "lunch", entry: "e1" }),
    );
    const screen = renderScreen(<NewRecipeScreen />);
    expect(screen.props("add-recipe").returnTo).toEqual({
      date: "2026-11-03",
      slot: "lunch",
      entry: "e1",
    });
  });

  it("has no return target when opened from the Recipes tab", () => {
    h.params = {};
    expect(renderScreen(<NewRecipeScreen />).props("add-recipe").returnTo).toBeNull();
  });

  it("has no return target for params that do not describe a picker", () => {
    h.params = { returnTo: "pick", date: "someday", slot: "dinner" };
    expect(renderScreen(<NewRecipeScreen />).props("add-recipe").returnTo).toBeNull();
    h.params = { returnTo: "pick", date: ["2026-11-03", "2026-11-04"], slot: "dinner" };
    expect(renderScreen(<NewRecipeScreen />).props("add-recipe").returnTo).toBeNull();
  });

  it("still sends a person with no household to create one", () => {
    h.household.data = null;
    const screen = renderScreen(<NewRecipeScreen />);
    expect(screen.has("redirect")).toBe(true);
    expect(screen.has("add-recipe")).toBe(false);
  });
});
