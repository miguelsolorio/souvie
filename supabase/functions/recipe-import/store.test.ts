import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { DuplicateSaveError, SupabaseImportStore } from "./store.ts";

type Result = {
  data?: unknown;
  error?: { message: string; code?: string } | null;
  count?: number | null;
};
type Call = { table: string; op: string; args: unknown[] };

/**
 * A just-enough PostgREST fake. Each chained call is recorded; awaiting the chain (or calling
 * .single()) returns the next queued result for that table and operation.
 */
class FakeDb {
  readonly calls: Call[] = [];
  readonly results = new Map<string, Result[]>();
  readonly buckets: Array<{ bucket: string; path: string }> = [];
  download: { data: Blob | null; error: { message: string } | null } = { data: null, error: null };

  queue(table: string, op: string, ...results: Result[]) {
    this.results.set(`${table}:${op}`, results);
  }

  from(table: string) {
    return new Chain(this, table);
  }

  readonly rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  rpcResult: Result = { data: 0, error: null };

  async rpc(fn: string, args: Record<string, unknown>) {
    this.rpcCalls.push({ fn, args });
    return this.rpcResult;
  }

  readonly storage = {
    from: (bucket: string) => ({
      download: async (path: string) => {
        this.buckets.push({ bucket, path });
        return this.download;
      },
    }),
  };

  asClient(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }
}

class Chain implements PromiseLike<Result> {
  private op = "select";

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
  ) {}

  private record(op: string, args: unknown[]) {
    this.db.calls.push({ table: this.table, op, args });
    return this;
  }
  select(...args: unknown[]) {
    this.record("select", args);
    return this;
  }
  insert(...args: unknown[]) {
    this.op = "insert";
    return this.record("insert", args);
  }
  update(...args: unknown[]) {
    this.op = "update";
    return this.record("update", args);
  }
  delete(...args: unknown[]) {
    this.op = "delete";
    return this.record("delete", args);
  }
  eq(...args: unknown[]) {
    return this.record("eq", args);
  }
  is(...args: unknown[]) {
    return this.record("is", args);
  }
  gte(...args: unknown[]) {
    return this.record("gte", args);
  }
  order(...args: unknown[]) {
    return this.record("order", args);
  }
  limit(...args: unknown[]) {
    return this.record("limit", args);
  }
  ilike(...args: unknown[]) {
    return this.record("ilike", args);
  }
  single() {
    return this.then((r) => r);
  }
  maybeSingle() {
    return this.then((r) => r);
  }
  // biome-ignore lint/suspicious/noThenProperty: the real PostgREST builder is awaitable, and so is this.
  then<T1 = Result, T2 = never>(
    onfulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    const key = `${this.table}:${this.op}`;
    const next = this.db.results.get(key)?.shift() ?? { data: null, error: null };
    return Promise.resolve(next).then(onfulfilled, onrejected);
  }
}

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const RECIPE = {
  title: "Lemon Chicken",
  description: "Quick.",
  imageUrl: "https://example.test/a.jpg",
  sourceUrl: "https://example.test/r",
  servings: 4,
  prepMin: 10,
  cookMin: 35,
  ingredients: [{ rawText: "8 chicken thighs" }, { rawText: "1 lemon", groupName: "For the pan" }],
  instructions: ["Heat.", "Roast."],
  nutrition: { calories: "320 kcal" },
  tags: ["dinner"],
  cuisine: "american",
};

function store() {
  const service = new FakeDb();
  const user = new FakeDb();
  const seen: string[] = [];
  const s = new SupabaseImportStore(service.asClient(), (auth) => {
    seen.push(auth);
    return user.asClient();
  });
  return { s, service, user, seen };
}

