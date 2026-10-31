// Matching ingredient lines after a recipe is written (the parse wiring), and the duplicate checks
// on add (WS02 follow-up, 2026-10-31). The client is a recorder: every call is logged in order,
// table queries answer from a queue, and the two Edge Functions answer from handlers.
import { IMPORT_ERROR_MESSAGES } from "@mp/core";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MpClient } from "./client";
import {
  ImportError,
  importErrorMessage,
  importRecipe,
  importRecipeAndMatch,
} from "./hooks/useImportRecipe";
import {
  createRecipe,
  createRecipeAndMatch,
  findDuplicateRecipe,
  MATCH_ERROR_MESSAGE,
  matchOrThrow,
  matchRecipeIngredients,
  needsIngredientMatch,
  PARSE_BUDGET_MS,
  PARSE_FUNCTION,
  parseRecipeIngredients,
  parseWithinBudget,
  type RecipeDraft,
  RecipeError,
  recipeErrorMessage,
  updateRecipeAndMatch,
} from "./hooks/useRecipe";

type Result = { data?: unknown; error?: { message: string; code?: string } | null };
type Call = { op: string; args: unknown[] };
type Invoke = (name: string, options: Record<string, unknown>) => Promise<unknown>;

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const RECIPE = "5ec1be00-0000-4000-8000-000000000001";
const OTHER = "5ec1be00-0000-4000-8000-0000000000ee";
const TOKEN = "user-jwt-1";

interface Options {
  /** What `auth.getSession()` holds. Null is signed out. */
  token?: string | null;
  invoke?: Invoke;
  rpc?: (name: string, args: unknown) => Promise<Result>;
}

/** Records every call in order. Table queries resolve to the next queued result. */
function recorder(results: Result[] = [], options: Options = {}) {
  const calls: Call[] = [];
  const queue = [...results];
  const next = (): Result => queue.shift() ?? { data: null, error: null };
  const token = options.token === undefined ? TOKEN : options.token;

  const chain = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const method of [
      "select",
      "insert",
      "update",
      "delete",
      "eq",
      "in",
      "is",
      "ilike",
      "order",
      "limit",
      "single",
      "maybeSingle",
    ]) {
      q[method] = (...args: unknown[]) => {
        calls.push({ op: `${table}.${method}`, args });
        return q;
      };
    }
    // biome-ignore lint/suspicious/noThenProperty: mimics PostgREST's awaitable query builder
    q.then = (resolve: (value: Result) => unknown) => resolve(next());
    return q;
  };

  const client = {
    from: (table: string) => chain(table),
    auth: {
      getSession: async () => {
        calls.push({ op: "auth.getSession", args: [] });
        return { data: { session: token ? { access_token: token } : null }, error: null };
      },
    },
    functions: {
      invoke: async (name: string, opts: Record<string, unknown>) => {
        calls.push({ op: `functions.invoke:${name}`, args: [opts] });
        return options.invoke
          ? options.invoke(name, opts)
          : { data: { ok: true, parsedRows: 3, unresolved: 1 }, error: null };
      },
    },
    rpc: async (name: string, args: unknown) => {
      calls.push({ op: `rpc:${name}`, args: [args] });
      return options.rpc ? options.rpc(name, args) : next();
    },
  };
  return { client: client as unknown as MpClient, calls };
}

const draft = (over: Partial<RecipeDraft> = {}): RecipeDraft => ({
  title: "Lemon Chicken",
  servings: 4,
  ingredients: [{ rawText: "8 chicken thighs" }, { rawText: "1 lemon" }],
  instructions: ["Roast."],
  ...over,
});

const parseCalls = (calls: Call[]) =>
  calls.filter((c) => c.op === `functions.invoke:${PARSE_FUNCTION}`);

afterEach(() => {
  vi.useRealTimers();
});

