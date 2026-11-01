// The add-recipe screen: where it goes once a recipe is saved, and what it does when the household
// already has the recipe. It is rendered to markup with react-native stood in
// (src/testing/reactNativeStub.tsx) and the data hooks mocked, then a button is pressed. See
// renderScreen.ts for what that can and cannot reach: it draws one frame, so a state change does
// nothing and a test starts from the state it needs.
//
// What reaches `openRecipe` here, and so is held to `afterRecipeSaved`:
//   * the link tab's import (the default tab)
//   * the paste tab's import (`initialTab="paste"`)
//   * a save from the Write tab (`initialTab="write"`, with the form replaced by a stand-in that
//     hands over a ready draft), which is the same `save()` a confirmed photo or caption draft
//     calls. The review screen itself only appears after a state change, so it is not drawn here.
//   * "Open it" and "Add anyway" on the duplicate sheet
// The sheet is shown from the failed request's own state (`importRecipe.error` and
// `createRecipe.error`), so a test sets that state and the sheet is there.
import { ImportError, RecipeError } from "@mp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderScreen } from "../../testing/renderScreen";
import { AddRecipe, LinkTab, PasteTab } from "./AddRecipe";

const h = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), back: vi.fn(), dismissTo: vi.fn() },
  importRecipe: {
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    reset: vi.fn(),
    error: null as unknown,
    variables: undefined as unknown,
  },
  createRecipe: {
    isPending: false,
    mutate: vi.fn(),
    reset: vi.fn(),
    error: null as unknown,
    variables: undefined as unknown,
  },
}));

vi.mock("react-native", () => import("../../testing/reactNativeStub"));
vi.mock("react-native-safe-area-context", async () => {
  const { View } = await import("../../testing/reactNativeStub");
  return { SafeAreaView: View };
});
vi.mock("expo-router", () => ({ useRouter: () => h.router }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "00000000-0000-4000-8000-000000000000" }));
vi.mock("./pickRecipePhoto", () => ({ pickRecipePhoto: vi.fn() }));
// The real form keeps its text in state a one-frame render cannot change. The stand-in records the
// props AddRecipe gives it, so a test can hand over a ready draft the way the form's Save does.
vi.mock("./RecipeForm", async () => {
  const { createElement } = await import("react");
  const { View } = await import("../../testing/reactNativeStub");
  return {
    RecipeForm: (props: Record<string, unknown>) =>
      createElement(View, { testID: "recipe-form", ...props }),
  };
});
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

/** The save succeeds at once with this recipe id. */
function saveSucceeds(recipeId: string) {
  h.createRecipe.mutate.mockImplementation(
    (_vars: unknown, options: { onSuccess: (id: string) => void }) => options.onSuccess(recipeId),
  );
}

const READY_DRAFT = {
  title: "Lemon Chicken",
  ingredients: [{ rawText: "8 chicken thighs" }],
  instructions: ["Roast."],
};

type Picker = Parameters<typeof AddRecipe>[0]["returnTo"];

beforeEach(() => {
  vi.clearAllMocks();
  h.importRecipe.isPending = false;
  h.importRecipe.error = null;
  h.importRecipe.variables = undefined;
  h.createRecipe.isPending = false;
  h.createRecipe.error = null;
  h.createRecipe.variables = undefined;
});

/** Each way a recipe gets saved on this screen: render it, press its control, let the save succeed. */
const WAYS_TO_SAVE = [
  {
    name: "a link",
    saves: (picker?: Picker, id = "new-1") => {
      importSucceeds({ recipeId: id });
      renderScreen(<AddRecipe returnTo={picker ?? null} />).press("import-url");
    },
  },
  {
    name: "pasted text",
    saves: (picker?: Picker, id = "new-1") => {
      importSucceeds({ recipeId: id });
      renderScreen(<AddRecipe returnTo={picker ?? null} initialTab="paste" />).press("import-text");
    },
  },
  {
    name: "a typed or confirmed recipe",
    saves: (picker?: Picker, id = "new-1") => {
      saveSucceeds(id);
      const screen = renderScreen(<AddRecipe returnTo={picker ?? null} initialTab="write" />);
      (screen.props("recipe-form").onSubmit as (draft: unknown) => void)(READY_DRAFT);
    },
  },
] as const;