describe("resolveHousehold", () => {
  it("returns the most recently joined household for the caller, through RLS", async () => {
    const { s, user, seen } = store();
    user.queue("household_members", "select", { data: [{ household_id: HOUSEHOLD }], error: null });
    expect(await s.resolveHousehold("Bearer jwt", "user-1", undefined)).toEqual({
      kind: "ok",
      householdId: HOUSEHOLD,
    });
    expect(seen).toEqual(["Bearer jwt"]);
    expect(user.calls).toContainEqual({
      table: "household_members",
      op: "eq",
      args: ["user_id", "user-1"],
    });
    expect(user.calls).toContainEqual({
      table: "household_members",
      op: "is",
      args: ["households.deleted_at", null],
    });
    expect(user.calls).not.toContainEqual(
      expect.objectContaining({ op: "eq", args: ["household_id", expect.anything()] }),
    );
  });

  it("filters to the requested household and reports not_member when it is not one of theirs", async () => {
    const { s, user } = store();
    user.queue("household_members", "select", { data: [], error: null });
    expect(await s.resolveHousehold("Bearer jwt", "user-1", HOUSEHOLD)).toEqual({
      kind: "not_member",
    });
    expect(user.calls).toContainEqual({
      table: "household_members",
      op: "eq",
      args: ["household_id", HOUSEHOLD],
    });
  });

  it("reports none for a user with no household, and throws on a database error", async () => {
    const a = store();
    a.user.queue("household_members", "select", { data: [], error: null });
    expect(await a.s.resolveHousehold("Bearer jwt", "user-1", undefined)).toEqual({ kind: "none" });
    const b = store();
    b.user.queue("household_members", "select", { data: null, error: { message: "boom" } });
    await expect(b.s.resolveHousehold("Bearer jwt", "user-1", undefined)).rejects.toThrow(/boom/);
  });
});

describe("jobs", () => {
  it("creates a running job with the service role and returns its id", async () => {
    const { s, service } = store();
    service.queue("import_jobs", "insert", { data: { id: "job-9" }, error: null });
    const id = await s.createJob({
      householdId: HOUSEHOLD,
      kind: "url",
      input: { url: "https://example.test/r" },
    });
    expect(id).toBe("job-9");
    expect(service.calls[0]).toEqual({
      table: "import_jobs",
      op: "insert",
      args: [
        {
          household_id: HOUSEHOLD,
          kind: "url",
          input: { url: "https://example.test/r" },
          status: "running",
        },
      ],
    });
  });

  it("closes a job scoped to its household and caps the error text", async () => {
    const { s, service } = store();
    await s.finishJob("job-9", HOUSEHOLD, { status: "failed", error: "x".repeat(900) });
    const update = service.calls.find((c) => c.op === "update");
    const row = update?.args[0] as Record<string, unknown>;
    expect(row.status).toBe("failed");
    expect((row.error as string).length).toBe(300);
    expect(row.finished_at).toEqual(expect.any(String));
    expect(service.calls).toContainEqual({ table: "import_jobs", op: "eq", args: ["id", "job-9"] });
    expect(service.calls).toContainEqual({
      table: "import_jobs",
      op: "eq",
      args: ["household_id", HOUSEHOLD],
    });
  });

  it("counts recent jobs for one household", async () => {
    const { s, service } = store();
    service.queue("import_jobs", "select", { count: 7, error: null });
    expect(await s.recentJobCount(HOUSEHOLD, "2026-10-30T11:00:00.000Z")).toBe(7);
    expect(service.calls).toContainEqual({
      table: "import_jobs",
      op: "eq",
      args: ["household_id", HOUSEHOLD],
    });
  });
});

