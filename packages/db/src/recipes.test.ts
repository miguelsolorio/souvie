import {
  IMPORT_JOB_KINDS,
  IMPORT_JOB_STATUSES,
  RECIPE_SOURCE_TYPES,
  RECIPE_VISIBILITIES,
} from "@mp/core";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { MpClient } from "./client";
import {
  ImportError,
  importErrorMessage,
  importRecipe,
  recipeImagePath,
  uploadRecipeImage,
} from "./hooks/useImportRecipe";
import {
  checkDraft,
  createRecipe,
  deleteRecipe,
  fetchRecipe,
  getRecipeImageUrl,
  isStorageImagePath,
  type RecipeDraft,
  RecipeError,
  recipeErrorMessage,
  updateRecipe,
} from "./hooks/useRecipe";
import { fetchRecipes, recipesQueryKey, recipesQueryOptions } from "./hooks/useRecipes";
import { Constants } from "./types.generated";

type Result = { data?: unknown; error?: { message: string } | null };
interface Call {
  op: string;
  args: unknown[];
}

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const RECIPE = "5ec1be00-0000-4000-8000-000000000001";

/** Records every call and resolves each query chain to the next queued result. */
function fakeClient(results: Result[] = [], invoke?: () => Promise<unknown>) {
  const calls: Call[] = [];
  const queue = [...results];
  const next = (): Result => queue.shift() ?? { data: null, error: null };

  const chain = (label: string) => {
    const q: Record<string, unknown> = {};
    for (const method of [
      "select",
      "insert",
      "update",
      "delete",
      "eq",
      "in",
      "is",
      "or",
      "order",
      "limit",
      "single",
      "maybeSingle",
    ]) {
      q[method] = (...args: unknown[]) => {
        calls.push({ op: `${label}.${method}`, args });
        return q;
      };
    }
    // biome-ignore lint/suspicious/noThenProperty: mimics PostgREST's awaitable query builder
    q.then = (resolve: (value: Result) => unknown) => resolve(next());
    return q;
  };

  const client = {
    from: (table: string) => chain(table),
    storage: {
      from: (bucket: string) => ({
        upload: async (...args: unknown[]) => {
          calls.push({ op: `storage.${bucket}.upload`, args });
          const r = next();
          return { data: r.data ?? null, error: r.error ?? null };
        },
        createSignedUrl: async (...args: unknown[]) => {
          calls.push({ op: `storage.${bucket}.createSignedUrl`, args });
          const r = next();
          return r.error
            ? { data: null, error: r.error }
            : { data: { signedUrl: "https://signed.test/x" }, error: null };
        },
      }),
    },
    functions: {
      invoke: async (...args: unknown[]) => {
        calls.push({ op: "functions.invoke", args });
        return invoke ? invoke() : next();
      },
    },
  };
  return { client: client as unknown as MpClient, calls };
}

const draft = (over: Partial<RecipeDraft> = {}): RecipeDraft => ({
  title: "Lemon Chicken",
  servings: 4,
  ingredients: [{ rawText: "8 chicken thighs" }, { rawText: "1 lemon", groupName: "For the pan" }],
  instructions: ["Heat the oven.", "Roast."],
  ...over,
});

describe("checkDraft", () => {
  it("accepts a draft, trims text, and drops blank lines and steps", () => {
    const checked = checkDraft(
      draft({
        title: "  Soup  ",
        ingredients: [{ rawText: " 2 cups stock " }, { rawText: "   " }],
        instructions: ["Simmer.", "", "  "],
      }),
    );
    expect(checked).toMatchObject({
      ok: true,
      recipe: {
        title: "Soup",
        ingredients: [{ rawText: "2 cups stock" }],
        instructions: ["Simmer."],
      },
    });
  });

  it("rejects a missing title or no ingredients, naming the field", () => {
    expect(checkDraft(draft({ title: "  " }))).toMatchObject({ ok: false, field: "title" });
    expect(checkDraft(draft({ ingredients: [{ rawText: " " }] }))).toMatchObject({
      ok: false,
      field: "ingredients",
    });
  });

  it("rejects a non-web image link and a bad serving count", () => {
    expect(checkDraft(draft({ imageUrl: "javascript:alert(1)" })).ok).toBe(false);
    expect(checkDraft(draft({ imageUrl: `${HOUSEHOLD}/card.jpg` })).ok).toBe(true);
    expect(checkDraft(draft({ servings: -1 })).ok).toBe(false);
  });
});

