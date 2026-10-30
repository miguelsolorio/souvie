import { describe, expect, it } from "vitest";
import { parseGrammar } from "./grammar";

const g = parseGrammar;

describe("quantities", () => {
  it.each([
    ["2 cups flour", 2, null],
    ["1.5 cups flour", 1.5, null],
    [".25 tsp salt", 0.25, null],
    ["1/2 cup flour", 0.5, null],
    ["1 1/2 cups flour", 1.5, null],
    ["1-1/2 cups flour", 1.5, null],
    ["½ cup flour", 0.5, null],
    ["1½ cups flour", 1.5, null],
    ["2 ¼ cups flour", 2.25, null],
    ["1/3 cup flour", 0.3333, null],
    ["2-3 cloves garlic", 2, 3],
    ["2 - 3 cloves garlic", 2, 3],
    ["2 to 3 cloves garlic", 2, 3],
    ["1 or 2 cloves garlic", 1, 2],
    ["1/2-1 teaspoon salt", 0.5, 1],
    ["1 1/2 to 2 pounds beef", 1.5, 2],
    ["2–3 sprigs thyme", 2, 3],
    ["one onion", 1, null],
    ["two cloves garlic", 2, null],
    ["a lemon", 1, null],
    ["an onion", 1, null],
    ["half an onion", 0.5, null],
  ])("%s", (line, qty, qtyMax) => {
    const p = g(line);
    expect(p.qty).toBe(qty);
    expect(p.qtyMax).toBe(qtyMax);
  });

  it("has no quantity for 'to taste' lines", () => {
    expect(g("Salt, to taste").qty).toBeNull();
    expect(g("Salt, to taste").unit).toBeNull();
  });
});

describe("units", () => {
  it.each([
    ["2 cups flour", "cup", "flour"],
    ["2 c. flour", "cup", "flour"],
    ["2 tablespoons butter", "tbsp", "butter"],
    ["2 Tbsp. butter", "tbsp", "butter"],
    ["2 T butter", "tbsp", "butter"],
    ["1 t vanilla", "tsp", "vanilla"],
    ["1 tsp. salt", "tsp", "salt"],
    ["8 fl oz broth", "fl_oz", "broth"],
    ["8 fluid ounces water", "fl_oz", "water"],
    ["500g potatoes", "g", "potatoes"],
    ["250ml milk", "ml", "milk"],
    ["1 lb. beef", "lb", "beef"],
    ["3 cloves of garlic", "clove", "garlic"],
    ["a pinch of salt", "pinch", "salt"],
    ["pinch of red pepper flakes", "pinch", "red pepper flakes"],
    ["1 head of broccoli", "head", "broccoli"],
    ["2 large eggs", "large", "eggs"],
    ["1 large head garlic", "head", "garlic"],
    ["3 carrots", "each", "carrots"],
    ["4 slices bacon", "slice", "bacon"],
  ])("%s", (line, unit, noun) => {
    const p = g(line);
    expect(p.unit).toBe(unit);
    expect(p.noun).toBe(noun);
  });

  it("uses each when a count has no unit and marks the unit as implied", () => {
    const p = g("3 carrots");
    expect(p.unit).toBe("each");
    expect(p.unitWritten).toBe(false);
  });

  it("treats 1-inch pieces as pieces", () => {
    const p = g("1-inch piece fresh ginger, peeled");
    expect(p.qty).toBe(1);
    expect(p.unit).toBe("piece");
    expect(p.noun).toBe("fresh ginger");
    expect(p.prep).toEqual(["peeled"]);
  });
});

describe("package sizes", () => {
  it.each([
    ["1 (14 oz) can diced tomatoes", 14, "oz", "can", "diced tomatoes"],
    ["1 (14.5 ounce) can diced tomatoes", 14.5, "oz", "can", "diced tomatoes"],
    ["2 (15-ounce) cans black beans", 30, "oz", "can", "black beans"],
    ["two 15-ounce cans black beans", 30, "oz", "can", "black beans"],
    ["1 can (15 oz) chickpeas", 15, "oz", "can", "chickpeas"],
    ["1 14-oz can coconut milk", 14, "oz", "can", "coconut milk"],
    ["14 oz can diced tomatoes", 14, "oz", "can", "diced tomatoes"],
    ["1 (8 ounce) package cream cheese", 8, "oz", "package", "cream cheese"],
    ["2 x 400g tins chopped tomatoes", 800, "g", "can", "chopped tomatoes"],
    ["4 (4-ounce) pieces cod", 16, "oz", null, "cod"],
  ])("%s", (line, qty, unit, container, noun) => {
    const p = g(line);
    expect(p.qty).toBe(qty);
    expect(p.unit).toBe(unit);
    expect(p.container).toBe(container);
    expect(p.noun).toBe(noun);
  });

  it("keeps the count when the size is not weight or volume", () => {
    const p = g("1 (2 inch) piece ginger");
    expect(p.qty).toBe(1);
    expect(p.unit).toBe("piece");
  });
});