describe("saveRecipe", () => {
  it("inserts the recipe and its lines as the caller, with raw text only", async () => {
    const { s, service, user } = store();
    user.queue("recipes", "insert", { data: { id: "recipe-1" }, error: null });
    const id = await s.saveRecipe("Bearer jwt", {
      householdId: HOUSEHOLD,
      recipe: RECIPE,
      sourceType: "url",
    });
    expect(id).toBe("recipe-1");

    const recipeInsert = user.calls.find((c) => c.table === "recipes" && c.op === "insert");
    expect(recipeInsert?.args[0]).toEqual({
      household_id: HOUSEHOLD,
      title: "Lemon Chicken",
      description: "Quick.",
      image_url: "https://example.test/a.jpg",
      source_type: "url",
      source_url: "https://example.test/r",
      servings: 4,
      prep_min: 10,
      cook_min: 35,
      instructions: [
        { step: 1, text: "Heat." },
        { step: 2, text: "Roast." },
      ],
      nutrition: { calories: "320 kcal" },
      tags: ["dinner"],
      cuisine: "american",
      visibility: "household",
    });
    // created_by is left to its default (auth.uid()); embedding is never written.
    expect(recipeInsert?.args[0]).not.toHaveProperty("created_by");
    expect(recipeInsert?.args[0]).not.toHaveProperty("embedding");

    const lines = user.calls.find((c) => c.table === "recipe_ingredients" && c.op === "insert")
      ?.args[0];
    expect(lines).toEqual([
      { recipe_id: "recipe-1", position: 0, group_name: null, raw_text: "8 chicken thighs" },
      { recipe_id: "recipe-1", position: 1, group_name: "For the pan", raw_text: "1 lemon" },
    ]);
    // Parser fields are not touched.
    for (const line of lines as Array<Record<string, unknown>>) {
      for (const column of ["qty", "qty_max", "unit", "ingredient_id"])
        expect(line).not.toHaveProperty(column);
    }
    expect(service.calls).toHaveLength(0);
  });

  it("lets the caller override the image and source (a photo stores its path)", async () => {
    const { s, user } = store();
    user.queue("recipes", "insert", { data: { id: "recipe-2" }, error: null });
    await s.saveRecipe("Bearer jwt", {
      householdId: HOUSEHOLD,
      recipe: { ...RECIPE, imageUrl: undefined, sourceUrl: undefined },
      sourceType: "photo",
      imageUrl: `${HOUSEHOLD}/card.jpg`,
    });
    const row = user.calls.find((c) => c.table === "recipes" && c.op === "insert")
      ?.args[0] as Record<string, unknown>;
    expect(row.image_url).toBe(`${HOUSEHOLD}/card.jpg`);
    expect(row.source_type).toBe("photo");
    expect(row.source_url).toBeNull();
  });

  it("removes the half-saved recipe with the service role when the lines fail", async () => {
    const { s, service, user } = store();
    user.queue("recipes", "insert", { data: { id: "recipe-3" }, error: null });
    user.queue("recipe_ingredients", "insert", { error: { message: "check violation" } });
    await expect(
      s.saveRecipe("Bearer jwt", { householdId: HOUSEHOLD, recipe: RECIPE, sourceType: "url" }),
    ).rejects.toThrow(/check violation/);
    expect(service.calls).toEqual([
      { table: "recipes", op: "delete", args: [] },
      { table: "recipes", op: "eq", args: ["id", "recipe-3"] },
      { table: "recipes", op: "eq", args: ["household_id", HOUSEHOLD] },
    ]);
  });

  it("throws when the recipe insert fails", async () => {
    const { s, user } = store();
    user.queue("recipes", "insert", { data: null, error: { message: "denied" } });
    await expect(
      s.saveRecipe("Bearer jwt", { householdId: HOUSEHOLD, recipe: RECIPE, sourceType: "url" }),
    ).rejects.toThrow(/denied/);
  });

  it("tells the unique index on a recipe's link from any other failure", async () => {
    const { s, service, user } = store();
    user.queue("recipes", "insert", {
      data: null,
      error: {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "recipes_household_source_url_normalized_uq"',
      },
    });
    await expect(
      s.saveRecipe("Bearer jwt", { householdId: HOUSEHOLD, recipe: RECIPE, sourceType: "url" }),
    ).rejects.toBeInstanceOf(DuplicateSaveError);
    // No lines were written and there is nothing to clean up.
    expect(user.calls.some((c) => c.table === "recipe_ingredients")).toBe(false);
    expect(service.calls).toHaveLength(0);

    // Some other unique violation is an ordinary failure.
    user.queue("recipes", "insert", {
      data: null,
      error: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "recipes_pkey"',
      },
    });
    const other = await s
      .saveRecipe("Bearer jwt", { householdId: HOUSEHOLD, recipe: RECIPE, sourceType: "url" })
      .catch((e) => e);
    expect(other).toBeInstanceOf(Error);
    expect(other).not.toBeInstanceOf(DuplicateSaveError);
  });
});