describe.each(WAYS_TO_SAVE)("a recipe saved from $name", ({ saves }) => {
  const picker = { date: "2026-11-03", slot: "dinner" as const };

  it("returns to the picker that sent the person, with the new recipe's id, not to its page", () => {
    saves(picker);
    expect(h.router.dismissTo).toHaveBeenCalledTimes(1);
    expect(h.router.dismissTo).toHaveBeenCalledWith(
      "/plan/pick?date=2026-11-03&slot=dinner&added=new-1",
    );
    expect(h.router.replace).not.toHaveBeenCalled();
  });

  it("keeps the swap target, so a swap finishes where it started", () => {
    saves({ ...picker, slot: "lunch", entry: "9a2b7c1e-0000-4000-8000-000000000001" });
    expect(h.router.dismissTo).toHaveBeenCalledWith(
      "/plan/pick?date=2026-11-03&slot=lunch&entry=9a2b7c1e-0000-4000-8000-000000000001&added=new-1",
    );
  });

  it("opens the recipe's own page in place of the add screen when nothing sent the person here", () => {
    saves(null);
    expect(h.router.replace).toHaveBeenCalledTimes(1);
    expect(h.router.replace).toHaveBeenCalledWith("/recipes/new-1");
    expect(h.router.dismissTo).not.toHaveBeenCalled();
  });

  it("does the same when the return target is left out", () => {
    saves(undefined);
    expect(h.router.replace).toHaveBeenCalledWith("/recipes/new-1");
    expect(h.router.dismissTo).not.toHaveBeenCalled();
  });
});

describe("a save that comes back without a recipe", () => {
  const picker = { date: "2026-11-03", slot: "dinner" as const };

  it("stays put, from the picker or not", () => {
    importSucceeds({});
    renderScreen(<AddRecipe returnTo={picker} />).press("import-url");
    renderScreen(<AddRecipe />).press("import-url");
    expect(h.router.dismissTo).not.toHaveBeenCalled();
    expect(h.router.replace).not.toHaveBeenCalled();
  });
});

describe("the screen itself", () => {
  it("draws the same screen with or without a return target", () => {
    const plain = renderScreen(<AddRecipe />);
    const fromPicker = renderScreen(
      <AddRecipe returnTo={{ date: "2026-11-03", slot: "dinner" }} />,
    );
    expect(fromPicker.html).toBe(plain.html);
    expect(plain.has("import-url")).toBe(true);
  });

  it("opens on the link tab, and on another when asked", () => {
    expect(renderScreen(<AddRecipe />).has("import-url")).toBe(true);
    expect(renderScreen(<AddRecipe initialTab="paste" />).has("import-text")).toBe(true);
    expect(renderScreen(<AddRecipe initialTab="photo" />).has("photo-camera")).toBe(true);
    expect(renderScreen(<AddRecipe initialTab="write" />).has("recipe-form")).toBe(true);
  });

  it("asks the Write tab for whole servings", () => {
    const write = renderScreen(<AddRecipe initialTab="write" />);
    expect(write.props("recipe-form").requireWholeServings).toBe(true);
  });

  it("checks a typed recipe against the household's titles before it saves", () => {
    const screen = renderScreen(<AddRecipe initialTab="write" />);
    (screen.props("recipe-form").onSubmit as (draft: unknown) => void)({
      ...READY_DRAFT,
      title: "  Lemon   CHICKEN ",
    });
    const [args] = h.createRecipe.mutate.mock.calls[0] ?? [];
    expect(args).toMatchObject({ householdId: "h1", sourceType: "manual" });
    expect(args).not.toHaveProperty("allowDuplicate");
    const { title } = (
      args as {
        duplicateCheck: { title: { pattern: string; isSame: (candidate: string) => boolean } };
      }
    ).duplicateCheck;
    expect(title.pattern).toBe("lemon%chicken");
    expect(title.isSame("lemon chicken")).toBe(true);
    expect(title.isSame("Lemon roast chicken")).toBe(false);
  });
});

