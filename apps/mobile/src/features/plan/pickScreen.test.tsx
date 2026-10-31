// The recipe picker screen (WS04 follow-up: recipe entry points). The screen is rendered to markup
// with react-native stood in by src/testing/reactNativeStub.tsx and the data hooks mocked, so these
// tests cover what it shows for given data and what its buttons call. See renderScreen.ts for what
// that can and cannot reach.
import type { RecipeSummary } from "@mp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PickRecipeScreen from "../../../app/(app)/plan/pick";
import { type RenderedScreen, renderScreen } from "../../testing/renderScreen";
import { TAB_EMPTY } from "./pickerSearch";
import { parsePickerReturn } from "./routes";

const h = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  router: { push: vi.fn(), replace: vi.fn(), back: vi.fn(), dismissTo: vi.fn() },
  household: { data: { id: "h1" } as { id: string } | null, isPending: false },
  recipes: {
    data: [] as unknown[] | undefined,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  },
  recent: { data: [] as string[] | undefined, isLoading: false },
  favorites: { data: [] as string[] | undefined },
  week: { plan: null as unknown, entries: [] as unknown[] },
  actions: { addRecipe: vi.fn(), swapRecipe: vi.fn() },
  useRecipes: vi.fn(),
}));

vi.mock("react-native", () => import("../../testing/reactNativeStub"));

vi.mock("react-native-safe-area-context", async () => {
  const { View } = await import("../../testing/reactNativeStub");
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  };
});

vi.mock("expo-router", async () => {
  const { createElement } = await import("react");
  const { View } = await import("../../testing/reactNativeStub");
  return {
    Redirect: ({ href }: { href: string }) => createElement(View, { testID: "redirect", href }),
    Stack: { Screen: () => null },
    useLocalSearchParams: () => h.params,
    useRouter: () => h.router,
  };
});

vi.mock("@mp/db", () => ({
  useHousehold: () => h.household,
  useRecipes: (...args: unknown[]) => {
    h.useRecipes(...args);
    return h.recipes;
  },
  useRecentRecipeIds: () => h.recent,
  useFavoriteRecipeIds: () => h.favorites,
  useMealPlanEntries: () => ({ data: [] }),
  useRecipeImageUrl: () => null,
}));

vi.mock("./usePlanWeek", () => ({ usePlanWeek: () => h.week }));
vi.mock("./usePlanActions", () => ({
  usePlanActions: () => h.actions,
  useDefaultServings: () => (recipeServings: number | null | undefined) => recipeServings ?? 4,
}));

const recipe = (id: string, title: string, over: Partial<RecipeSummary> = {}): RecipeSummary => ({
  id,
  household_id: "h1",
  visibility: "household",
  title,
  description: null,
  image_url: null,
  source_type: "manual",
  source_url: null,
  servings: 4,
  prep_min: 10,
  cook_min: 20,
  tags: [],
  cuisine: null,
  created_at: "2026-10-31T12:00:00.000Z",
  ...over,
});

const lemon = recipe("r1", "Lemon chicken");
const curry = recipe("r2", "Green curry", { servings: 6 });
// The starter catalog: no household, written by the seed.
const salmon = recipe("c1", "Sheet-pan salmon", {
  household_id: null,
  visibility: "catalog",
  source_type: "ai",
});

const PARAMS = { date: "2026-11-03", slot: "dinner" };

function show(
  data: {
    recipes?: RecipeSummary[] | undefined;
    recent?: string[];
    favorites?: string[];
    params?: Record<string, string>;
  } = {},
): RenderedScreen {
  h.recipes.data = "recipes" in data ? data.recipes : [];
  h.recent.data = data.recent ?? [];
  h.favorites.data = data.favorites ?? [];
  h.params = data.params ?? PARAMS;
  return renderScreen(<PickRecipeScreen />);
}

/** The recipe rows on screen, top to bottom, by recipe id. */
const rows = (screen: RenderedScreen) =>
  screen.ids.filter((id) => /^pick-(r|c)\d+$/.test(id)).map((id) => id.slice("pick-".length));

