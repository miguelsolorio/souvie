import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { SupabaseImportStore } from "./store.ts";

type Result = { data?: unknown; error?: { message: string } | null; count?: number | null };
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
  single() {
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

  it("sums the household's model spend since a time", async () => {
    const { s, service } = store();
    service.queue("ai_runs", "select", {
      data: [{ cost_usd: "0.004" }, { cost_usd: 0.01 }, { cost_usd: "0.5" }],
      error: null,
    });
    expect(await s.spentSince(HOUSEHOLD, "2026-10-30T00:00:00.000Z")).toBeCloseTo(0.514, 6);
    expect(service.calls).toContainEqual({
      table: "ai_runs",
      op: "eq",
      args: ["household_id", HOUSEHOLD],
    });
  });
});