describe("parseRecipeIngredients", () => {
  it("sends the recipe id with the signed-in person's own token", async () => {
    const { client, calls } = recorder();
    const outcome = await parseRecipeIngredients(client, RECIPE);
    expect(outcome).toEqual({ ok: true, parsedRows: 3, unresolved: 1 });
    expect(parseCalls(calls)).toEqual([
      {
        op: "functions.invoke:parse-ingredients",
        args: [{ body: { recipeId: RECIPE }, headers: { Authorization: `Bearer ${TOKEN}` } }],
      },
    ]);
  });

  it("calls nothing when nobody is signed in", async () => {
    const { client, calls } = recorder([], { token: null });
    expect(await parseRecipeIngredients(client, RECIPE)).toEqual({
      ok: false,
      reason: "no_session",
    });
    expect(parseCalls(calls)).toHaveLength(0);
  });

  it("returns a value, never throws, when the function fails", async () => {
    const httpError = recorder([], {
      invoke: async () => ({ data: null, error: new Error("boom") }),
    });
    expect(await parseRecipeIngredients(httpError.client, RECIPE)).toEqual({
      ok: false,
      reason: "failed",
      message: "boom",
    });

    const refused = recorder([], {
      invoke: async () => ({ data: { ok: false, error: "recipe_not_found" }, error: null }),
    });
    expect(await parseRecipeIngredients(refused.client, RECIPE)).toEqual({
      ok: false,
      reason: "failed",
      message: "recipe_not_found",
    });

    const thrown = recorder([], {
      invoke: async () => {
        throw new Error("network down");
      },
    });
    expect(await parseRecipeIngredients(thrown.client, RECIPE)).toMatchObject({
      ok: false,
      reason: "failed",
    });
  });
});