describe("findDuplicate", () => {
  it("looks a link up by its normalized form among the household's live recipes, as the caller", async () => {
    const { s, service, user, seen } = store();
    user.queue("recipes", "select", { data: { id: "recipe-9" }, error: null });
    const found = await s.findDuplicate("Bearer jwt", HOUSEHOLD, {
      sourceUrlNormalized: "https://example.test/r",
    });
    expect(found).toEqual({ recipeId: "recipe-9", matchedBy: "url" });
    expect(seen).toEqual(["Bearer jwt"]);
    expect(service.calls).toHaveLength(0);
    expect(user.calls).toEqual(
      expect.arrayContaining([
        { table: "recipes", op: "eq", args: ["household_id", HOUSEHOLD] },
        { table: "recipes", op: "is", args: ["deleted_at", null] },
        { table: "recipes", op: "eq", args: ["source_url_normalized", "https://example.test/r"] },
      ]),
    );
  });

  it("returns null when the household has no such link", async () => {
    const { s, user } = store();
    user.queue("recipes", "select", { data: null, error: null });
    expect(
      await s.findDuplicate("Bearer jwt", HOUSEHOLD, {
        sourceUrlNormalized: "https://example.test/r",
      }),
    ).toBeNull();
  });

  it("compares titles exactly among the rows its ilike prefilter returns", async () => {
    const { s, user } = store();
    user.queue("recipes", "select", {
      data: [
        { id: "recipe-1", title: "Lemon roast chicken" },
        { id: "recipe-2", title: "LEMON   chicken" },
      ],
      error: null,
    });
    const found = await s.findDuplicate("Bearer jwt", HOUSEHOLD, {
      title: {
        pattern: "%lemon%chicken%",
        isSame: (c) => c.replace(/\s+/g, " ").toLowerCase() === "lemon chicken",
      },
    });
    expect(found).toEqual({ recipeId: "recipe-2", matchedBy: "title" });
    expect(user.calls).toContainEqual({
      table: "recipes",
      op: "ilike",
      args: ["title", "%lemon%chicken%"],
    });
    expect(user.calls).toContainEqual({ table: "recipes", op: "is", args: ["deleted_at", null] });
  });

  it("finds nothing when no row's title is the same, and with nothing to compare", async () => {
    const { s, user } = store();
    user.queue("recipes", "select", {
      data: [{ id: "recipe-1", title: "Lemon roast chicken" }],
      error: null,
    });
    expect(
      await s.findDuplicate("Bearer jwt", HOUSEHOLD, {
        title: { pattern: "%lemon%chicken%", isSame: () => false },
      }),
    ).toBeNull();
    expect(await s.findDuplicate("Bearer jwt", HOUSEHOLD, {})).toBeNull();
  });

  it("throws on a database error so the handler can decide to carry on", async () => {
    const { s, user } = store();
    user.queue("recipes", "select", { data: null, error: { message: "boom" } });
    await expect(
      s.findDuplicate("Bearer jwt", HOUSEHOLD, { sourceUrlNormalized: "https://example.test/r" }),
    ).rejects.toThrow(/boom/);
  });
});

describe("downloadImage and spentSince", () => {
  it("reads from the recipe-images bucket as the caller", async () => {
    const { s, user } = store();
    user.download = {
      data: new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
      error: null,
    };
    const image = await s.downloadImage("Bearer jwt", `${HOUSEHOLD}/a.jpg`);
    expect(image?.contentType).toBe("image/jpeg");
    expect([...(image?.bytes ?? [])]).toEqual([1, 2, 3]);
    expect(user.buckets).toEqual([{ bucket: "recipe-images", path: `${HOUSEHOLD}/a.jpg` }]);
  });

  it("returns null when the object cannot be read", async () => {
    const { s, user } = store();
    user.download = { data: null, error: { message: "not found" } };
    expect(await s.downloadImage("Bearer jwt", `${HOUSEHOLD}/a.jpg`)).toBeNull();
  });

  it("reads the household's model spend since a time through household_ai_spend_since", async () => {
    const { s, service } = store();
    // numeric comes back from PostgREST as a number or a string
    service.rpcResult = { data: "0.514", error: null };
    expect(await s.spentSince(HOUSEHOLD, "2026-10-30T00:00:00.000Z")).toBeCloseTo(0.514, 6);
    expect(service.rpcCalls).toEqual([
      {
        fn: "household_ai_spend_since",
        args: { p_household_id: HOUSEHOLD, p_since: "2026-10-30T00:00:00.000Z" },
      },
    ]);
  });

  it("throws when the spend cannot be read, so the guard lets the call through with a warning", async () => {
    const { s, service } = store();
    service.rpcResult = { data: null, error: { message: "function does not exist" } };
    await expect(s.spentSince(HOUSEHOLD, "2026-10-30T00:00:00.000Z")).rejects.toThrow(
      /household_ai_spend_since failed: function does not exist/,
    );
  });
});

describe("householdCapUsd (WS15)", () => {
  it("reads ai_daily_cap_usd from the household row, by id", async () => {
    const { s, service } = store();
    service.queue("households", "select", { data: { ai_daily_cap_usd: "0.01" }, error: null });
    expect(await s.householdCapUsd(HOUSEHOLD)).toBe(0.01);
    expect(service.calls).toContainEqual({
      table: "households",
      op: "select",
      args: ["ai_daily_cap_usd"],
    });
    expect(service.calls).toContainEqual({
      table: "households",
      op: "eq",
      args: ["id", HOUSEHOLD],
    });
  });

  it("is null for a missing row, and throws on a database error", async () => {
    const { s, service } = store();
    service.queue("households", "select", { data: null, error: null });
    expect(await s.householdCapUsd(HOUSEHOLD)).toBeNull();
    service.queue("households", "select", { data: null, error: { message: "no such column" } });
    await expect(s.householdCapUsd(HOUSEHOLD)).rejects.toThrow(/households read failed/);
  });
});