const selectedTab = (screen: RenderedScreen) =>
  ["recent", "favorites", "all"].filter(
    (tab) => screen.props(`picker-tab-${tab}`).accessibilityState?.selected,
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.household.data = { id: "h1" };
  h.household.isPending = false;
  h.recipes.isPending = false;
  h.recipes.isError = false;
  h.recent.isLoading = false;
  h.week.plan = null;
  h.week.entries = [];
});

describe("the add control", () => {
  it("is on screen with one household recipe, and the picker opens on All showing it", () => {
    const screen = show({ recipes: [lemon] });
    expect(screen.has("picker-add-recipe")).toBe(true);
    expect(screen.props("picker-add-recipe").accessibilityLabel).toBe("Add a recipe");
    expect(selectedTab(screen)).toEqual(["all"]);
    expect(rows(screen)).toEqual(["r1"]);
    expect(screen.html).toContain("Lemon chicken");
    // Not the dead end from before: no empty-tab message in the way.
    expect(screen.has("picker-tab-empty")).toBe(false);
    expect(screen.html).not.toContain("Nothing planned yet");
  });

  it("is on screen whatever the recipe count and whichever tab it opens on", () => {
    // Nothing at all.
    expect(show({ recipes: [] }).has("picker-add-recipe")).toBe(true);
    // Recipes planned before: opens on Recent.
    const withRecent = show({ recipes: [lemon, curry], recent: ["r2"] });
    expect(selectedTab(withRecent)).toEqual(["recent"]);
    expect(withRecent.has("picker-add-recipe")).toBe(true);
    // Recipes and nothing planned: opens on All.
    expect(show({ recipes: [lemon, curry] }).has("picker-add-recipe")).toBe(true);
    // The list failed to load.
    h.recipes.isError = true;
    expect(show({ recipes: [] }).has("picker-add-recipe")).toBe(true);
  });

  it("sits outside the scrolling list, so it stays put with sixty recipes under it", () => {
    const many = Array.from({ length: 62 }, (_, i) => recipe(`r${i + 10}`, `Recipe ${i + 10}`));
    const { ids } = show({ recipes: many });
    expect(ids.indexOf("picker-add-recipe")).toBeLessThan(ids.indexOf("picker-list"));
  });

  it("opens /recipes/new with the picker's date and slot as the return target", () => {
    const screen = show({ recipes: [lemon] });
    screen.press("picker-add-recipe");
    expect(h.router.push).toHaveBeenCalledTimes(1);
    expect(h.router.push).toHaveBeenCalledWith(
      "/recipes/new?returnTo=pick&date=2026-11-03&slot=dinner",
    );
    expect(h.router.replace).not.toHaveBeenCalled();
  });

  it("carries a swap target along, and the add-recipe screen reads it back", () => {
    // An entry id is a UUID, and the add-recipe screen refuses anything else.
    const entry = "9a2b7c1e-0000-4000-8000-000000000001";
    const screen = show({
      recipes: [lemon],
      params: { ...PARAMS, slot: "lunch", entry },
    });
    screen.press("picker-add-recipe");
    const [href] = h.router.push.mock.calls[0] ?? [];
    expect(href).toBe(`/recipes/new?returnTo=pick&date=2026-11-03&slot=lunch&entry=${entry}`);

    const url = new URL(String(href), "https://app.test");
    expect(url.pathname).toBe("/recipes/new");
    expect(parsePickerReturn(Object.fromEntries(url.searchParams))).toEqual({
      date: "2026-11-03",
      slot: "lunch",
      entry,
    });
  });
});

