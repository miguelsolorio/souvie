import { describe, expect, it, vi } from "vitest";
import { seedOntology } from "../../../packages/ingredient-parser/evals/seed-ontology.ts";
import type {
  AliasProposal,
  LlmBatchResult,
  LlmItem,
  LlmParseClient,
  LlmUsage,
} from "../../../packages/ingredient-parser/src/index.ts";
import { ingredientId } from "../../seed/load.ts";

// supabase-js is only needed by the real runtime; the tests inject their own.
vi.mock("./client.ts", () => ({ createClient: vi.fn() }));

const { handleParseIngredients, MAX_LINES, MAX_LINE_LENGTH, readBody, rowValues } = await import(
  "./index.ts"
);
type Runtime = import("./index.ts").Runtime;
type RowInsert = import("./store.ts").RowInsert;
type RowUpdate = import("./store.ts").RowUpdate;
type RecipeIngredientRow = import("./store.ts").RecipeIngredientRow;

const ontology = seedOntology();
const RECIPE_ID = "3f1d5c2e-8a49-4b6a-9c0f-0a8d1f7e2b11";
const HOUSEHOLD_ID = "9b1e0f55-31de-4a0a-8d57-2d9a5b4c7e10";

class FakeModel implements LlmParseClient {
  readonly model = "fake-haiku";
  readonly promptVersion = "test";
  calls = 0;
  async parseBatch(lines: readonly string[]): Promise<LlmBatchResult> {
    this.calls++;
    const item: LlmItem = {
      qty: 1,
      qty_max: null,
      unit: "tbsp",
      ingredient: "gochugaru",
      category: "international",
      prep: null,
      optional: false,
      confidence: 0.9,
    };
    return {
      byIndex: new Map(lines.map((_l, i) => [i, [item]])),
      usage: {
        model: this.model,
        promptVersion: this.promptVersion,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        latencyMs: 1,
        ok: true,
        lines: lines.length,
      },
    };
  }
}

interface Harness {
  runtime: Runtime;
  proposals: AliasProposal[];
  saved: { updates: RowUpdate[]; inserts: RowInsert[] }[];
  households: (string | null)[];
  finished: number;
  model: FakeModel;
}

function harness(
  options: {
    user?: boolean;
    rows?: RecipeIngredientRow[] | null;
    withModel?: boolean;
    saveFails?: boolean;
  } = {},
): Harness {
  const h: Harness = {
    proposals: [],
    saved: [],
    households: [],
    finished: 0,
    model: new FakeModel(),
    runtime: undefined as never,
  };
  const usages: LlmUsage[] = [];
  h.runtime = {
    async authenticate() {
      return options.user === false ? null : { userId: "user-1" };
    },
    recipes: {
      async load(_auth, recipeId) {
        if (options.rows === null || recipeId !== RECIPE_ID) return null;
        return { householdId: HOUSEHOLD_ID, rows: options.rows ?? [] };
      },
      async save(_auth, _id, updates, inserts) {
        if (options.saveFails) throw new Error("connection reset");
        h.saved.push({ updates, inserts });
      },
    },
    createRun(householdId) {
      h.households.push(householdId);
      return {
        deps: {
          ontology,
          proposals: { record: async (p) => void h.proposals.push(p) },
          onLlmRun: (u) => void usages.push(u),
          ...(options.withModel ? { llm: h.model } : {}),
        },
        usages,
        hasModel: options.withModel === true,
        async finish() {
          h.finished++;
        },
      };
    },
  };
  return h;
}

const URL_ = "http://localhost:54321/functions/v1/parse-ingredients";
const post = (
  body: unknown,
  headers: Record<string, string> = { authorization: "Bearer test-token" },
) =>
  new Request(URL_, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("request guards", () => {
  it("answers CORS preflight and rejects other methods", async () => {
    const h = harness();
    expect(
      (await handleParseIngredients(new Request(URL_, { method: "OPTIONS" }), h.runtime)).status,
    ).toBe(204);
    const res = await handleParseIngredients(new Request(URL_, { method: "GET" }), h.runtime);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("POST");
  });

  it("requires a bearer token and a user the runtime accepts", async () => {
    expect(
      (await handleParseIngredients(post({ lines: ["1 cup flour"] }, {}), harness().runtime))
        .status,
    ).toBe(401);
    expect(
      (
        await handleParseIngredients(
          post({ lines: ["1 cup flour"] }, { authorization: "Basic abc" }),
          harness().runtime,
        )
      ).status,
    ).toBe(401);
    const res = await handleParseIngredients(
      post({ lines: ["1 cup flour"] }),
      harness({ user: false }).runtime,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await handleParseIngredients(post("{not json"), harness().runtime);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "invalid_json" });
  });

  it.each([
    [null, "body_must_be_an_object"],
    [[], "body_must_be_an_object"],
    [{}, "send_lines_or_recipeId"],
    [{ lines: [], recipeId: RECIPE_ID }, "send_lines_or_recipeId_not_both"],
    [{ lines: "1 cup flour" }, "lines_must_be_strings"],
    [{ lines: [1, 2] }, "lines_must_be_strings"],
    [{ lines: [] }, "lines_must_not_be_empty"],
    [{ lines: Array(MAX_LINES + 1).fill("1 cup flour") }, `too_many_lines_max_${MAX_LINES}`],
    [{ lines: ["x".repeat(MAX_LINE_LENGTH + 1)] }, `line_too_long_max_${MAX_LINE_LENGTH}`],
    [{ recipeId: "not-a-uuid" }, "recipeId_must_be_a_uuid"],
    [{ recipeId: 5 }, "recipeId_must_be_a_uuid"],
  ])("rejects %j", async (body, error) => {
    expect(readBody(body)).toEqual({ kind: "error", error });
    const res = await handleParseIngredients(post(body), harness().runtime);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error });
  });
});