describe("sums, multipliers, and alternates", () => {
  it("adds 'plus' and '+' amounts in the smaller unit", () => {
    expect(g("1 tablespoon plus 1 teaspoon olive oil")).toMatchObject({
      qty: 4,
      unit: "tsp",
      noun: "olive oil",
    });
    expect(g("1 Tbsp. + 1 tsp. cornstarch")).toMatchObject({
      qty: 4,
      unit: "tsp",
      noun: "cornstarch",
    });
  });
  it("drops an alternate measure after a slash", () => {
    expect(g("225g/8oz butter, softened")).toMatchObject({ qty: 225, unit: "g", noun: "butter" });
  });
  it("drops alternate measures in parentheses", () => {
    expect(g("1 cup flour (130 g)")).toMatchObject({ qty: 1, unit: "cup", noun: "flour" });
    expect(g("1/2 cup (1 stick) butter")).toMatchObject({ qty: 0.5, unit: "cup", noun: "butter" });
  });
  it("marks 'each' lines as distributed", () => {
    const p = g("1 teaspoon each salt and pepper");
    expect(p.distribute).toBe(true);
    expect(p.noun).toBe("salt and pepper");
  });
  it("handles hedges and measuring words", () => {
    expect(g("About 1 cup of milk")).toMatchObject({ qty: 1, unit: "cup", noun: "milk" });
    expect(g("2 heaping tablespoons mayonnaise")).toMatchObject({
      qty: 2,
      unit: "tbsp",
      prep: ["heaping"],
    });
    expect(g("1/2 of a small onion")).toMatchObject({ qty: 0.5, unit: "small", noun: "onion" });
  });
});

describe("qualifiers and preparation", () => {
  it("splits the comma tail into preparation", () => {
    const p = g("3 cloves garlic, minced");
    expect(p.noun).toBe("garlic");
    expect(p.prep).toEqual(["minced"]);
  });

  it("pops trailing preparation words", () => {
    const p = g("1 onion finely chopped");
    expect(p.noun).toBe("onion");
    expect(p.prep).toEqual(["finely chopped"]);
  });

  it("does not split a comma between modifiers", () => {
    expect(g("1 pound boneless, skinless chicken breasts").noun).toBe(
      "boneless skinless chicken breasts",
    );
  });

  it.each([
    ["Salt, to taste", "to taste"],
    ["Salt and pepper to taste", "to taste"],
    ["1/2 cup sugar, divided", "divided"],
    ["1 cup flour, plus more for dusting", "plus more for dusting"],
    ["Oil, for frying", "for frying"],
    ["1 cup butter, at room temperature", "at room temperature"],
  ])("keeps the qualifier in %s", (line, note) => {
    expect(g(line).prep).toContain(note);
  });

  it("detects optional in every position", () => {
    expect(g("1/4 cup walnuts, optional").optional).toBe(true);
    expect(g("1/4 cup walnuts (optional)").optional).toBe(true);
    expect(g("Optional: 1/4 cup walnuts").optional).toBe(true);
    expect(g("1/4 cup walnuts").optional).toBe(false);
  });

  it("reads juice and zest lines", () => {
    expect(g("Juice of 1 lemon")).toMatchObject({
      qty: 1,
      unit: "each",
      noun: "lemon",
      prep: ["juice"],
    });
    expect(g("Zest and juice of 1 lemon").prep).toEqual(["zest and juice"]);
    expect(g("juice from 1/2 lemon")).toMatchObject({ qty: 0.5, noun: "lemon" });
  });

  it("flags headers", () => {
    expect(g("For the sauce:").header).toBe(true);
  });

  it("flags a quantity left in the noun phrase", () => {
    expect(g("salt 2 cups").strayQuantity).toBe(true);
    expect(g("2 cups flour").strayQuantity).toBe(false);
  });
});