describe("the tab the picker opens on", () => {
  it("is Recent when the household has planned a recipe it still has", () => {
    const screen = show({ recipes: [lemon, curry], recent: ["r2"] });
    expect(selectedTab(screen)).toEqual(["recent"]);
    expect(rows(screen)).toEqual(["r2"]);
  });

  it("is All when nothing was planned before", () => {
    const screen = show({ recipes: [curry, lemon], recent: [] });
    expect(selectedTab(screen)).toEqual(["all"]);
    expect(rows(screen)).toEqual(["r2", "r1"]);
  });

  it("is All when the only recent recipes were deleted since", () => {
    const screen = show({ recipes: [lemon], recent: ["gone"] });
    expect(selectedTab(screen)).toEqual(["all"]);
    expect(rows(screen)).toEqual(["r1"]);
  });

  it("is All when the recent list could not be loaded", () => {
    expect(selectedTab(show({ recipes: [lemon], recent: undefined }))).toEqual(["all"]);
  });

  it("waits for the recent list before choosing, instead of guessing All", () => {
    h.recent.isLoading = true;
    const screen = show({ recipes: [lemon], recent: undefined });
    expect(screen.has("picker-tabs")).toBe(false);
    expect(screen.has("picker-add-recipe")).toBe(false);
  });
});

describe("the empty states", () => {
  it("say what Recent is, without an em dash", () => {
    // An empty Recent is only reachable by switching to it; its words live with the tab logic.
    expect(TAB_EMPTY.recent.title).toBe("Nothing planned yet");
    expect(TAB_EMPTY.recent.message).toBe("Recipes you have planned before show up here.");
    const emDash = String.fromCharCode(0x2014);
    for (const copy of [TAB_EMPTY.recent, TAB_EMPTY.favorites]) {
      expect(`${copy.title} ${copy.message}`).not.toContain(emDash);
    }
  });

  it("keep the zero-recipe copy, with the add control above it", () => {
    const screen = show({ recipes: [] });
    expect(screen.has("picker-no-recipes")).toBe(true);
    expect(screen.html).toContain("No recipes yet");
    expect(screen.html).toContain("Add a recipe first, then plan it here.");
    expect(screen.ids.indexOf("picker-add-recipe")).toBeLessThan(
      screen.ids.indexOf("picker-no-recipes"),
    );
    // One way in, not the same button twice.
    expect(screen.html.match(/aria-label="Add a recipe"/g)).toHaveLength(1);
  });
});

describe("catalog recipes", () => {
  it("are asked for: the picker lists the household's recipes and the starter catalog", () => {
    show({ recipes: [lemon] });
    expect(h.useRecipes).toHaveBeenCalledWith("h1", { includeCatalog: true });
  });

  // `useRecipes` decides which rows reach the picker; the picker lists whatever it gets, owner or not.
  it("are listed under All beside the household's own, A to Z", () => {
    const screen = show({ recipes: [lemon, salmon, curry] });
    expect(selectedTab(screen)).toEqual(["all"]);
    expect(rows(screen)).toEqual(["r2", "r1", "c1"]);
    expect(screen.html).toContain("Sheet-pan salmon");
  });

  it("can be picked: swapping to one replaces the meal", () => {
    h.week.entries = [{ id: "e1", recipe: { title: "Lemon chicken" } }];
    const screen = show({
      recipes: [lemon, salmon],
      params: { ...PARAMS, entry: "e1" },
    });
    // The swap flow's list is this picker: the catalog row is under All beside the household's own.
    expect(selectedTab(screen)).toEqual(["all"]);
    expect(rows(screen)).toEqual(["r1", "c1"]);
    screen.press("pick-c1");
    expect(h.actions.swapRecipe).toHaveBeenCalledWith(h.week.entries[0], salmon);
    expect(h.router.back).toHaveBeenCalledTimes(1);
  });

  it("can be added: the servings sheet opens when it is the recipe just saved", () => {
    const screen = show({ recipes: [lemon, salmon], params: { ...PARAMS, added: "c1" } });
    expect(screen.has("pick-confirm")).toBe(true);
    expect(screen.html).toContain("Add Sheet-pan salmon");
  });
});