describe("fetchRecipes", () => {
  it("lists the household's live recipes, newest first, without the embedding", async () => {
    const { client, calls } = fakeClient([{ data: [{ id: RECIPE, title: "x" }], error: null }]);
    const rows = await fetchRecipes(client, HOUSEHOLD);
    expect(rows).toHaveLength(1);
    const select = calls.find((c) => c.op === "recipes.select");
    expect(String(select?.args[0])).not.toContain("embedding");
    expect(String(select?.args[0])).toContain("visibility");
    expect(calls).toContainEqual({ op: "recipes.eq", args: ["household_id", HOUSEHOLD] });
    expect(calls).toContainEqual({ op: "recipes.is", args: ["deleted_at", null] });
    expect(calls).toContainEqual({
      op: "recipes.order",
      args: ["created_at", { ascending: false }],
    });
  });

  it("stays household-only unless the starter catalog is asked for", async () => {
    for (const options of [undefined, {}, { includeCatalog: false }]) {
      const { client, calls } = fakeClient([{ data: [], error: null }]);
      await fetchRecipes(client, HOUSEHOLD, options);
      expect(calls).toContainEqual({ op: "recipes.eq", args: ["household_id", HOUSEHOLD] });
      expect(calls.some((c) => c.op === "recipes.or")).toBe(false);
    }
  });

  it("with the catalog: the household's rows or catalog rows, live ones only, same order", async () => {
    const { client, calls } = fakeClient([{ data: [{ id: RECIPE, title: "x" }], error: null }]);
    const rows = await fetchRecipes(client, HOUSEHOLD, { includeCatalog: true });
    expect(rows).toHaveLength(1);
    expect(calls).toContainEqual({
      op: "recipes.or",
      args: [`household_id.eq.${HOUSEHOLD},visibility.eq.catalog`],
    });
    // No household-only filter alongside it, which would hide the catalog again.
    expect(calls.some((c) => c.op === "recipes.eq")).toBe(false);
    // The soft-delete filter and the order apply to both kinds of row.
    expect(calls).toContainEqual({ op: "recipes.is", args: ["deleted_at", null] });
    expect(calls).toContainEqual({
      op: "recipes.order",
      args: ["created_at", { ascending: false }],
    });
    const select = calls.find((c) => c.op === "recipes.select");
    expect(String(select?.args[0])).not.toContain("embedding");
  });

  it("throws on a database error", async () => {
    const { client } = fakeClient([{ data: null, error: { message: "boom" } }]);
    await expect(fetchRecipes(client, HOUSEHOLD)).rejects.toThrow("boom");
    const again = fakeClient([{ data: null, error: { message: "boom" } }]);
    await expect(fetchRecipes(again.client, HOUSEHOLD, { includeCatalog: true })).rejects.toThrow(
      "boom",
    );
  });
});

