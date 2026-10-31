// The swap menu looks a suggestion up in the recipe list, and a suggestion can be a starter catalog
// recipe, so the list must include the catalog. The mutation is captured instead of run: its
// mutationFn and onSuccess are the logic under test.
import type { PlanEntry, RecipeSummary } from "@mp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderScreen } from "../../testing/renderScreen";
import { SwapMenu } from "./SwapMenu";

interface Captured {
  mutationFn: () => Promise<{ recipe: RecipeSummary; result: { why: string } }>;
  onSuccess: (done: { recipe: RecipeSummary; result: { why: string } }) => void;
}

const h = vi.hoisted(() => ({
  useRecipes: vi.fn(),
  recipes: { data: [] as unknown[] | undefined, isPending: false },
  mutation: undefined as unknown,
  requestSwapSuggestion: vi.fn(),
  actions: { swapRecipe: vi.fn() },
}));

vi.mock("react-native", () => import("../../testing/reactNativeStub"));
vi.mock("@mp/db", () => ({
  useSupabase: () => ({}),
  useRecipes: (...args: unknown[]) => {
    h.useRecipes(...args);
    return h.recipes;
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: unknown) => {
    h.mutation = options;
    return { mutate: vi.fn(), isPending: false, isError: false, error: null };
  },
}));
vi.mock("./suggest", () => ({
  isSuggestEnabled: () => true,
  requestSwapSuggestion: h.requestSwapSuggestion,
  SuggestUnavailableError: class SuggestUnavailableError extends Error {},
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
const salmon = recipe("c1", "Sheet-pan salmon", {
  household_id: null,
  visibility: "catalog",
  source_type: "ai",
});

const entry = {
  id: "e1",
  household_id: "h1",
  date: "2026-11-03",
  slot: "dinner",
  recipe_id: "r1",
} as unknown as PlanEntry;

function show() {
  const onDone = vi.fn();
  const screen = renderScreen(
    <SwapMenu
      entry={entry}
      weekEntries={[entry]}
      actions={h.actions as never}
      onPick={vi.fn()}
      onDone={onDone}
      onBack={vi.fn()}
    />,
  );
  return { screen, onDone, mutation: h.mutation as Captured };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.recipes.data = [lemon, salmon];
  h.recipes.isPending = false;
  h.requestSwapSuggestion.mockResolvedValue({ recipeId: "c1", why: "Uses the oven once" });
});

describe("the swap menu and the starter catalog", () => {
  it("asks for the household's recipes and the starter catalog", () => {
    show();
    expect(h.useRecipes).toHaveBeenCalledWith("h1", { includeCatalog: true });
  });

  it("swaps in a catalog recipe the suggestion picked, keeping the one-line reason", async () => {
    const { mutation, onDone } = show();
    const done = await mutation.mutationFn();
    expect(done.recipe).toBe(salmon);

    mutation.onSuccess(done);
    expect(h.actions.swapRecipe).toHaveBeenCalledWith(entry, salmon, { why: "Uses the oven once" });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("still refuses a suggestion that is in neither the household's nor the catalog list", async () => {
    h.requestSwapSuggestion.mockResolvedValue({ recipeId: "elsewhere", why: "x" });
    const { mutation } = show();
    await expect(mutation.mutationFn()).rejects.toThrow("That suggestion is not in your recipes.");
  });

  it("still offers the manual picker", () => {
    const { screen } = show();
    expect(screen.has("swap-pick")).toBe(true);
    expect(screen.has("swap-suggest")).toBe(true);
  });
});