describe("lines mode", () => {
  it("parses lines and returns one result list per line", async () => {
    const h = harness();
    const res = await handleParseIngredients(
      post({
        lines: ["2 cups diced yellow onion", "salt and pepper to taste", "1 tablespoon gochugaru"],
      }),
      h.runtime,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      results: {
        ingredientName: string | null;
        ingredientId: string | null;
        splitFrom?: string;
      }[][];
      meta: Record<string, unknown>;
    };
    expect(body.results).toHaveLength(3);
    expect(body.results[0]?.[0]).toMatchObject({
      ingredientName: "yellow onion",
      ingredientId: ingredientId("yellow onion"),
    });
    expect(body.results[1]?.map((r) => r.ingredientName)).toEqual(["salt", "black pepper"]);
    expect(body.results[1]?.every((r) => r.splitFrom === "salt and pepper to taste")).toBe(true);
    expect(body.results[2]?.[0]).toMatchObject({ ingredientName: "gochugaru", ingredientId: null });
    expect(body.meta).toMatchObject({
      ingredients: 4,
      unresolved: 1,
      lowConfidence: 1,
      modelCalls: 0,
      modelAvailable: false,
    });
    expect(h.proposals.map((p) => p.proposedName)).toEqual(["gochugaru"]);
    expect(h.households).toEqual([null]);
    expect(h.finished).toBe(1);
  });

  it("sends only the uncertain lines to the model", async () => {
    const h = harness({ withModel: true });
    const res = await handleParseIngredients(
      post({ lines: ["1 cup flour", "1 tablespoon gochugaru"] }),
      h.runtime,
    );
    const body = (await res.json()) as { meta: { modelCalls: number; modelAvailable: boolean } };
    expect(h.model.calls).toBe(1);
    expect(body.meta).toMatchObject({ modelCalls: 1, modelAvailable: true });
  });
});

describe("recipe mode", () => {
  const rows: RecipeIngredientRow[] = [
    { id: "r1", position: 0, groupName: null, rawText: "2-3 cloves garlic, minced" },
    { id: "r2", position: 1, groupName: "Seasoning", rawText: "salt and pepper to taste" },
    { id: "r3", position: 2, groupName: "Seasoning", rawText: "1 tablespoon gochugaru" },
  ];

  it("updates each row, inserts the extra ingredient of a split line, and counts the results", async () => {
    const h = harness({ rows });
    const res = await handleParseIngredients(post({ recipeId: RECIPE_ID }), h.runtime);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      recipeId: RECIPE_ID,
      parsedRows: 3,
      ingredients: 4,
      lowConfidence: 1,
      unresolved: 1,
      modelCalls: 0,
    });
    expect(h.saved).toHaveLength(1);
    const { updates, inserts } = h.saved[0] ?? { updates: [], inserts: [] };
    expect(updates.map((u) => u.id)).toEqual(["r1", "r2", "r3"]);
    // A range keeps both ends: qty is the lower bound, qty_max the upper.
    expect(updates[0]).toMatchObject({
      qty: 2,
      qty_max: 3,
      unit: "clove",
      ingredient_id: ingredientId("garlic"),
      prep_note: "minced",
      optional: false,
    });
    expect(updates[1]).toMatchObject({
      qty: null,
      unit: null,
      ingredient_id: ingredientId("salt"),
      prep_note: "to taste",
    });
    expect(updates[2]).toMatchObject({ qty: 1, qty_max: null, unit: "tbsp", ingredient_id: null });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      recipe_id: RECIPE_ID,
      position: 1,
      group_name: "Seasoning",
      raw_text: "salt and pepper to taste",
      ingredient_id: ingredientId("black pepper"),
    });
    expect(h.households).toEqual([HOUSEHOLD_ID]);
    expect(h.finished).toBe(1);
  });

  it("returns 404 when the recipe is not visible to the caller", async () => {
    const res = await handleParseIngredients(
      post({ recipeId: RECIPE_ID }),
      harness({ rows: null }).runtime,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "recipe_not_found" });
  });

  it("does nothing, successfully, when every row is already parsed", async () => {
    const h = harness({ rows: [] });
    const res = await handleParseIngredients(post({ recipeId: RECIPE_ID }), h.runtime);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ parsedRows: 0 });
    expect(h.saved).toHaveLength(0);
  });

  it("hides storage errors behind a generic 500", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await handleParseIngredients(
      post({ recipeId: RECIPE_ID }),
      harness({ rows, saveFails: true }).runtime,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "internal_error" });
    spy.mockRestore();
  });
});

describe("rowValues", () => {
  it("maps a parse to recipe_ingredients columns", () => {
    expect(
      rowValues({
        rawText: "1 cup flour",
        qty: 1,
        unit: "cup",
        ingredientId: "id-1",
        ingredientName: "all-purpose flour",
        prepNote: null,
        optional: true,
        confidence: 0.97,
        stage: "grammar",
      }),
    ).toEqual({
      qty: 1,
      qty_max: null,
      unit: "cup",
      ingredient_id: "id-1",
      prep_note: null,
      optional: true,
      parse_confidence: 0.97,
    });
  });

  it("keeps a range as qty (lower bound) and qty_max (upper bound)", () => {
    expect(
      rowValues({
        rawText: "2-3 cloves garlic",
        qty: 2,
        qtyMax: 3,
        unit: "clove",
        ingredientId: "id-2",
        ingredientName: "garlic",
        prepNote: null,
        optional: false,
        confidence: 0.95,
        stage: "grammar",
      }),
    ).toMatchObject({ qty: 2, qty_max: 3 });
  });
});
