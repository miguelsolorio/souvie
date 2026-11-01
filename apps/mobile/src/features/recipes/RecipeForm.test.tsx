// The recipe form's Save: it sends nothing while the form is wrong. Rendered to one frame with
// react-native stood in (see renderScreen.ts), so the form is the one it was given as `initial`
// and Save is pressed on it as it stands. The messages that appear after a failed press need a
// state change and are covered as `formErrors` in draft.test.ts.
import { describe, expect, it, vi } from "vitest";
import { renderScreen } from "../../testing/renderScreen";
import { emptyForm, type FormState } from "./draft";
import { RecipeForm } from "./RecipeForm";

vi.mock("react-native", () => import("../../testing/reactNativeStub"));
vi.mock("react-native-safe-area-context", async () => {
  const { View } = await import("../../testing/reactNativeStub");
  return { SafeAreaView: View };
});

const valid: FormState = {
  ...emptyForm(),
  title: "Lemon Chicken",
  ingredients: "8 chicken thighs\n1 lemon",
  servings: "4",
};

function save(initial: FormState, props: { requireWholeServings?: boolean } = {}) {
  const onSubmit = vi.fn();
  renderScreen(
    <RecipeForm
      initial={initial}
      submitLabel="Save recipe"
      submitting={false}
      onSubmit={onSubmit}
      {...props}
    />,
  ).press("recipe-save");
  return onSubmit;
}

describe("the Write tab's form (whole servings)", () => {
  const write = { requireWholeServings: true };

  it("saves a recipe with a title, an ingredient, and whole servings", () => {
    const onSubmit = save(valid, write);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      title: "Lemon Chicken",
      servings: 4,
      ingredients: [{ rawText: "8 chicken thighs" }, { rawText: "1 lemon" }],
    });
  });

  it("saves one with no servings at all", () => {
    expect(save({ ...valid, servings: "" }, write)).toHaveBeenCalledTimes(1);
  });

  it("does not save without a title", () => {
    expect(save({ ...valid, title: "   " }, write)).not.toHaveBeenCalled();
  });

  it("does not save without an ingredient line, headings aside", () => {
    expect(save({ ...valid, ingredients: "" }, write)).not.toHaveBeenCalled();
    expect(save({ ...valid, ingredients: "# For the sauce\n\n" }, write)).not.toHaveBeenCalled();
  });

  it("does not save servings that are not a positive whole number", () => {
    for (const servings of ["0", "1 1/2", "4.5", "-1", "lots", "5000"]) {
      expect(save({ ...valid, servings }, write), servings).not.toHaveBeenCalled();
    }
  });
});

describe("every other use of the form (edit, and the review of an imported draft)", () => {
  it("still saves servings an import can produce", () => {
    for (const servings of ["1 1/2", "4.5", "1/2"]) {
      expect(save({ ...valid, servings }), servings).toHaveBeenCalledTimes(1);
    }
  });

  it("still stops at a missing title, a missing ingredient, and servings it cannot read", () => {
    expect(save({ ...valid, title: "" })).not.toHaveBeenCalled();
    expect(save({ ...valid, ingredients: "" })).not.toHaveBeenCalled();
    expect(save({ ...valid, servings: "lots" })).not.toHaveBeenCalled();
    expect(save({ ...valid, servings: "0" })).not.toHaveBeenCalled();
  });
});
