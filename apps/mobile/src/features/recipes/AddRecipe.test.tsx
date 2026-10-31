// Where the add-recipe screen goes once a recipe is saved. It is rendered to markup with
// react-native stood in (src/testing/reactNativeStub.tsx) and the data hooks mocked, then the
// import button is pressed. See renderScreen.ts for what that can and cannot reach: it covers the
// link tab's path to `openRecipe`, which is also where saving a draft ends.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderScreen } from "../../testing/renderScreen";
import { AddRecipe } from "./AddRecipe";

const h = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), back: vi.fn(), dismissTo: vi.fn() },
  importRecipe: { isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() },
  createRecipe: { isPending: false, mutate: vi.fn() },
}));

vi.mock("react-native", () => import("../../testing/reactNativeStub"));
vi.mock("react-native-safe-area-context", async () => {
  const { View } = await import("../../testing/reactNativeStub");
  return { SafeAreaView: View };
});
vi.mock("expo-router", () => ({ useRouter: () => h.router }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "00000000-0000-4000-8000-000000000000" }));
vi.mock("./pickRecipePhoto", () => ({ pickRecipePhoto: vi.fn() }));
vi.mock("@mp/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mp/db")>()),
  useSupabase: () => ({}),
  useHousehold: () => ({ data: { id: "h1" }, isPending: false }),
  useImportRecipe: () => h.importRecipe,
  useCreateRecipe: () => h.createRecipe,
}));

/** The import succeeds at once, the way a fast link would, with this result. */
function importSucceeds(result: { recipeId?: string }) {
  h.importRecipe.mutate.mockImplementation(
    (_vars: unknown, options: { onSuccess: (result: unknown) => void }) =>
      options.onSuccess(result),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.importRecipe.isPending = false;
  h.createRecipe.isPending = false;
});

describe("a recipe saved from the picker", () => {
  const picker = { date: "2026-11-03", slot: "dinner" as const };

  it("returns to that picker with the new recipe's id, not to the recipe's page", () => {
    importSucceeds({ recipeId: "new-1" });
    renderScreen(<AddRecipe returnTo={picker} />).press("import-url");

    expect(h.router.dismissTo).toHaveBeenCalledTimes(1);
    expect(h.router.dismissTo).toHaveBeenCalledWith(
      "/plan/pick?date=2026-11-03&slot=dinner&added=new-1",
    );
    expect(h.router.replace).not.toHaveBeenCalled();
  });

  it("keeps the swap target, so a swap finishes where it started", () => {
    importSucceeds({ recipeId: "new-1" });
    renderScreen(<AddRecipe returnTo={{ ...picker, slot: "lunch", entry: "e1" }} />).press(
      "import-url",
    );

    expect(h.router.dismissTo).toHaveBeenCalledWith(
      "/plan/pick?date=2026-11-03&slot=lunch&entry=e1&added=new-1",
    );
  });

  it("stays put when the import comes back without a recipe", () => {
    importSucceeds({});
    renderScreen(<AddRecipe returnTo={picker} />).press("import-url");

    expect(h.router.dismissTo).not.toHaveBeenCalled();
    expect(h.router.replace).not.toHaveBeenCalled();
  });
});

describe("a recipe saved from anywhere else", () => {
  // The Recipes tab, a share, a link: the screen behaves as it did before the picker used it.
  it("opens the recipe's own page in place of the add screen", () => {
    importSucceeds({ recipeId: "new-1" });
    renderScreen(<AddRecipe />).press("import-url");

    expect(h.router.replace).toHaveBeenCalledTimes(1);
    expect(h.router.replace).toHaveBeenCalledWith("/recipes/new-1");
    expect(h.router.dismissTo).not.toHaveBeenCalled();
  });

  it("does the same when the return target is explicitly empty", () => {
    importSucceeds({ recipeId: "new-1" });
    renderScreen(<AddRecipe returnTo={null} />).press("import-url");

    expect(h.router.replace).toHaveBeenCalledWith("/recipes/new-1");
    expect(h.router.dismissTo).not.toHaveBeenCalled();
  });

  it("draws the same screen with or without a return target", () => {
    const plain = renderScreen(<AddRecipe />);
    const fromPicker = renderScreen(
      <AddRecipe returnTo={{ date: "2026-11-03", slot: "dinner" }} />,
    );
    expect(fromPicker.html).toBe(plain.html);
    expect(plain.has("import-url")).toBe(true);
  });
});
