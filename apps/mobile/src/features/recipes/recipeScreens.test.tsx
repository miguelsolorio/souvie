// The recipe screens. After the starter catalog became pickable: the detail screen of a catalog
// recipe offers no Edit or Delete, and the Recipes tab still lists the household's own recipes only.
// After the parse wiring (WS02 follow-up): the detail screen offers "Match ingredients" while a
// household recipe has lines the parser has not read, and never for a starter recipe; a split
// line shows once. The edit screen sends a deep link to a starter recipe's edit route back to its
// detail screen instead of drawing a form whose save the database would refuse.
import { beforeEach, describe, expect, it, vi } from "vitest";
import RecipeDetailScreen from "../../../app/(app)/recipes/[id]";
import EditRecipeScreen from "../../../app/(app)/recipes/[id]/edit";
import RecipesScreen from "../../../app/(app)/recipes/index";
import { renderScreen } from "../../testing/renderScreen";

const h = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
  recipe: { isPending: false, isError: false, data: null as unknown, refetch: vi.fn() },
  match: { isPending: false, mutate: vi.fn() },
  update: { isPending: false, mutate: vi.fn() },
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
vi.mock("@mp/db", async (importOriginal) => ({
  // The real needsIngredientMatch: the screens' rule for when the action shows is what is tested.
  ...(await importOriginal<typeof import("@mp/db")>()),
  recipeErrorMessage: () => "error",
  useDeleteRecipe: () => ({ mutate: vi.fn(), isPending: false }),
  useMatchIngredients: () => h.match,
  useUpdateRecipe: () => h.update,
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
  h.match.isPending = false;
  h.update.isPending = false;
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

/** An ingredient line as the detail screen reads it, with the parser's confidence (null: unread). */
const line = (
  id: string,
  rawText: string,
  parseConfidence: number | null,
  over: Record<string, unknown> = {},
) => ({
  id,
  raw_text: rawText,
  group_name: null,
  position: Number(id.slice(1)),
  parse_confidence: parseConfidence,
  ...over,
});

describe("Match ingredients on the detail screen", () => {
  it("is offered while a household recipe has a line the parser has not read", () => {
    h.recipe.data = detail({
      ingredients: [line("i0", "8 chicken thighs", 0.95), line("i1", "1 lemon", null)],
    });
    const screen = renderScreen(<RecipeDetailScreen />);
    expect(screen.has("match-ingredients")).toBe(true);
    expect(screen.html).toContain("Match ingredients");
    expect(screen.has("match-ingredients-panel")).toBe(true);
  });

  it("sends the recipe's id and visibility when pressed, once per press", () => {
    h.recipe.data = detail({ ingredients: [line("i0", "1 lemon", null)] });
    renderScreen(<RecipeDetailScreen />).press("match-ingredients");
    expect(h.match.mutate).toHaveBeenCalledTimes(1);
    expect(h.match.mutate).toHaveBeenCalledWith(
      { id: "r1", visibility: "household" },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("shows busy while matching", () => {
    h.recipe.data = detail({ ingredients: [line("i0", "1 lemon", null)] });
    h.match.isPending = true;
    const screen = renderScreen(<RecipeDetailScreen />);
    expect(screen.props("match-ingredients").accessibilityState?.busy).toBe(true);
  });

  it("is not offered once every line has been read, whatever the parser made of it", () => {
    h.recipe.data = detail({
      ingredients: [line("i0", "8 chicken thighs", 0.95), line("i1", "a handful of whatever", 0)],
    });
    const screen = renderScreen(<RecipeDetailScreen />);
    expect(screen.has("match-ingredients")).toBe(false);
    expect(screen.has("match-ingredients-panel")).toBe(false);
  });

  it("is never offered for a starter recipe, even with unread lines", () => {
    h.recipe.data = detail({
      household_id: null,
      visibility: "catalog",
      ingredients: [line("i0", "8 chicken thighs", null)],
    });
    const screen = renderScreen(<RecipeDetailScreen />);
    expect(screen.has("match-ingredients")).toBe(false);
    expect(screen.html).not.toContain("Match ingredients");
    expect(screen.has("catalog-note")).toBe(true);
  });

  it("shows a line the parser split in two once, as it was written", () => {
    // "salt and pepper to taste" becomes two rows (salt, pepper) with the same position and text.
    h.recipe.data = detail({
      ingredients: [
        line("i0", "salt and pepper to taste", 0.9, { position: 0 }),
        line("i1", "salt and pepper to taste", 0.9, { position: 0 }),
        line("i2", "1 lemon", 0.95, { position: 1 }),
      ],
    });
    const html = renderScreen(<RecipeDetailScreen />).html;
    expect(html.match(/salt and pepper to taste/g)).toHaveLength(1);
    expect(html).toContain("1 lemon");
  });

  it("still shows the same text twice when it was written twice", () => {
    h.recipe.data = detail({
      ingredients: [
        line("i0", "1/2 tsp salt", 0.9, { position: 0, group_name: "For the batter" }),
        line("i1", "1/2 tsp salt", 0.9, { position: 3, group_name: "For the filling" }),
      ],
    });
    expect(renderScreen(<RecipeDetailScreen />).html.match(/1\/2 tsp salt/g)).toHaveLength(2);
  });
});

describe("the edit screen", () => {
  it("sends a deep link to a starter recipe's edit route to its detail screen", () => {
    h.recipe.data = detail({
      household_id: null,
      visibility: "catalog",
      title: "Sheet-pan salmon",
    });
    const screen = renderScreen(<EditRecipeScreen />);
    expect(screen.has("redirect")).toBe(true);
    expect(screen.props("redirect").href).toBe("/recipes/r1");
    // No form was drawn, so there is no save to fail on a policy.
    expect(screen.has("recipe-save")).toBe(false);
    expect(screen.html).not.toContain("Save changes");
  });

  it("draws the form for the household's own recipe", () => {
    h.recipe.data = detail();
    const screen = renderScreen(<EditRecipeScreen />);
    expect(screen.has("redirect")).toBe(false);
    expect(screen.has("recipe-save")).toBe(true);
    expect(screen.html).toContain("Save changes");
  });

  it("saves through the update hook and goes back when it succeeds", () => {
    h.recipe.data = detail();
    renderScreen(<EditRecipeScreen />).press("recipe-save");
    expect(h.update.mutate).toHaveBeenCalledTimes(1);
    const [draft, options] = h.update.mutate.mock.calls[0] ?? [];
    expect(draft).toMatchObject({
      title: "Lemon chicken",
      ingredients: [{ id: "i1", rawText: "8 chicken thighs" }],
    });
    (options as { onSuccess: () => void }).onSuccess();
    expect(h.router.back).toHaveBeenCalledTimes(1);
  });

  it("still tells a missing or deleted recipe from a starter one", () => {
    h.recipe.data = null;
    const screen = renderScreen(<EditRecipeScreen />);
    expect(screen.has("redirect")).toBe(false);
    expect(screen.html).toContain("deleted, or you do not have access");
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
