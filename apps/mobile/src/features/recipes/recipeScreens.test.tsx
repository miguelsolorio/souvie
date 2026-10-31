// Two recipe screens after the starter catalog became pickable: the detail screen of a catalog
// recipe offers no Edit or Delete, and the Recipes tab still lists the household's own recipes only.
import { beforeEach, describe, expect, it, vi } from "vitest";
import RecipeDetailScreen from "../../../app/(app)/recipes/[id]";
import RecipesScreen from "../../../app/(app)/recipes/index";
import { renderScreen } from "../../testing/renderScreen";

const h = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
  recipe: { isPending: false, isError: false, data: null as unknown, refetch: vi.fn() },
  household: { data: { id: "h1" }, isPending: false },
  useRecipes: vi.fn(),
  list: { data: [] as unknown[], isPending: false, isError: false, refetch: vi.fn() },
}));

vi.mock("react-native", () => import("../../testing/reactNativeStub"));
vi.mock("react-native-safe-area-context", async () => {
  const { View } = await import("../../testing/reactNativeStub");
  return { SafeAreaView: View };
});
vi.mock("expo-web-browser", () => ({}));
vi.mock("expo-router", async () => {
  const { createElement } = await import("react");
  const { View } = await import("../../testing/reactNativeStub");
  return {
    Redirect: ({ href }: { href: string }) => createElement(View, { testID: "redirect", href }),
    Stack: { Screen: () => null },
    useLocalSearchParams: () => ({ id: "r1" }),
    useRouter: () => h.router,
  };
});
vi.mock("@mp/db", () => ({
  recipeErrorMessage: () => "error",
  useDeleteRecipe: () => ({ mutate: vi.fn(), isPending: false }),
  useRecipe: () => h.recipe,
  useHousehold: () => h.household,
  useRecipes: (...args: unknown[]) => {
    h.useRecipes(...args);
    return h.list;
  },
  useRecipeImageUrl: () => null,
}));
vi.mock("../../lib/confirm", () => ({ confirmAction: vi.fn() }));

const detail = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  household_id: "h1",
  visibility: "household",
  title: "Lemon chicken",
  description: null,
  image_url: null,
  source_type: "manual",
  source_url: null,
  servings: 4,
  prep_min: 10,
  cook_min: 20,
  tags: [],
  cuisine: null,
  instructions: [],
  ingredients: [{ id: "i1", raw_text: "8 chicken thighs", group_name: null, position: 0 }],
  ...over,
});

const NOTE = "Starter recipe from Souvie. Plan it as it is.";

beforeEach(() => {
  vi.clearAllMocks();
  h.recipe.isPending = false;
  h.recipe.isError = false;
  h.household.data = { id: "h1" };
  h.household.isPending = false;
  h.list.data = [];
});

describe("recipe detail", () => {
  it("offers Edit and Delete on the household's own recipe, and no starter note", () => {
    h.recipe.data = detail();
    const screen = renderScreen(<RecipeDetailScreen />);
    expect(screen.has("edit-recipe")).toBe(true);
    expect(screen.has("delete-recipe")).toBe(true);
    expect(screen.has("catalog-note")).toBe(false);
    expect(screen.html).not.toContain("Starter recipe");
  });

  it("hides Edit and Delete on a catalog recipe and says why in one line", () => {
    h.recipe.data = detail({
      household_id: null,
      visibility: "catalog",
      source_type: "ai",
      title: "Sheet-pan salmon",
    });
    const screen = renderScreen(<RecipeDetailScreen />);
    expect(screen.has("edit-recipe")).toBe(false);
    expect(screen.has("delete-recipe")).toBe(false);
    expect(screen.html).not.toContain("Edit recipe");
    expect(screen.html).not.toContain("Delete recipe");
    expect(screen.has("catalog-note")).toBe(true);
    expect(screen.html).toContain(NOTE);
    expect(NOTE).not.toContain(String.fromCharCode(0x2014));
  });

  it("changes nothing else for a catalog recipe: title, ingredients and steps still show", () => {
    h.recipe.data = detail({
      household_id: null,
      visibility: "catalog",
      title: "Sheet-pan salmon",
    });
    const screen = renderScreen(<RecipeDetailScreen />);
    expect(screen.html).toContain("Sheet-pan salmon");
    expect(screen.has("recipe-ingredients")).toBe(true);
    expect(screen.html).toContain("8 chicken thighs");
  });
});

describe("the Recipes tab", () => {
  it("still lists the household's own recipes only: no catalog option", () => {
    h.list.data = [detail()];
    renderScreen(<RecipesScreen />);
    expect(h.useRecipes).toHaveBeenCalledTimes(1);
    const [householdId, options] = h.useRecipes.mock.calls[0] ?? [];
    expect(householdId).toBe("h1");
    expect((options as { includeCatalog?: boolean } | undefined)?.includeCatalog).toBeFalsy();
  });
});