describe("parseWithinBudget", () => {
  it("waits for the result when it comes in time", async () => {
    const { client } = recorder();
    const settled = vi.fn();
    const outcome = await parseWithinBudget(client, RECIPE, { onSettled: settled });
    expect(outcome.ok).toBe(true);
    expect(settled).toHaveBeenCalledWith(outcome);
  });

  it("lets a slow match go on in the background and reports the timeout", async () => {
    vi.useFakeTimers();
    let finish: (value: unknown) => void = () => {};
    const slow = new Promise((resolve) => {
      finish = resolve;
    });
    const { client } = recorder([], { invoke: () => slow });
    const settled = vi.fn();

    const waiting = parseWithinBudget(client, RECIPE, { budgetMs: 1000, onSettled: settled });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await waiting).toEqual({ ok: false, reason: "timeout" });
    expect(settled).not.toHaveBeenCalled();

    // The call was not cancelled: when it ends, whoever waited can still refresh the screen.
    finish({ data: { ok: true, parsedRows: 2, unresolved: 0 }, error: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledWith({ ok: true, parsedRows: 2, unresolved: 0 });
  });

  it("gives matching a budget well under a minute", () => {
    expect(PARSE_BUDGET_MS).toBeGreaterThanOrEqual(10_000);
    expect(PARSE_BUDGET_MS).toBeLessThanOrEqual(60_000);
  });
});

describe("a typed or confirmed recipe", () => {
  it("is matched right after it is saved, with its new id", async () => {
    const { client, calls } = recorder([{ data: { id: RECIPE }, error: null }, { error: null }]);
    const id = await createRecipeAndMatch(client, new QueryClient(), {
      householdId: HOUSEHOLD,
      draft: draft(),
      sourceType: "manual",
    });
    expect(id).toBe(RECIPE);

    const order = calls.map((c) => c.op);
    expect(order.indexOf("recipe_ingredients.insert")).toBeLessThan(
      order.indexOf(`functions.invoke:${PARSE_FUNCTION}`),
    );
    expect(parseCalls(calls)[0]?.args[0]).toMatchObject({ body: { recipeId: RECIPE } });
  });

  it("still saves when matching fails", async () => {
    const { client } = recorder([{ data: { id: RECIPE }, error: null }, { error: null }], {
      invoke: async () => ({ data: null, error: new Error("down") }),
    });
    await expect(
      createRecipeAndMatch(client, new QueryClient(), {
        householdId: HOUSEHOLD,
        draft: draft(),
        sourceType: "manual",
      }),
    ).resolves.toBe(RECIPE);
  });

  it("is not matched when nothing was saved", async () => {
    const invalid = recorder();
    await expect(
      createRecipeAndMatch(invalid.client, new QueryClient(), {
        householdId: HOUSEHOLD,
        draft: draft({ title: "" }),
        sourceType: "manual",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(parseCalls(invalid.calls)).toHaveLength(0);

    const refused = recorder([{ data: null, error: { message: "denied" } }]);
    await expect(
      createRecipeAndMatch(refused.client, new QueryClient(), {
        householdId: HOUSEHOLD,
        draft: draft(),
        sourceType: "manual",
      }),
    ).rejects.toBeInstanceOf(RecipeError);
    expect(parseCalls(refused.calls)).toHaveLength(0);
  });
});

describe("an edit", () => {
  const before = [
    { id: "l1", raw_text: "8 chicken thighs", group_name: null, position: 0 },
    { id: "l2", raw_text: "1 lemon", group_name: null, position: 1 },
  ];

  /** The recipe update, the lines read, then one ok per line write the edit makes. */
  const edit = (writes: number) =>
    recorder([
      { data: [{ id: RECIPE }], error: null },
      { data: before, error: null },
      ...Array.from({ length: writes }, () => ({ error: null })),
    ]);

  it("is matched when a line's text changed", async () => {
    const { client, calls } = edit(1);
    const result = await updateRecipeAndMatch(
      client,
      new QueryClient(),
      RECIPE,
      draft({
        ingredients: [
          { id: "l1", rawText: "8 chicken thighs" },
          { id: "l2", rawText: "2 lemons" },
        ],
      }),
    );
    expect(result).toEqual({ needsParse: true });
    expect(parseCalls(calls)).toHaveLength(1);
    expect(parseCalls(calls)[0]?.args[0]).toMatchObject({ body: { recipeId: RECIPE } });
    // The parsed fields of the edited line were cleared first, which is what makes the function read it.
    const cleared = calls.find((c) => c.op === "recipe_ingredients.update")?.args[0];
    expect(cleared).toMatchObject({ raw_text: "2 lemons", parse_confidence: null });
  });

  it("is matched when a line was added", async () => {
    const { client, calls } = edit(1);
    await updateRecipeAndMatch(
      client,
      new QueryClient(),
      RECIPE,
      draft({
        ingredients: [
          { id: "l1", rawText: "8 chicken thighs" },
          { id: "l2", rawText: "1 lemon" },
          { rawText: "1 tbsp olive oil" },
        ],
      }),
    );
    expect(parseCalls(calls)).toHaveLength(1);
  });

  it("is not matched when only the title changed", async () => {
    const { client, calls } = edit(0);
    const result = await updateRecipeAndMatch(
      client,
      new QueryClient(),
      RECIPE,
      draft({
        title: "Better Lemon Chicken",
        ingredients: [
          { id: "l1", rawText: "8 chicken thighs" },
          { id: "l2", rawText: "1 lemon" },
        ],
      }),
    );
    expect(result).toEqual({ needsParse: false });
    expect(parseCalls(calls)).toHaveLength(0);
  });

  it("is not matched when lines were only removed or moved", async () => {
    const removed = edit(1);
    await updateRecipeAndMatch(
      removed.client,
      new QueryClient(),
      RECIPE,
      draft({ ingredients: [{ id: "l1", rawText: "8 chicken thighs" }] }),
    );
    expect(parseCalls(removed.calls)).toHaveLength(0);

    const moved = edit(2);
    await updateRecipeAndMatch(
      moved.client,
      new QueryClient(),
      RECIPE,
      draft({
        ingredients: [
          { id: "l2", rawText: "1 lemon" },
          { id: "l1", rawText: "8 chicken thighs" },
        ],
      }),
    );
    expect(parseCalls(moved.calls)).toHaveLength(0);
  });

  it("is not matched when the edit itself failed", async () => {
    const { client, calls } = recorder([{ data: [], error: null }]);
    await expect(
      updateRecipeAndMatch(client, new QueryClient(), RECIPE, draft()),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(parseCalls(calls)).toHaveLength(0);
  });
});

describe("an edit of a recipe with a line the parser split in two", () => {
  // "salt and pepper to taste" is rows l2 (salt) and l2x (pepper): same position, heading and text.
  // The edit form shows the line once, so the draft carries l2 only.
  const rows = [
    { id: "l1", raw_text: "8 chicken thighs", group_name: null, position: 0 },
    { id: "l2", raw_text: "salt and pepper to taste", group_name: null, position: 1 },
    { id: "l2x", raw_text: "salt and pepper to taste", group_name: null, position: 1 },
  ];
  const run = async (ingredients: RecipeDraft["ingredients"], writes: number) => {
    const { client, calls } = recorder([
      { data: [{ id: RECIPE }], error: null },
      { data: rows, error: null },
      ...Array.from({ length: writes }, () => ({ error: null })),
    ]);
    const result = await updateRecipeAndMatch(
      client,
      new QueryClient(),
      RECIPE,
      draft({ ingredients }),
    );
    return { calls, result };
  };
  const lineOne = { id: "l1", rawText: "8 chicken thighs" };
  const split = { id: "l2", rawText: "salt and pepper to taste" };

  it("keeps the extra row when the line is left alone", async () => {
    const { calls, result } = await run([lineOne, split], 0);
    expect(calls.some((c) => c.op === "recipe_ingredients.delete")).toBe(false);
    expect(calls.some((c) => c.op === "recipe_ingredients.update")).toBe(false);
    expect(result).toEqual({ needsParse: false });
    expect(parseCalls(calls)).toHaveLength(0);
  });

  it("moves the extra row along when the line moves", async () => {
    // A new first line pushes both lines down one place.
    const { calls } = await run([{ rawText: "2 eggs" }, lineOne, split], 4);
    expect(calls.some((c) => c.op === "recipe_ingredients.delete")).toBe(false);
    const extraUpdate = calls.findIndex(
      (c) => c.op === "recipe_ingredients.in" && JSON.stringify(c.args) === '["id",["l2x"]]',
    );
    expect(extraUpdate).toBeGreaterThan(-1);
    const payload = calls
      .slice(0, extraUpdate)
      .reverse()
      .find((c) => c.op === "recipe_ingredients.update")?.args[0];
    expect(payload).toEqual({ position: 2, group_name: null });
  });

  it("drops the extra row, and matches the line again, when the line's text changes", async () => {
    const { calls, result } = await run([lineOne, { id: "l2", rawText: "salt to taste" }], 1);
    expect(calls).toContainEqual({ op: "recipe_ingredients.in", args: ["id", ["l2x"]] });
    expect(calls.some((c) => c.op === "recipe_ingredients.delete")).toBe(true);
    expect(result).toEqual({ needsParse: true });
    expect(parseCalls(calls)).toHaveLength(1);
  });

  it("deletes both rows when the line is taken out", async () => {
    const { calls } = await run([lineOne], 0);
    expect(calls).toContainEqual({ op: "recipe_ingredients.in", args: ["id", ["l2", "l2x"]] });
  });

  it("does not treat two lines the person wrote the same as one line the parser split", async () => {
    // Both rows are in the draft with their own ids: both are the person's lines.
    const { calls } = await run(
      [lineOne, split, { id: "l2x", rawText: "salt and pepper to taste" }],
      0,
    );
    expect(calls.some((c) => c.op === "recipe_ingredients.delete")).toBe(false);
  });
});

describe("an import", () => {
  const jobId = "0c000000-0000-4000-8000-00000000000c";
  const saved = { ok: true, jobId, path: "jsonld", recipeId: RECIPE, warnings: [] };

  /** recipe-import answers `body`; parse-ingredients answers its usual success. */
  const importing = (body: unknown) =>
    recorder([], {
      invoke: async (name) =>
        name === "recipe-import"
          ? { data: body, error: null }
          : { data: { ok: true, parsedRows: 8, unresolved: 0 }, error: null },
    });

  it("is followed by a parse call with the new recipe's id and the person's token", async () => {
    const { client, calls } = importing(saved);
    const result = await importRecipeAndMatch(client, new QueryClient(), {
      kind: "url",
      input: "https://example.test/r",
    });
    expect(result).toMatchObject({ ok: true, recipeId: RECIPE });

    const invokes = calls.filter((c) => c.op.startsWith("functions.invoke:"));
    expect(invokes.map((c) => c.op)).toEqual([
      "functions.invoke:recipe-import",
      "functions.invoke:parse-ingredients",
    ]);
    expect(invokes[1]?.args[0]).toEqual({
      body: { recipeId: RECIPE },
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  });

  it("still opens the recipe when matching fails", async () => {
    const { client } = recorder([], {
      invoke: async (name) =>
        name === "recipe-import"
          ? { data: saved, error: null }
          : { data: null, error: new Error("down") },
    });
    await expect(
      importRecipeAndMatch(client, new QueryClient(), { kind: "text", input: "x".repeat(40) }),
    ).resolves.toMatchObject({ recipeId: RECIPE });
  });

  it("matches nothing for a draft, which has no recipe yet", async () => {
    const draftBody = {
      ok: true,
      jobId,
      path: "vision",
      draft: { title: "Soup", ingredients: [{ rawText: "stock" }], instructions: [] },
      warnings: [],
    };
    const { client, calls } = importing(draftBody);
    await importRecipeAndMatch(client, new QueryClient(), {
      kind: "image",
      input: { path: `${HOUSEHOLD}/a.jpg` },
      save: false,
    });
    expect(parseCalls(calls)).toHaveLength(0);
  });

  it("matches nothing for an import that failed, or that found a duplicate", async () => {
    const blocked = importing({ ok: false, error: "blocked", message: "No." });
    await expect(
      importRecipeAndMatch(blocked.client, new QueryClient(), {
        kind: "url",
        input: "https://example.test/r",
      }),
    ).rejects.toMatchObject({ code: "blocked" });
    expect(parseCalls(blocked.calls)).toHaveLength(0);

    const dup = importing({ ok: false, error: "duplicate", recipeId: OTHER, matchedBy: "url" });
    await expect(
      importRecipeAndMatch(dup.client, new QueryClient(), {
        kind: "url",
        input: "https://example.test/r",
      }),
    ).rejects.toMatchObject({ code: "duplicate" });
    expect(parseCalls(dup.calls)).toHaveLength(0);
  });
});

describe("Match ingredients", () => {
  const lines = (...confidence: Array<number | null>) =>
    confidence.map((parse_confidence, i) => ({ id: `l${i}`, parse_confidence }));

  it("is offered while a household recipe has an unparsed line", () => {
    const ingredients = lines(0.9, null) as never;
    expect(needsIngredientMatch({ visibility: "household", ingredients })).toBe(true);
  });

  it("is not offered once every line is parsed, even with low confidence or no ingredient found", () => {
    const ingredients = lines(0.95, 0.2, 0) as never;
    expect(needsIngredientMatch({ visibility: "household", ingredients })).toBe(false);
    expect(needsIngredientMatch({ visibility: "household", ingredients: [] })).toBe(false);
  });

  it("is never offered for a catalog recipe", () => {
    const ingredients = lines(null, null) as never;
    expect(needsIngredientMatch({ visibility: "catalog", ingredients })).toBe(false);
  });

  it("sends a household recipe to the function, with the person's token", async () => {
    const { client, calls } = recorder();
    const outcome = await matchRecipeIngredients(client, { id: RECIPE, visibility: "household" });
    expect(outcome.ok).toBe(true);
    expect(parseCalls(calls)[0]?.args[0]).toEqual({
      body: { recipeId: RECIPE },
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  });

  it("sends a catalog recipe nowhere", async () => {
    const { client, calls } = recorder();
    expect(await matchRecipeIngredients(client, { id: RECIPE, visibility: "catalog" })).toEqual({
      ok: false,
      reason: "catalog",
    });
    expect(calls).toHaveLength(0);
  });

  it("throws a message the screen can show when matching fails, and nothing when it works", async () => {
    const down = recorder([], { invoke: async () => ({ data: null, error: new Error("down") }) });
    const error = await matchOrThrow(down.client, { id: RECIPE, visibility: "household" }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(RecipeError);
    expect(error.message).toBe(MATCH_ERROR_MESSAGE);
    expect(error.message).toMatch(/recipe is saved/);

    const catalog = await matchOrThrow(recorder().client, {
      id: RECIPE,
      visibility: "catalog",
    }).catch((e) => e);
    expect(catalog).toBeInstanceOf(RecipeError);

    await expect(
      matchOrThrow(recorder().client, { id: RECIPE, visibility: "household" }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("can be tried again after a failure", async () => {
    let attempts = 0;
    const { client } = recorder([], {
      invoke: async () => {
        attempts += 1;
        return attempts === 1
          ? { data: null, error: new Error("down") }
          : { data: { ok: true, parsedRows: 5, unresolved: 0 }, error: null };
      },
    });
    const recipe = { id: RECIPE, visibility: "household" as const };
    expect((await matchRecipeIngredients(client, recipe)).ok).toBe(false);
    expect(await matchRecipeIngredients(client, recipe)).toEqual({
      ok: true,
      parsedRows: 5,
      unresolved: 0,
    });
  });
});

describe("importRecipe: what the function says is what the person reads", () => {
  const url = { kind: "url", input: "https://example.test/r" } as const;

  it("turns the duplicate answer into an ImportError that names the existing recipe", async () => {
    const { client } = recorder([], {
      invoke: async () => ({
        data: {
          ok: false,
          error: "duplicate",
          message: IMPORT_ERROR_MESSAGES.duplicate,
          recipeId: OTHER,
          matchedBy: "title",
          jobId: "0c000000-0000-4000-8000-00000000000c",
        },
        error: null,
      }),
    });
    const error = await importRecipe(client, url).catch((e) => e);
    expect(error).toBeInstanceOf(ImportError);
    expect(error).toMatchObject({
      code: "duplicate",
      existing: { recipeId: OTHER, matchedBy: "title" },
    });
    expect(importErrorMessage(error)).toBe("You already have this recipe.");
  });

  it("reads a same-link duplicate as such", async () => {
    const { client } = recorder([], {
      invoke: async () => ({
        data: { ok: false, error: "duplicate", recipeId: OTHER, matchedBy: "url" },
        error: null,
      }),
    });
    const error = await importRecipe(client, url).catch((e) => e);
    expect(error.existing).toEqual({ recipeId: OTHER, matchedBy: "url" });
  });

  it("sends allowDuplicate with the request", async () => {
    const { client, calls } = recorder([], {
      invoke: async () => ({
        data: {
          ok: true,
          jobId: "0c000000-0000-4000-8000-00000000000c",
          path: "text",
          recipeId: RECIPE,
          warnings: [],
        },
        error: null,
      }),
    });
    await importRecipe(client, { kind: "text", input: "x".repeat(30), allowDuplicate: true });
    expect(calls[0]?.args[0]).toEqual({
      body: { kind: "text", input: "x".repeat(30), allowDuplicate: true },
    });
  });

  it("shows the function's own message for a failure, not the table's", async () => {
    const { client } = recorder([], {
      invoke: async () => ({
        data: {
          ok: false,
          error: "invalid_request",
          message: "That address uses an unusual port.",
        },
        error: null,
      }),
    });
    const error = await importRecipe(client, url).catch((e) => e);
    expect(error).toMatchObject({ code: "invalid_request" });
    expect(importErrorMessage(error)).toBe("That address uses an unusual port.");
  });

  it("falls back to the table's text when the function sent no message", async () => {
    const { client } = recorder([], {
      invoke: async () => ({ data: { ok: false, error: "blocked" }, error: null }),
    });
    const error = await importRecipe(client, url).catch((e) => e);
    expect(importErrorMessage(error)).toMatch(/would not let us read/);
  });

  it("reads the body of an HTTP error, and maps a gateway answer by its status", async () => {
    const withBody = (status: number, body: unknown) =>
      recorder([], {
        invoke: async () => ({
          data: null,
          error: new FunctionsHttpError({ status, json: async () => body } as never),
        }),
      }).client;

    const gateway = await importRecipe(
      withBody(401, { code: 401, message: "Invalid JWT" }),
      url,
    ).catch((e) => e);
    expect(gateway).toMatchObject({ code: "unauthorized" });
    expect(importErrorMessage(gateway)).toMatch(/Sign in again/);

    const big = await importRecipe(withBody(413, null), url).catch((e) => e);
    expect(big).toMatchObject({ code: "invalid_request" });
    expect(importErrorMessage(big)).toBe("The request is too large.");

    const throttled = await importRecipe(withBody(429, null), url).catch((e) => e);
    expect(throttled).toMatchObject({ code: "rate_limited" });

    const down = await importRecipe(withBody(502, { message: "Bad gateway" }), url).catch((e) => e);
    expect(down).toMatchObject({ code: "internal_error" });
    expect(importErrorMessage(down)).toBe("Bad gateway");

    const fromFunction = await importRecipe(
      withBody(400, { ok: false, error: "no_household" }),
      url,
    ).catch((e) => e);
    expect(fromFunction).toMatchObject({ code: "no_household" });
  });

  it("treats a code it does not know as an internal error, keeping the function's message", async () => {
    const { client } = recorder([], {
      invoke: async () => ({
        data: { ok: false, error: "from_the_future", message: "Try later." },
        error: null,
      }),
    });
    const error = await importRecipe(client, url).catch((e) => e);
    expect(error).toMatchObject({ code: "internal_error" });
    expect(importErrorMessage(error)).toBe("Try later.");
  });
});

describe("findDuplicateRecipe", () => {
  it("finds a live recipe of the household by its normalized link", async () => {
    const { client, calls } = recorder([{ data: { id: OTHER }, error: null }]);
    const found = await findDuplicateRecipe(client, HOUSEHOLD, {
      sourceUrlNormalized: "https://example.test/r",
    });
    expect(found).toEqual({ recipeId: OTHER, matchedBy: "url" });
    expect(calls).toEqual(
      expect.arrayContaining([
        { op: "recipes.eq", args: ["household_id", HOUSEHOLD] },
        { op: "recipes.is", args: ["deleted_at", null] },
        { op: "recipes.eq", args: ["source_url_normalized", "https://example.test/r"] },
      ]),
    );
  });

  it("finds nothing for an unknown link, and compares titles exactly among the prefiltered rows", async () => {
    expect(
      await findDuplicateRecipe(recorder([{ data: null, error: null }]).client, HOUSEHOLD, {
        sourceUrlNormalized: "https://example.test/none",
      }),
    ).toBeNull();

    const { client, calls } = recorder([
      {
        data: [
          { id: "a", title: "Lemon roast chicken" },
          { id: OTHER, title: "lemon   CHICKEN" },
        ],
        error: null,
      },
    ]);
    const found = await findDuplicateRecipe(client, HOUSEHOLD, {
      title: {
        pattern: "%lemon%chicken%",
        isSame: (c) => c.replace(/\s+/g, " ").toLowerCase() === "lemon chicken",
      },
    });
    expect(found).toEqual({ recipeId: OTHER, matchedBy: "title" });
    expect(calls).toContainEqual({ op: "recipes.ilike", args: ["title", "%lemon%chicken%"] });
  });

  it("looks at the link alone when there is one, and at nothing with nothing to compare", async () => {
    const { client, calls } = recorder([{ data: null, error: null }]);
    await findDuplicateRecipe(client, HOUSEHOLD, {
      sourceUrlNormalized: "https://example.test/r",
      title: { pattern: "%x%", isSame: () => true },
    });
    expect(calls.some((c) => c.op === "recipes.ilike")).toBe(false);
    expect(await findDuplicateRecipe(recorder().client, HOUSEHOLD, {})).toBeNull();
  });

  it("throws on a database error", async () => {
    const { client } = recorder([{ data: null, error: { message: "boom" } }]);
    await expect(
      findDuplicateRecipe(client, HOUSEHOLD, { sourceUrlNormalized: "x" }),
    ).rejects.toBeInstanceOf(RecipeError);
  });
});

describe("createRecipe and a recipe the household already has", () => {
  const titleCheck = {
    pattern: "%lemon%chicken%",
    isSame: (c: string) => c.toLowerCase() === "lemon chicken",
  };

  it("refuses a second save of the same link and says which recipe it is, writing nothing", async () => {
    const { client, calls } = recorder([{ data: { id: OTHER }, error: null }]);
    const error = await createRecipe(client, {
      householdId: HOUSEHOLD,
      draft: draft(),
      sourceType: "video",
      sourceUrl: "https://www.tiktok.com/@a/video/1",
      duplicateCheck: { sourceUrlNormalized: "https://www.tiktok.com/@a/video/1" },
    }).catch((e) => e);
    expect(error).toBeInstanceOf(RecipeError);
    expect(error).toMatchObject({
      code: "duplicate",
      existing: { recipeId: OTHER, matchedBy: "url" },
    });
    expect(recipeErrorMessage(error)).toBe("You already have this recipe.");
    expect(calls.some((c) => c.op === "recipes.insert")).toBe(false);
  });

  it("refuses a same-title recipe too, unless the person says add anyway", async () => {
    const refused = recorder([{ data: [{ id: OTHER, title: "Lemon Chicken" }], error: null }]);
    await expect(
      createRecipe(refused.client, {
        householdId: HOUSEHOLD,
        draft: draft(),
        sourceType: "manual",
        duplicateCheck: { title: titleCheck },
      }),
    ).rejects.toMatchObject({ code: "duplicate", existing: { matchedBy: "title" } });

    const allowed = recorder([{ data: { id: RECIPE }, error: null }, { error: null }]);
    await expect(
      createRecipe(allowed.client, {
        householdId: HOUSEHOLD,
        draft: draft(),
        sourceType: "manual",
        duplicateCheck: { title: titleCheck },
        allowDuplicate: true,
      }),
    ).resolves.toBe(RECIPE);
    // Add anyway skips the title lookup altogether.
    expect(allowed.calls.some((c) => c.op === "recipes.ilike")).toBe(false);
  });

  it("does not let add anyway through for a link: the database keeps one live recipe per link", async () => {
    const { client, calls } = recorder([{ data: { id: OTHER }, error: null }]);
    await expect(
      createRecipe(client, {
        householdId: HOUSEHOLD,
        draft: draft(),
        sourceType: "video",
        sourceUrl: "https://www.tiktok.com/@a/video/1",
        duplicateCheck: { sourceUrlNormalized: "https://www.tiktok.com/@a/video/1" },
        allowDuplicate: true,
      }),
    ).rejects.toMatchObject({ code: "duplicate", existing: { matchedBy: "url" } });
    expect(calls.some((c) => c.op === "recipes.insert")).toBe(false);
  });

  it("saves as before when nothing matches or no check is asked for", async () => {
    const none = recorder([
      { data: [], error: null },
      { data: { id: RECIPE }, error: null },
      { error: null },
    ]);
    await expect(
      createRecipe(none.client, {
        householdId: HOUSEHOLD,
        draft: draft(),
        sourceType: "manual",
        duplicateCheck: { title: titleCheck },
      }),
    ).resolves.toBe(RECIPE);

    const unchecked = recorder([{ data: { id: RECIPE }, error: null }, { error: null }]);
    await createRecipe(unchecked.client, {
      householdId: HOUSEHOLD,
      draft: draft(),
      sourceType: "manual",
    });
    expect(
      unchecked.calls.some((c) => c.op === "recipes.select" && c.args[0] === "id, title"),
    ).toBe(false);
  });

  it("answers a lost race for a link the way the check would have", async () => {
    const { client, calls } = recorder(
      [
        {
          data: null,
          error: {
            code: "23505",
            message:
              'duplicate key value violates unique constraint "recipes_household_source_url_normalized_uq"',
          },
        },
        { data: { id: OTHER }, error: null },
      ],
      { rpc: async () => ({ data: "https://www.tiktok.com/@a/video/1", error: null }) },
    );
    const error = await createRecipe(client, {
      householdId: HOUSEHOLD,
      draft: draft(),
      sourceType: "video",
      sourceUrl: "https://www.tiktok.com/@a/video/1?igsh=x",
    }).catch((e) => e);
    expect(error).toMatchObject({
      code: "duplicate",
      existing: { recipeId: OTHER, matchedBy: "url" },
    });
    expect(calls).toContainEqual({
      op: "rpc:normalize_source_url",
      args: [{ raw: "https://www.tiktok.com/@a/video/1?igsh=x" }],
    });
    expect(calls.some((c) => c.op === "recipe_ingredients.insert")).toBe(false);
  });

  it("leaves any other insert failure as an ordinary error", async () => {
    const { client } = recorder([
      {
        data: null,
        error: { code: "23505", message: 'violates unique constraint "recipes_pkey"' },
      },
    ]);
    await expect(
      createRecipe(client, {
        householdId: HOUSEHOLD,
        draft: draft(),
        sourceType: "video",
        sourceUrl: "https://www.tiktok.com/@a/video/1",
      }),
    ).rejects.toMatchObject({ code: "unknown" });
  });
});