describe("the link tab, before anything is sent", () => {
  const show = (url: string) =>
    renderScreen(
      <LinkTab url={url} onChange={vi.fn()} busy={false} loading={false} onImport={vi.fn()} />,
    );

  it("says nothing and keeps the button off while the box is empty", () => {
    const screen = show("");
    expect(screen.html).not.toContain("not a web address");
    expect(screen.props("import-url").disabled).toBe(true);
    expect(show("   ").props("import-url").disabled).toBe(true);
  });

  it.each([
    "seriouseats.com/recipes/x",
    "www.example.com",
    "just some words",
    "ftp://example.com/recipe",
    "javascript:alert(1)",
    "https://",
    "https://exa mple.com",
  ])("says it is not a web address for %j, and keeps the button off", (text) => {
    const screen = show(text);
    expect(screen.html).toContain("That is not a web address");
    expect(screen.props("import-url").disabled).toBe(true);
  });

  it.each([
    "https://www.seriouseats.com/lemon-chicken",
    "http://example.com/r",
    "  https://example.com/r?id=1#top  ",
  ])("accepts %j and turns the button on", (text) => {
    const screen = show(text);
    expect(screen.html).not.toContain("not a web address");
    expect(screen.props("import-url").disabled).toBeFalsy();
  });

  it("keeps the button off, with its own explanation, for a video platform link", () => {
    const screen = show("https://www.tiktok.com/@cook/video/1");
    expect(screen.html).toContain("We do not download videos");
    expect(screen.html).not.toContain("not a web address");
    expect(screen.props("import-url").disabled).toBe(true);
  });

  it("on the web, says there is no share sheet and points at pasting (WS13)", () => {
    // The test renders with the web build's share text (shareCapability.ts, not the .native one).
    const screen = show("");
    expect(screen.has("link-tab-hint")).toBe(true);
    expect(screen.html).toContain("no share sheet on the web");
    expect(screen.html).toContain("Paste tab");
  });

  it("on the web, sends a video link to the Paste tab instead of the share sheet", () => {
    const screen = show("https://www.tiktok.com/@cook/video/1");
    expect(screen.html).toContain("paste it on the Paste tab");
    expect(screen.html).not.toContain("Share the post into this app");
  });

  it("keeps the button off while another request is running", () => {
    const screen = renderScreen(
      <LinkTab
        url="https://example.com/r"
        onChange={vi.fn()}
        busy
        loading={false}
        onImport={vi.fn()}
      />,
    );
    expect(screen.props("import-url").disabled).toBe(true);
  });

  it("sends the import when the button is pressed", () => {
    const onImport = vi.fn();
    renderScreen(
      <LinkTab
        url="https://example.com/r"
        onChange={vi.fn()}
        busy={false}
        loading={false}
        onImport={onImport}
      />,
    ).press("import-url");
    expect(onImport).toHaveBeenCalledTimes(1);
  });
});

describe("the paste tab, before anything is sent", () => {
  const show = (text: string) =>
    renderScreen(
      <PasteTab text={text} onChange={vi.fn()} busy={false} loading={false} onImport={vi.fn()} />,
    );

  it("keeps its minimum, and says why the button is off", () => {
    const empty = show("");
    expect(empty.props("import-text").disabled).toBe(true);
    expect(empty.html).toContain("Paste at least 20 characters");

    const short = show("Pancakes\n2 cups");
    expect(short.props("import-text").disabled).toBe(true);
    expect(short.html).toContain("more characters needed");
    expect(short.html).toContain("A recipe takes at least 20");
  });

  it("counts what is missing, spaces at the ends not included", () => {
    expect(show("x".repeat(19)).html).toContain("1 more character needed");
    expect(show(`   ${"x".repeat(15)}   `).html).toContain("5 more characters needed");
  });

  it("turns the button on at the minimum and says nothing more", () => {
    const screen = show("x".repeat(20));
    expect(screen.props("import-text").disabled).toBeFalsy();
    expect(screen.html).not.toContain("more character");
    expect(screen.html).not.toContain("Paste at least");
  });
});