describe("coming back from the add-recipe screen with a new recipe", () => {
  const fresh = recipe("r9", "Zucchini fritters", { servings: 3 });
  const back = { ...PARAMS, added: "r9" };

  it("shows the new recipe first under All and opens its servings sheet", () => {
    const screen = show({ recipes: [lemon, curry, fresh], recent: ["r1"], params: back });
    // Even though Recent has something, the new recipe is what they came back for.
    expect(selectedTab(screen)).toEqual(["all"]);
    expect(rows(screen)).toEqual(["r9", "r2", "r1"]);
    expect(screen.has("pick-confirm")).toBe(true);
    expect(screen.html).toContain("Add Zucchini fritters");
    expect(screen.html).toContain("Dinner on Tuesday. The recipe makes 3 servings.");
    expect(screen.props("pick-servings").testID).toBe("pick-servings");
  });

  it("finishes planning in one tap: Add puts the recipe in the slot and closes the picker", () => {
    const screen = show({ recipes: [lemon, fresh], params: back });
    screen.press("pick-add");
    expect(h.actions.addRecipe).toHaveBeenCalledTimes(1);
    expect(h.actions.addRecipe).toHaveBeenCalledWith(
      expect.objectContaining({
        date: "2026-11-03",
        slot: "dinner",
        recipe: fresh,
        servings: 3,
        plan: null,
      }),
    );
    expect(h.router.back).toHaveBeenCalledTimes(1);
  });

  it("returns to the same date and slot, whatever the recipe count", () => {
    const screen = show({
      recipes: [fresh],
      params: { date: "2026-11-05", slot: "lunch", added: "r9" },
    });
    expect(screen.html).toContain("Lunch on Thursday");
    screen.press("pick-add");
    expect(h.actions.addRecipe).toHaveBeenCalledWith(
      expect.objectContaining({ date: "2026-11-05", slot: "lunch", recipe: fresh }),
    );
  });

  it("does not open a sheet before the new recipe is in the list, and shows no error", () => {
    // The list is refetching after the save: the recipe arrives a moment later.
    const stale = show({ recipes: [lemon], params: back });
    expect(stale.has("pick-confirm")).toBe(false);
    expect(rows(stale)).toEqual(["r1"]);
    // When it arrives, the sheet opens.
    const arrived = show({ recipes: [lemon, fresh], params: back });
    expect(arrived.has("pick-confirm")).toBe(true);
    expect(rows(arrived)[0]).toBe("r9");
  });

  it("opens no sheet for a swap: the new recipe is first, one tap swaps it in", () => {
    h.week.entries = [{ id: "e1", recipe: { title: "Lemon chicken" } }];
    const screen = show({
      recipes: [lemon, fresh],
      params: { ...back, entry: "e1" },
    });
    expect(screen.has("pick-confirm")).toBe(false);
    expect(selectedTab(screen)).toEqual(["all"]);
    expect(rows(screen)).toEqual(["r9", "r1"]);
    expect(h.actions.swapRecipe).not.toHaveBeenCalled();
    screen.press("pick-r9");
    expect(h.actions.swapRecipe).toHaveBeenCalledWith(h.week.entries[0], fresh);
    expect(h.router.back).toHaveBeenCalledTimes(1);
  });

  it("can add yet another recipe: the control still goes to the add-recipe screen", () => {
    const screen = show({ recipes: [lemon, fresh], params: back });
    screen.press("picker-add-recipe");
    expect(h.router.push).toHaveBeenCalledWith(
      "/recipes/new?returnTo=pick&date=2026-11-03&slot=dinner",
    );
  });
});

describe("other states", () => {
  it("sends a picker opened without a date and slot back to the plan", () => {
    const screen = show({ recipes: [lemon], params: {} });
    expect(screen.props("redirect").href).toBe("/plan");
  });

  it("shows a loading screen, not an empty list, while the recipes load", () => {
    h.recipes.isPending = true;
    const screen = show({ recipes: undefined });
    expect(screen.has("picker-list")).toBe(false);
  });
});