describe("what useRecipes runs", () => {
  it("leaves the catalog out by default, in its key and in its query, and adds it only when asked", async () => {
    for (const options of [
      undefined,
      {},
      { includeCatalog: undefined },
      { includeCatalog: false },
    ]) {
      const { client, calls } = fakeClient([{ data: [], error: null }]);
      const query = recipesQueryOptions(client, HOUSEHOLD, options);
      expect(query.queryKey).toEqual(["recipes", HOUSEHOLD]);
      await query.queryFn();
      expect(calls).toContainEqual({ op: "recipes.eq", args: ["household_id", HOUSEHOLD] });
      expect(calls.some((c) => c.op === "recipes.or")).toBe(false);
    }

    const { client, calls } = fakeClient([{ data: [], error: null }]);
    const query = recipesQueryOptions(client, HOUSEHOLD, { includeCatalog: true });
    expect(query.queryKey).toEqual(["recipes", HOUSEHOLD, "with-catalog"]);
    await query.queryFn();
    expect(calls.some((c) => c.op === "recipes.or")).toBe(true);
    expect(calls.some((c) => c.op === "recipes.eq")).toBe(false);
  });

  it("does nothing until there is a household", async () => {
    const { client, calls } = fakeClient();
    const query = recipesQueryOptions(client, undefined, { includeCatalog: true });
    expect(query.enabled).toBe(false);
    await expect(query.queryFn()).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("recipesQueryKey", () => {
  it("keeps the household-only key as it was, and gives the catalog list its own", () => {
    expect(recipesQueryKey(HOUSEHOLD)).toEqual(["recipes", HOUSEHOLD]);
    expect(recipesQueryKey(HOUSEHOLD, { includeCatalog: false })).toEqual(["recipes", HOUSEHOLD]);
    expect(recipesQueryKey(HOUSEHOLD, { includeCatalog: true })).toEqual([
      "recipes",
      HOUSEHOLD,
      "with-catalog",
    ]);
  });

  it("is still under the ['recipes'] prefix every write invalidates", () => {
    expect(recipesQueryKey(HOUSEHOLD, { includeCatalog: true })[0]).toBe("recipes");
  });
});

describe("fetchRecipe", () => {
  it("returns the recipe with its lines in order, and parses the instruction steps", async () => {
    const { client, calls } = fakeClient([
      {
        data: { id: RECIPE, title: "Soup", instructions: [{ step: 1, text: "Simmer." }] },
        error: null,
      },
      { data: [{ id: "l1", raw_text: "2 cups stock", position: 0 }], error: null },
    ]);
    const recipe = await fetchRecipe(client, RECIPE);
    expect(recipe?.title).toBe("Soup");
    expect(recipe?.instructions).toEqual([{ step: 1, text: "Simmer." }]);
    expect(recipe?.ingredients).toHaveLength(1);
    expect(calls).toContainEqual({ op: "recipes.is", args: ["deleted_at", null] });
    expect(calls).toContainEqual({
      op: "recipe_ingredients.order",
      args: ["position", { ascending: true }],
    });
  });

  it("returns null for a missing or deleted recipe, and tolerates malformed instructions", async () => {
    expect(await fetchRecipe(fakeClient([{ data: null, error: null }]).client, RECIPE)).toBeNull();
    const odd = await fetchRecipe(
      fakeClient([
        { data: { id: RECIPE, title: "x", instructions: "not an array" }, error: null },
        { data: [], error: null },
      ]).client,
      RECIPE,
    );
    expect(odd?.instructions).toEqual([]);
  });
});

describe("createRecipe", () => {
  it("inserts the recipe, then its lines with raw text only", async () => {
    const { client, calls } = fakeClient([{ data: { id: RECIPE }, error: null }, { error: null }]);
    const id = await createRecipe(client, {
      householdId: HOUSEHOLD,
      draft: draft(),
      sourceType: "manual",
    });
    expect(id).toBe(RECIPE);

    const insert = calls.find((c) => c.op === "recipes.insert")?.args[0] as Record<string, unknown>;
    expect(insert).toMatchObject({
      household_id: HOUSEHOLD,
      title: "Lemon Chicken",
      source_type: "manual",
      source_url: null,
      visibility: "household",
      instructions: [
        { step: 1, text: "Heat the oven." },
        { step: 2, text: "Roast." },
      ],
    });
    expect(insert).not.toHaveProperty("created_by");
    expect(insert).not.toHaveProperty("embedding");

    const lines = calls.find((c) => c.op === "recipe_ingredients.insert")?.args[0];
    expect(lines).toEqual([
      { recipe_id: RECIPE, position: 0, group_name: null, raw_text: "8 chicken thighs" },
      { recipe_id: RECIPE, position: 1, group_name: "For the pan", raw_text: "1 lemon" },
    ]);
  });

  it("keeps attribution and the stored photo path", async () => {
    const { client, calls } = fakeClient([{ data: { id: RECIPE }, error: null }, { error: null }]);
    await createRecipe(client, {
      householdId: HOUSEHOLD,
      draft: draft({ imageUrl: `${HOUSEHOLD}/card.jpg` }),
      sourceType: "video",
      sourceUrl: "https://www.tiktok.com/@a/video/1",
    });
    expect(calls.find((c) => c.op === "recipes.insert")?.args[0]).toMatchObject({
      source_type: "video",
      source_url: "https://www.tiktok.com/@a/video/1",
      image_url: `${HOUSEHOLD}/card.jpg`,
    });
  });

  it("refuses an invalid draft before any write", async () => {
    const { client, calls } = fakeClient();
    await expect(
      createRecipe(client, {
        householdId: HOUSEHOLD,
        draft: draft({ title: "" }),
        sourceType: "manual",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(calls).toHaveLength(0);
  });

  it("soft-deletes the new recipe when its lines cannot be saved", async () => {
    const { client, calls } = fakeClient([
      { data: { id: RECIPE }, error: null },
      { error: { message: "denied" } },
      { error: null },
    ]);
    await expect(
      createRecipe(client, { householdId: HOUSEHOLD, draft: draft(), sourceType: "manual" }),
    ).rejects.toBeInstanceOf(RecipeError);
    const update = calls.find((c) => c.op === "recipes.update");
    expect(update?.args[0]).toEqual({ deleted_at: expect.any(String) });
    expect(calls).toContainEqual({ op: "recipes.eq", args: ["id", RECIPE] });
  });
});

describe("updateRecipe", () => {
  const existing = [
    { id: "l1", raw_text: "8 chicken thighs", group_name: null, position: 0 },
    { id: "l2", raw_text: "1 lemon", group_name: "For the pan", position: 1 },
    { id: "l3", raw_text: "salt", group_name: null, position: 2 },
  ];

  it("updates the recipe columns a client may change and nothing else", async () => {
    const { client, calls } = fakeClient([
      { data: [{ id: RECIPE }], error: null },
      { data: existing, error: null },
    ]);
    await updateRecipe(
      client,
      RECIPE,
      draft({
        ingredients: [
          { id: "l1", rawText: "8 chicken thighs" },
          { id: "l2", rawText: "1 lemon", groupName: "For the pan" },
          { id: "l3", rawText: "salt" },
        ],
      }),
    );
    const update = calls.find((c) => c.op === "recipes.update")?.args[0] as Record<string, unknown>;
    expect(Object.keys(update).sort()).toEqual(
      [
        "title",
        "description",
        "image_url",
        "servings",
        "prep_min",
        "cook_min",
        "instructions",
        "nutrition",
        "tags",
        "cuisine",
      ].sort(),
    );
  });

  it("leaves untouched lines alone, clears the parsed fields of an edited line, deletes removed lines, and adds new ones", async () => {
    const { client, calls } = fakeClient([
      { data: [{ id: RECIPE }], error: null },
      { data: existing, error: null },
      { error: null },
      { error: null },
      { error: null },
    ]);
    await updateRecipe(
      client,
      RECIPE,
      draft({
        ingredients: [
          { id: "l1", rawText: "8 chicken thighs" }, // unchanged
          { id: "l2", rawText: "2 lemons", groupName: "For the pan" }, // text changed
          { rawText: "1 tbsp olive oil" }, // new
          // l3 removed
        ],
      }),
    );

    expect(calls).toContainEqual({ op: "recipe_ingredients.in", args: ["id", ["l3"]] });
    expect(calls.some((c) => c.op === "recipe_ingredients.delete")).toBe(true);

    const updates = calls.filter((c) => c.op === "recipe_ingredients.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.args[0]).toEqual({
      position: 1,
      group_name: "For the pan",
      raw_text: "2 lemons",
      qty: null,
      qty_max: null,
      unit: null,
      ingredient_id: null,
      prep_note: null,
      optional: false,
      parse_confidence: null,
    });
    expect(calls).toContainEqual({ op: "recipe_ingredients.eq", args: ["id", "l2"] });

    const inserts = calls.filter((c) => c.op === "recipe_ingredients.insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.args[0]).toEqual({
      recipe_id: RECIPE,
      position: 2,
      group_name: null,
      raw_text: "1 tbsp olive oil",
    });
  });

  it("only moves a line, keeping its parsed fields, when just its position or group changed", async () => {
    const { client, calls } = fakeClient([
      { data: [{ id: RECIPE }], error: null },
      { data: existing, error: null },
      { error: null },
    ]);
    await updateRecipe(
      client,
      RECIPE,
      draft({
        ingredients: [
          { id: "l3", rawText: "salt" },
          { id: "l1", rawText: "8 chicken thighs" },
          { id: "l2", rawText: "1 lemon", groupName: "For the pan" },
        ],
      }),
    );
    const updates = calls.filter((c) => c.op === "recipe_ingredients.update");
    expect(updates.map((u) => (u.args[0] as { raw_text: string }).raw_text).sort()).toEqual(
      ["8 chicken thighs", "1 lemon", "salt"].sort(),
    );
    for (const u of updates) expect(u.args[0]).not.toHaveProperty("qty");
  });

  it("reports not_found when the recipe is gone or not the caller's", async () => {
    const { client } = fakeClient([{ data: [], error: null }]);
    await expect(updateRecipe(client, RECIPE, draft())).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("refuses an invalid draft before any write", async () => {
    const { client, calls } = fakeClient();
    await expect(updateRecipe(client, RECIPE, draft({ title: " " }))).rejects.toMatchObject({
      code: "invalid",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("deleteRecipe", () => {
  it("soft-deletes by setting deleted_at, never deleting the row", async () => {
    const { client, calls } = fakeClient([{ data: [{ id: RECIPE }], error: null }]);
    await deleteRecipe(client, RECIPE);
    expect(calls.find((c) => c.op === "recipes.update")?.args[0]).toEqual({
      deleted_at: expect.any(String),
    });
    expect(calls.some((c) => c.op === "recipes.delete")).toBe(false);
  });

  it("reports not_found when nothing was updated", async () => {
    await expect(
      deleteRecipe(fakeClient([{ data: [], error: null }]).client, RECIPE),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("images", () => {
  it("tells storage paths from external links", () => {
    expect(isStorageImagePath(`${HOUSEHOLD}/a.jpg`)).toBe(true);
    expect(isStorageImagePath("https://example.com/a.jpg")).toBe(false);
    expect(isStorageImagePath("HTTP://example.com/a.jpg")).toBe(false);
    expect(isStorageImagePath(null)).toBe(false);
  });

  it("builds the household-scoped upload path and uploads without overwriting", async () => {
    expect(recipeImagePath(HOUSEHOLD, "f1", "image/jpeg")).toBe(`${HOUSEHOLD}/f1.jpg`);
    expect(recipeImagePath(HOUSEHOLD, "f1", "image/webp")).toBe(`${HOUSEHOLD}/f1.webp`);
    const { client, calls } = fakeClient([{ data: {}, error: null }]);
    const path = await uploadRecipeImage(client, {
      householdId: HOUSEHOLD,
      fileId: "f1",
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/jpeg",
    });
    expect(path).toBe(`${HOUSEHOLD}/f1.jpg`);
    expect(calls[0]).toMatchObject({
      op: "storage.recipe-images.upload",
      args: [
        `${HOUSEHOLD}/f1.jpg`,
        expect.anything(),
        { contentType: "image/jpeg", upsert: false },
      ],
    });
  });

  it("rejects an empty or oversized photo before uploading", async () => {
    const { client, calls } = fakeClient();
    const base = { householdId: HOUSEHOLD, fileId: "f", contentType: "image/jpeg" as const };
    await expect(uploadRecipeImage(client, { ...base, bytes: new Uint8Array(0) })).rejects.toThrow(
      /under 5 MB/,
    );
    await expect(
      uploadRecipeImage(client, { ...base, bytes: new Uint8Array(5 * 1024 * 1024 + 1) }),
    ).rejects.toThrow(/under 5 MB/);
    expect(calls).toHaveLength(0);
  });

  it("signs a bucket path and returns null on error or for no path", async () => {
    expect(await getRecipeImageUrl(fakeClient().client, `${HOUSEHOLD}/a.jpg`)).toBe(
      "https://signed.test/x",
    );
    expect(
      await getRecipeImageUrl(
        fakeClient([{ error: { message: "no" } }]).client,
        `${HOUSEHOLD}/a.jpg`,
      ),
    ).toBeNull();
    expect(await getRecipeImageUrl(fakeClient().client, null)).toBeNull();
  });
});

describe("importRecipe", () => {
  const jobId = "0c000000-0000-4000-8000-00000000000c";

  it("returns the success body", async () => {
    const { client, calls } = fakeClient([
      { data: { ok: true, jobId, path: "jsonld", recipeId: RECIPE, warnings: [] }, error: null },
    ]);
    const result = await importRecipe(client, { kind: "url", input: "https://example.com/r" });
    expect(result).toMatchObject({ ok: true, recipeId: RECIPE });
    expect(calls[0]).toEqual({
      op: "functions.invoke",
      args: ["recipe-import", { body: { kind: "url", input: "https://example.com/r" } }],
    });
  });

  it("throws an ImportError with the function's code for an ok:false body", async () => {
    const { client } = fakeClient([
      { data: { ok: false, error: "blocked", message: "No.", jobId }, error: null },
    ]);
    const error = await importRecipe(client, { kind: "url", input: "https://example.com/r" }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(ImportError);
    expect(error).toMatchObject({ code: "blocked", jobId });
    expect(importErrorMessage(error)).toMatch(/would not let us read/);
  });

  it("reads the body of an HTTP error response", async () => {
    // Only .json() is read from the error's context.
    const response = { json: async () => ({ ok: false, error: "no_household" }) };
    const { client } = fakeClient([], async () => ({
      data: null,
      error: new FunctionsHttpError(response as never),
    }));
    await expect(
      importRecipe(client, { kind: "text", input: "Pancakes\n2 cups flour\n1 cup milk" }),
    ).rejects.toMatchObject({
      code: "no_household",
    });
  });

  it("reports a network failure and an unreadable body as internal_error", async () => {
    const offline = fakeClient([], async () => ({
      data: null,
      error: new Error("Failed to fetch"),
    }));
    await expect(
      importRecipe(offline.client, { kind: "url", input: "https://example.com/r" }),
    ).rejects.toMatchObject({
      code: "internal_error",
    });
    const garbled = fakeClient([{ data: { hello: "world" }, error: null }]);
    await expect(
      importRecipe(garbled.client, { kind: "url", input: "https://example.com/r" }),
    ).rejects.toMatchObject({
      code: "internal_error",
    });
    expect(importErrorMessage(new Error("x"))).toMatch(/Something went wrong/);
  });
});

describe("recipeErrorMessage", () => {
  it("maps codes to text", () => {
    expect(recipeErrorMessage(new RecipeError("not_found"))).toMatch(/gone/);
    expect(recipeErrorMessage(new Error("x"))).toMatch(/Something went wrong/);
  });
});

describe("generated types", () => {
  it("agree with @mp/core on the recipe and import enums", () => {
    const enums = Constants.public.Enums;
    expect([...enums.recipes_source_type]).toEqual([...RECIPE_SOURCE_TYPES]);
    expect([...enums.recipes_visibility]).toEqual([...RECIPE_VISIBILITIES]);
    expect([...enums.import_jobs_kind]).toEqual([...IMPORT_JOB_KINDS]);
    expect([...enums.import_jobs_status]).toEqual([...IMPORT_JOB_STATUSES]);
  });
});