describe("a recipe the household already has", () => {
  const picker = { date: "2026-11-03", slot: "dinner" as const };
  const text = { kind: "text", input: "Pancakes\n2 cups flour\n1 cup milk", householdId: "h1" };

  /** The failed request, as the mutation holds it for the screen. */
  function importFoundOne(matchedBy: "url" | "title", variables: unknown = text) {
    h.importRecipe.error = new ImportError("duplicate", undefined, undefined, {
      recipeId: "old-1",
      matchedBy,
    });
    h.importRecipe.variables = variables;
  }

  it("draws nothing extra when there is no duplicate, or only another kind of failure", () => {
    expect(renderScreen(<AddRecipe />).has("duplicate-sheet")).toBe(false);
    h.importRecipe.error = new ImportError("blocked", "The site would not let us in.");
    expect(renderScreen(<AddRecipe />).has("duplicate-sheet")).toBe(false);
    h.createRecipe.error = new RecipeError("unknown");
    expect(renderScreen(<AddRecipe />).has("duplicate-sheet")).toBe(false);
  });

  it("says so, and offers to open it or add anyway, when the title matches", () => {
    importFoundOne("title");
    const screen = renderScreen(<AddRecipe />);
    expect(screen.has("duplicate-sheet")).toBe(true);
    expect(screen.html).toContain("You already have this recipe");
    expect(screen.html).toContain("Open it");
    expect(screen.html).toContain("Add anyway");
    expect(screen.has("duplicate-open")).toBe(true);
    expect(screen.has("duplicate-add-anyway")).toBe(true);
    expect(screen.has("duplicate-link-note")).toBe(false);
  });

  it("offers only to open it when the link matches, since a link can be saved once", () => {
    importFoundOne("url", { kind: "url", input: "https://example.test/r" });
    const screen = renderScreen(<AddRecipe />);
    expect(screen.has("duplicate-open")).toBe(true);
    expect(screen.has("duplicate-add-anyway")).toBe(false);
    expect(screen.html).not.toContain("Add anyway");
    expect(screen.has("duplicate-link-note")).toBe(true);
  });

  it("is also said when saving a typed or confirmed recipe finds one", () => {
    h.createRecipe.error = new RecipeError("duplicate", undefined, {
      recipeId: "old-1",
      matchedBy: "title",
    });
    h.createRecipe.variables = { householdId: "h1", draft: READY_DRAFT, sourceType: "manual" };
    const screen = renderScreen(<AddRecipe initialTab="write" />);
    expect(screen.has("duplicate-sheet")).toBe(true);
    // The form is still on the screen under it, with what the person typed.
    expect(screen.has("recipe-form")).toBe(true);
  });

  describe("Open it", () => {
    it("goes to the recipe that is there", () => {
      importFoundOne("title");
      renderScreen(<AddRecipe />).press("duplicate-open");
      expect(h.router.replace).toHaveBeenCalledTimes(1);
      expect(h.router.replace).toHaveBeenCalledWith("/recipes/old-1");
      expect(h.router.dismissTo).not.toHaveBeenCalled();
      // Nothing was created, and nothing was asked of the function again.
      expect(h.importRecipe.mutate).not.toHaveBeenCalled();
      expect(h.createRecipe.mutate).not.toHaveBeenCalled();
    });

    it("goes back to the picker with the existing recipe's id when the picker sent the person", () => {
      importFoundOne("title");
      renderScreen(<AddRecipe returnTo={picker} />).press("duplicate-open");
      expect(h.router.dismissTo).toHaveBeenCalledTimes(1);
      expect(h.router.dismissTo).toHaveBeenCalledWith(
        "/plan/pick?date=2026-11-03&slot=dinner&added=old-1",
      );
      expect(h.router.replace).not.toHaveBeenCalled();
    });

    it("does the same for a link match and for a match found while saving", () => {
      importFoundOne("url", { kind: "url", input: "https://example.test/r" });
      renderScreen(<AddRecipe returnTo={picker} />).press("duplicate-open");
      expect(h.router.dismissTo).toHaveBeenLastCalledWith(
        "/plan/pick?date=2026-11-03&slot=dinner&added=old-1",
      );

      h.importRecipe.error = null;
      h.createRecipe.error = new RecipeError("duplicate", undefined, {
        recipeId: "old-2",
        matchedBy: "title",
      });
      renderScreen(<AddRecipe returnTo={picker} initialTab="write" />).press("duplicate-open");
      expect(h.router.dismissTo).toHaveBeenLastCalledWith(
        "/plan/pick?date=2026-11-03&slot=dinner&added=old-2",
      );
    });
  });

  describe("Add anyway", () => {
    it("sends the same request again with allowDuplicate, and opens the new recipe", () => {
      importFoundOne("title");
      importSucceeds({ recipeId: "new-2" });
      renderScreen(<AddRecipe />).press("duplicate-add-anyway");

      expect(h.importRecipe.mutate).toHaveBeenCalledTimes(1);
      const [request] = h.importRecipe.mutate.mock.calls[0] ?? [];
      expect(request).toEqual({ ...text, allowDuplicate: true });
      expect(h.router.replace).toHaveBeenCalledWith("/recipes/new-2");
    });

    it("finishes through the picker's return when the picker sent the person", () => {
      importFoundOne("title");
      importSucceeds({ recipeId: "new-2" });
      renderScreen(<AddRecipe returnTo={picker} />).press("duplicate-add-anyway");
      expect(h.router.dismissTo).toHaveBeenCalledWith(
        "/plan/pick?date=2026-11-03&slot=dinner&added=new-2",
      );
      expect(h.router.replace).not.toHaveBeenCalled();
    });

    it("saves the typed or confirmed recipe again with allowDuplicate", () => {
      h.createRecipe.error = new RecipeError("duplicate", undefined, {
        recipeId: "old-1",
        matchedBy: "title",
      });
      const variables = { householdId: "h1", draft: READY_DRAFT, sourceType: "manual" };
      h.createRecipe.variables = variables;
      saveSucceeds("new-3");

      renderScreen(<AddRecipe returnTo={picker} initialTab="write" />).press(
        "duplicate-add-anyway",
      );
      expect(h.createRecipe.mutate).toHaveBeenCalledTimes(1);
      const [args] = h.createRecipe.mutate.mock.calls[0] ?? [];
      expect(args).toEqual({ ...variables, allowDuplicate: true });
      expect(h.router.dismissTo).toHaveBeenCalledWith(
        "/plan/pick?date=2026-11-03&slot=dinner&added=new-3",
      );
    });

    it("reads a caption again, not a saved recipe, when the caption was what found one", () => {
      const caption = {
        kind: "caption",
        input: "Pancakes\n2 cups flour\n1 cup milk\n1 egg",
        save: false,
      };
      importFoundOne("title", caption);
      renderScreen(<AddRecipe />).press("duplicate-add-anyway");
      expect(h.importRecipe.mutate.mock.calls[0]?.[0]).toEqual({
        ...caption,
        allowDuplicate: true,
      });
    });
  });

  it("goes away, and sends nothing, on Cancel", () => {
    importFoundOne("title");
    h.createRecipe.error = new RecipeError("duplicate", undefined, {
      recipeId: "old-1",
      matchedBy: "title",
    });
    renderScreen(<AddRecipe />).press("duplicate-cancel");
    expect(h.importRecipe.reset).toHaveBeenCalledTimes(1);
    expect(h.createRecipe.reset).toHaveBeenCalledTimes(1);
    expect(h.importRecipe.mutate).not.toHaveBeenCalled();
    expect(h.createRecipe.mutate).not.toHaveBeenCalled();
    expect(h.router.replace).not.toHaveBeenCalled();
    expect(h.router.dismissTo).not.toHaveBeenCalled();
  });

  it("goes away on the sheet's own Done and backdrop too", () => {
    importFoundOne("title");
    const screen = renderScreen(<AddRecipe />);
    screen.press("duplicate-sheet-close");
    screen.press("duplicate-sheet-backdrop");
    expect(h.importRecipe.reset).toHaveBeenCalledTimes(2);
  });
});
