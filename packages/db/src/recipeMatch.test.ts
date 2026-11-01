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
  useImportRecipe,
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
  parseAfterWrite,
  parseRecipeIngredients,
  parseWithinBudget,
  type RecipeDraft,
  RecipeError,
  recipeErrorMessage,
  recipeQueryKey,
  refreshRecipe,
  updateRecipeAndMatch,
  useCreateRecipe,
  useMatchIngredients,
  useUpdateRecipe,
} from "./hooks/useRecipe";

// The hooks are called as plain functions here, with the three things they lean on replaced:
// useMutation hands back the options it was given (so a test can run `mutationFn` and
// `onSuccess` itself), useQueryClient returns a spy, and useSupabase returns the recorder.
const h = vi.hoisted(() => ({ client: null as unknown, queryClient: null as unknown }));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useMutation: (options: unknown) => options,
  useQueryClient: () => h.queryClient,
}));
vi.mock("./context", () => ({ useSupabase: () => h.client }));

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

describe("one match at a time per recipe", () => {
  // The parser inserts a row for each extra ingredient of a split line. Two calls running at once
  // would both read the same unparsed rows and both insert those extras.
  const OTHER_RECIPE = "5ec1be00-0000-4000-8000-0000000000bb";

  /** An invoke that holds each call until the test lets one go, and counts how many run at once. */
  function gated() {
    const waiting: Array<() => void> = [];
    const state = { started: 0, active: 0, max: 0, ids: [] as string[] };
    const invoke: Invoke = async (_name, opts) => {
      state.started += 1;
      state.active += 1;
      state.max = Math.max(state.max, state.active);
      state.ids.push((opts.body as { recipeId: string }).recipeId);
      await new Promise<void>((resolve) => waiting.push(resolve));
      state.active -= 1;
      return { data: { ok: true, parsedRows: 1, unresolved: 0 }, error: null };
    };
    const release = () => waiting.shift()?.();
    return { invoke, state, release };
  }
  /** Gives pending promise callbacks time to run. */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

  it("makes the second call wait for the first, so they never overlap", async () => {
    const { invoke, state, release } = gated();
    const { client } = recorder([], { invoke });

    const first = parseRecipeIngredients(client, RECIPE);
    await vi.waitFor(() => expect(state.started).toBe(1));
    const second = parseRecipeIngredients(client, RECIPE);
    await settle();
    expect(state.started).toBe(1); // the second has not gone out

    release();
    await expect(first).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => expect(state.started).toBe(2));
    release();
    await expect(second).resolves.toMatchObject({ ok: true });
    expect(state.max).toBe(1);
  });

  it("lets calls that arrive while one is waiting share it", async () => {
    const { invoke, state, release } = gated();
    const { client } = recorder([], { invoke });

    const first = parseRecipeIngredients(client, RECIPE);
    await vi.waitFor(() => expect(state.started).toBe(1));
    const second = parseRecipeIngredients(client, RECIPE);
    const third = parseRecipeIngredients(client, RECIPE);
    expect(third).toBe(second);

    release();
    await first;
    await vi.waitFor(() => expect(state.started).toBe(2));
    release();
    await Promise.all([second, third]);
    expect(state.started).toBe(2);
    expect(state.max).toBe(1);
  });

  it("does not hold up another recipe", async () => {
    const { invoke, state, release } = gated();
    const { client } = recorder([], { invoke });

    const a = parseRecipeIngredients(client, RECIPE);
    const b = parseRecipeIngredients(client, OTHER_RECIPE);
    await vi.waitFor(() => expect(state.started).toBe(2));
    expect(state.max).toBe(2);
    expect(state.ids.sort()).toEqual([RECIPE, OTHER_RECIPE].sort());
    release();
    release();
    await Promise.all([a, b]);
  });

  it("goes out at once when nothing is running, and a failure does not block the next call", async () => {
    let calls = 0;
    const { client } = recorder([], {
      invoke: async () => {
        calls += 1;
        return calls === 1
          ? { data: null, error: new Error("down") }
          : { data: { ok: true, parsedRows: 2, unresolved: 0 }, error: null };
      },
    });
    expect((await parseRecipeIngredients(client, RECIPE)).ok).toBe(false);
    expect((await parseRecipeIngredients(client, RECIPE)).ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("covers a tap on Match ingredients while a slow match is still running past its budget", async () => {
    const { invoke, state, release } = gated();
    const { client } = recorder([], { invoke });

    // The save stopped waiting after its budget; the call carries on.
    const saving = parseWithinBudget(client, RECIPE, { budgetMs: 10 });
    await vi.waitFor(() => expect(state.started).toBe(1));
    expect(await saving).toEqual({ ok: false, reason: "timeout" });

    const tapped = matchRecipeIngredients(client, { id: RECIPE, visibility: "household" });
    await settle();
    expect(state.started).toBe(1);

    release();
    await vi.waitFor(() => expect(state.started).toBe(2));
    release();
    await expect(tapped).resolves.toMatchObject({ ok: true });
    expect(state.max).toBe(1);
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

// ---------------------------------------------------------------------------------------
// The hooks themselves. Their job is to put the parse call behind every write; a hook that went
// back to the plain write (importRecipe, createRecipe, updateRecipe) would still save the recipe
// and leave every line unmatched, which is how Miguel's six recipes were left. So these run each
// hook's own `mutationFn` and look for the call to parse-ingredients, and for the token on it.
// ---------------------------------------------------------------------------------------

interface HookOptions<Vars, Out = unknown> {
  mutationFn: (vars: Vars) => Promise<Out>;
  onSuccess?: (...args: unknown[]) => unknown;
}

/** The hook's options, as the mocked useMutation received them. */
const hookOptions = <Vars = never, Out = unknown>(hook: unknown) => hook as HookOptions<Vars, Out>;

/** A query client that only records what it was asked to invalidate. */
function spyClient() {
  const invalidateQueries = vi.fn(async (_filters: unknown) => undefined);
  return { client: { invalidateQueries } as unknown as QueryClient, invalidateQueries };
}

const invalidated = (spy: ReturnType<typeof spyClient>["invalidateQueries"]) =>
  spy.mock.calls.map(([filters]) => (filters as { queryKey: unknown[] }).queryKey);

const AUTH_ON_PARSE = {
  body: { recipeId: RECIPE },
  headers: { Authorization: `Bearer ${TOKEN}` },
};

describe("useImportRecipe", () => {
  const jobId = "0c000000-0000-4000-8000-00000000000c";
  const saved = { ok: true, jobId, path: "jsonld", recipeId: RECIPE, warnings: [] };

  /** recipe-import answers `body`; parse-ingredients answers its usual success. */
  function setup(body: unknown) {
    const r = recorder([], {
      invoke: async (name) =>
        name === "recipe-import"
          ? { data: body, error: null }
          : { data: { ok: true, parsedRows: 8, unresolved: 0 }, error: null },
    });
    const q = spyClient();
    h.client = r.client;
    h.queryClient = q.client;
    return { ...r, ...q };
  }

  it("imports, then matches the new recipe with the person's token", async () => {
    const { calls } = setup(saved);
    const result = await hookOptions<unknown, { recipeId?: string }>(useImportRecipe()).mutationFn({
      kind: "url",
      input: "https://example.test/r",
    });
    expect(result.recipeId).toBe(RECIPE);
    const invokes = calls.filter((c) => c.op.startsWith("functions.invoke:"));
    expect(invokes.map((c) => c.op)).toEqual([
      "functions.invoke:recipe-import",
      "functions.invoke:parse-ingredients",
    ]);
    expect(invokes[1]?.args[0]).toEqual(AUTH_ON_PARSE);
  });

  it("matches nothing for a draft or a failed import", async () => {
    const draftBody = {
      ok: true,
      jobId,
      path: "vision",
      draft: { title: "Soup", ingredients: [{ rawText: "stock" }], instructions: [] },
      warnings: [],
    };
    const drafted = setup(draftBody);
    await hookOptions<unknown>(useImportRecipe()).mutationFn({
      kind: "image",
      input: { path: `${HOUSEHOLD}/a.jpg` },
      save: false,
    });
    expect(parseCalls(drafted.calls)).toHaveLength(0);

    const failed = setup({ ok: false, error: "blocked" });
    await expect(
      hookOptions<unknown>(useImportRecipe()).mutationFn({
        kind: "url",
        input: "https://example.test/r",
      }),
    ).rejects.toMatchObject({ code: "blocked" });
    expect(parseCalls(failed.calls)).toHaveLength(0);
  });

  it("refreshes the recipe list for a saved recipe and not for a draft", async () => {
    const { invalidateQueries } = setup(saved);
    const hook = hookOptions(useImportRecipe());
    await hook.onSuccess?.({ ...saved });
    expect(invalidated(invalidateQueries)).toContainEqual(["recipes"]);

    invalidateQueries.mockClear();
    await hook.onSuccess?.({ ok: true, jobId, path: "vision", warnings: [] });
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});

describe("useCreateRecipe", () => {
  it("saves the recipe, then matches it with the person's token", async () => {
    const r = recorder([{ data: { id: RECIPE }, error: null }, { error: null }]);
    h.client = r.client;
    h.queryClient = spyClient().client;

    const id = await hookOptions<unknown, string>(useCreateRecipe()).mutationFn({
      householdId: HOUSEHOLD,
      draft: draft(),
      sourceType: "manual",
    });
    expect(id).toBe(RECIPE);
    const order = r.calls.map((c) => c.op);
    expect(order.indexOf("recipe_ingredients.insert")).toBeLessThan(
      order.indexOf("functions.invoke:parse-ingredients"),
    );
    expect(parseCalls(r.calls)[0]?.args[0]).toEqual(AUTH_ON_PARSE);
  });

  it("refreshes the recipe list when it is saved", async () => {
    const q = spyClient();
    h.client = recorder().client;
    h.queryClient = q.client;
    await hookOptions(useCreateRecipe()).onSuccess?.();
    expect(invalidated(q.invalidateQueries)).toContainEqual(["recipes"]);
  });
});

describe("useUpdateRecipe", () => {
  const before = [
    { id: "l1", raw_text: "8 chicken thighs", group_name: null, position: 0 },
    { id: "l2", raw_text: "1 lemon", group_name: null, position: 1 },
  ];

  it("matches the lines an edit changed, with the person's token", async () => {
    const r = recorder([
      { data: [{ id: RECIPE }], error: null },
      { data: before, error: null },
      { error: null },
    ]);
    h.client = r.client;
    h.queryClient = spyClient().client;
    await hookOptions<RecipeDraft>(useUpdateRecipe(RECIPE)).mutationFn(
      draft({
        ingredients: [
          { id: "l1", rawText: "8 chicken thighs" },
          { id: "l2", rawText: "2 lemons" },
        ],
      }),
    );
    expect(parseCalls(r.calls)[0]?.args[0]).toEqual(AUTH_ON_PARSE);
  });

  it("matches nothing when the edit left the lines alone", async () => {
    const r = recorder([
      { data: [{ id: RECIPE }], error: null },
      { data: before, error: null },
    ]);
    h.client = r.client;
    h.queryClient = spyClient().client;
    await hookOptions<RecipeDraft>(useUpdateRecipe(RECIPE)).mutationFn(
      draft({
        title: "Better Lemon Chicken",
        ingredients: [
          { id: "l1", rawText: "8 chicken thighs" },
          { id: "l2", rawText: "1 lemon" },
        ],
      }),
    );
    expect(parseCalls(r.calls)).toHaveLength(0);
  });

  it("has no recipe to edit without an id, and touches nothing", () => {
    const r = recorder();
    h.client = r.client;
    h.queryClient = spyClient().client;
    expect(() => hookOptions<RecipeDraft>(useUpdateRecipe(null)).mutationFn(draft())).toThrow(
      RecipeError,
    );
    expect(r.calls).toHaveLength(0);
  });

  it("refreshes that recipe and the list when the edit is saved", async () => {
    const q = spyClient();
    h.client = recorder().client;
    h.queryClient = q.client;
    await hookOptions(useUpdateRecipe(RECIPE)).onSuccess?.();
    expect(invalidated(q.invalidateQueries)).toEqual([recipeQueryKey(RECIPE), ["recipes"]]);
  });
});

describe("useMatchIngredients (the Match ingredients button)", () => {
  type Target = { id: string; visibility: "household" | "catalog" };

  it("matches a household recipe with the person's token", async () => {
    const r = recorder();
    h.client = r.client;
    h.queryClient = spyClient().client;
    const outcome = await hookOptions<Target, { ok: boolean }>(useMatchIngredients()).mutationFn({
      id: RECIPE,
      visibility: "household",
    });
    expect(outcome.ok).toBe(true);
    expect(parseCalls(r.calls)).toHaveLength(1);
    expect(parseCalls(r.calls)[0]?.args[0]).toEqual(AUTH_ON_PARSE);
  });

  it("sends a starter recipe nowhere, and tells the person when matching fails", async () => {
    const catalog = recorder();
    h.client = catalog.client;
    h.queryClient = spyClient().client;
    await expect(
      hookOptions<Target>(useMatchIngredients()).mutationFn({ id: RECIPE, visibility: "catalog" }),
    ).rejects.toBeInstanceOf(RecipeError);
    expect(catalog.calls).toHaveLength(0);

    h.client = recorder([], {
      invoke: async () => ({ data: null, error: new Error("down") }),
    }).client;
    await expect(
      hookOptions<Target>(useMatchIngredients()).mutationFn({
        id: RECIPE,
        visibility: "household",
      }),
    ).rejects.toMatchObject({ message: MATCH_ERROR_MESSAGE });
  });

  it("refreshes the recipe it matched, and the list", async () => {
    const q = spyClient();
    h.client = recorder().client;
    h.queryClient = q.client;
    await hookOptions(useMatchIngredients()).onSuccess?.({ ok: true }, { id: OTHER });
    expect(invalidated(q.invalidateQueries)).toEqual([recipeQueryKey(OTHER), ["recipes"]]);
  });
});

describe("refreshRecipe", () => {
  it("refreshes the one recipe it was given and the list, and no other recipe", async () => {
    const q = spyClient();
    await refreshRecipe(q.client, OTHER);
    expect(invalidated(q.invalidateQueries)).toEqual([["recipe", OTHER], ["recipes"]]);
    expect(invalidated(q.invalidateQueries)).not.toContainEqual(["recipe", RECIPE]);
  });
});

describe("parseAfterWrite: the wait, and the refresh when the match ends", () => {
  /** A match that ends when the test says so, or fails when told to. */
  function slowMatch() {
    let finish: (value: unknown) => void = () => {};
    const done = new Promise((resolve) => {
      finish = resolve;
    });
    const r = recorder([], { invoke: () => done });
    return {
      db: r.client,
      end: () => finish({ data: { ok: true, parsedRows: 4, unresolved: 0 }, error: null }),
      fail: () => finish({ data: null, error: new Error("down") }),
    };
  }

  it("stops waiting after the 25-second budget, and not before", async () => {
    vi.useFakeTimers();
    const m = slowMatch();
    const q = spyClient();
    const seen: { outcome?: unknown } = {};
    parseAfterWrite(m.db, q.client, RECIPE).then((o) => {
      seen.outcome = o;
    });

    await vi.advanceTimersByTimeAsync(PARSE_BUDGET_MS - 1000);
    expect(seen.outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen.outcome).toEqual({ ok: false, reason: "timeout" });
    expect(PARSE_BUDGET_MS).toBe(25_000);

    m.end();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("does not refresh while the match is still running", async () => {
    vi.useFakeTimers();
    const m = slowMatch();
    const q = spyClient();
    parseAfterWrite(m.db, q.client, RECIPE);
    await vi.advanceTimersByTimeAsync(PARSE_BUDGET_MS);
    expect(q.invalidateQueries).not.toHaveBeenCalled();

    m.end();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("refreshes that recipe, and the list, when a match that outlasted the wait ends", async () => {
    vi.useFakeTimers();
    const m = slowMatch();
    const q = spyClient();
    parseAfterWrite(m.db, q.client, RECIPE);
    await vi.advanceTimersByTimeAsync(PARSE_BUDGET_MS);

    m.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(invalidated(q.invalidateQueries)).toEqual([recipeQueryKey(RECIPE), ["recipes"]]);
  });

  it("refreshes the recipe it matched when the match ends in time", async () => {
    const m = slowMatch();
    const q = spyClient();
    const waiting = parseAfterWrite(m.db, q.client, OTHER);
    m.end();
    expect(await waiting).toMatchObject({ ok: true });
    expect(invalidated(q.invalidateQueries)).toEqual([recipeQueryKey(OTHER), ["recipes"]]);
  });

  it("does not refresh for a match that failed", async () => {
    const m = slowMatch();
    const q = spyClient();
    const waiting = parseAfterWrite(m.db, q.client, RECIPE);
    m.fail();
    expect(await waiting).toMatchObject({ ok: false, reason: "failed" });
    expect(q.invalidateQueries).not.toHaveBeenCalled();
  });
});
