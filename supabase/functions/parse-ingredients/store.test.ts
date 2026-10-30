import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { LlmUsage } from "../../../packages/ingredient-parser/src/index.ts";
import {
  recordAiRun,
  SupabaseOntologyStore,
  SupabaseParseCache,
  SupabaseProposalSink,
  SupabaseRecipeStore,
} from "./store.ts";

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string } | null };

/** A just-enough PostgREST fake: tables are arrays, builders are thenable. */
class FakeDb {
  readonly tables = new Map<string, Row[]>();
  readonly rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  readonly queries: string[] = [];
  rpcResults = new Map<string, Result>();
  failTable: string | null = null;

  table(name: string): Row[] {
    const existing = this.tables.get(name);
    if (existing) return existing;
    const created: Row[] = [];
    this.tables.set(name, created);
    return created;
  }

  from(name: string) {
    return new Builder(this, name);
  }

  async rpc(name: string, args: Record<string, unknown>): Promise<Result> {
    this.rpcCalls.push({ name, args });
    return this.rpcResults.get(name) ?? { data: null, error: null };
  }

  asClient(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }
}

class Builder {
  private filters: ((r: Row) => boolean)[] = [];
  private mode: "select" | "update" | "insert" | "upsert" = "select";
  private payload: unknown;
  private single = false;
  private orderBy: { col: string; asc: boolean } | null = null;

  constructor(
    private readonly db: FakeDb,
    private readonly name: string,
  ) {}

  select(_cols?: string) {
    return this;
  }
  in(col: string, values: unknown[]) {
    this.db.queries.push(`${this.name}.in(${col}, ${values.length})`);
    this.filters.push((r) => values.includes(r[col]));
    return this;
  }
  eq(col: string, value: unknown) {
    this.filters.push((r) => r[col] === value);
    return this;
  }
  is(col: string, value: unknown) {
    this.filters.push((r) => (r[col] ?? null) === value);
    return this;
  }
  order(col: string, opts: { ascending: boolean }) {
    this.orderBy = { col, asc: opts.ascending };
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  update(values: Row) {
    this.mode = "update";
    this.payload = values;
    return this;
  }
  insert(values: Row | Row[]) {
    this.mode = "insert";
    this.payload = values;
    return this;
  }
  upsert(values: Row[], _opts?: unknown) {
    this.mode = "upsert";
    this.payload = values;
    return this;
  }

  // biome-ignore lint/suspicious/noThenProperty: the real PostgREST builder is awaitable, and so is this.
  then<T>(resolve: (r: Result) => T): Promise<T> {
    return Promise.resolve(this.run()).then(resolve);
  }

  private run(): Result {
    if (this.db.failTable === this.name)
      return { data: null, error: { message: `${this.name} is unavailable` } };
    const table = this.db.table(this.name);
    if (this.mode === "insert") {
      table.push(
        ...(Array.isArray(this.payload) ? (this.payload as Row[]) : [this.payload as Row]),
      );
      return { data: null, error: null };
    }
    if (this.mode === "upsert") {
      for (const row of this.payload as Row[]) {
        const key = this.name === "ingredient_parse_cache" ? "normalized_text" : "id";
        const at = table.findIndex((r) => r[key] === row[key]);
        if (at >= 0) table[at] = row;
        else table.push(row);
      }
      return { data: null, error: null };
    }
    const matches = table.filter((r) => this.filters.every((f) => f(r)));
    if (this.mode === "update") {
      for (const r of matches) Object.assign(r, this.payload);
      return { data: null, error: null };
    }
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      matches.sort((a, b) => (Number(a[col]) - Number(b[col])) * (asc ? 1 : -1));
    }
    return { data: this.single ? (matches[0] ?? null) : matches, error: null };
  }
}

const ONION = { id: "ing-onion", name: "yellow onion", category: "produce" };

describe("SupabaseOntologyStore", () => {
  function seeded(): FakeDb {
    const db = new FakeDb();
    db.table("ingredient_aliases").push(
      { alias: "yellow onion", ingredient_id: "ing-onion", ingredients: ONION },
      // PostgREST may return the embedded row as a one-element array.
      { alias: "onion", ingredient_id: "ing-onion", ingredients: [ONION] },
    );
    return db;
  }

  it("finds exact aliases, with the embedded ingredient as an object or an array", async () => {
    const store = new SupabaseOntologyStore(seeded().asClient());
    const found = await store.findExact(["yellow onion", "onion", "unicorn"]);
    expect([...found.keys()].sort()).toEqual(["onion", "yellow onion"]);
    expect(found.get("onion")).toEqual({
      ingredientId: "ing-onion",
      name: "yellow onion",
      category: "produce",
      alias: "onion",
    });
  });

  it("remembers hits and misses for the life of the store", async () => {
    const db = seeded();
    const store = new SupabaseOntologyStore(db.asClient());
    await store.findExact(["onion", "unicorn"]);
    await store.findExact(["onion", "unicorn"]);
    expect(db.queries).toHaveLength(1);
  });

  it("queries in chunks so the URL stays short", async () => {
    const db = seeded();
    const store = new SupabaseOntologyStore(db.asClient());
    await store.findExact(Array.from({ length: 130 }, (_, i) => `key ${i}`));
    expect(db.queries).toHaveLength(3);
  });

  it("surfaces a read failure", async () => {
    const db = seeded();
    db.failTable = "ingredient_aliases";
    await expect(new SupabaseOntologyStore(db.asClient()).findExact(["onion"])).rejects.toThrow(
      /ingredient_aliases lookup failed/,
    );
  });

  it("uses match_ingredient_alias for similar matches and fetches the ingredient once", async () => {
    const db = seeded();
    db.table("ingredients").push({ id: "ing-onion", name: "yellow onion", category: "produce" });
    db.rpcResults.set("match_ingredient_alias", {
      data: [{ ingredient_id: "ing-onion", alias: "yellow onion", similarity: 0.9 }],
      error: null,
    });
    const store = new SupabaseOntologyStore(db.asClient());
    const hit = await store.findSimilar("yellow onoin", 0.85);
    expect(hit).toMatchObject({
      ingredientId: "ing-onion",
      name: "yellow onion",
      alias: "yellow onion",
      similarity: 0.9,
    });
    expect(db.rpcCalls[0]).toEqual({
      name: "match_ingredient_alias",
      args: { query: "yellow onoin", min_similarity: 0.85, max_results: 1 },
    });
    await store.findSimilar("yellow onoin", 0.85);
    expect(db.table("ingredients")).toHaveLength(1);
  });

  it("returns null when nothing is similar", async () => {
    const db = seeded();
    db.rpcResults.set("match_ingredient_alias", { data: [], error: null });
    expect(await new SupabaseOntologyStore(db.asClient()).findSimilar("zzz", 0.85)).toBeNull();
  });
});

describe("SupabaseParseCache", () => {
  const item = {
    rawText: "1 tbsp x",
    qty: 1,
    unit: "tbsp",
    ingredientId: null,
    ingredientName: "x",
    optional: false,
    confidence: 0.6,
    stage: "llm",
  };

  it("round-trips entries as { items }", async () => {
    const db = new FakeDb();
    const cache = new SupabaseParseCache(db.asClient());
    await cache.putMany(
      new Map([
        [
          "1 tbsp x",
          {
            items: [item as never],
            source: "llm" as const,
            model: "claude-haiku-5-5",
            promptVersion: "v1",
          },
        ],
      ]),
    );
    expect(db.table("ingredient_parse_cache")[0]).toMatchObject({
      normalized_text: "1 tbsp x",
      result: { items: [item] },
      source: "llm",
      model: "claude-haiku-5-5",
      prompt_version: "v1",
    });
    const got = await cache.getMany(["1 tbsp x", "nope"]);
    expect([...got.keys()]).toEqual(["1 tbsp x"]);
    expect(got.get("1 tbsp x")).toMatchObject({
      source: "llm",
      model: "claude-haiku-5-5",
      promptVersion: "v1",
    });
  });

  it("keeps a rejection (an entry with no items) so the line is not sent again", async () => {
    const db = new FakeDb();
    const cache = new SupabaseParseCache(db.asClient());
    await cache.putMany(
      new Map([
        [
          "for the sauce",
          { items: [], source: "llm" as const, model: "claude-haiku-5-5", promptVersion: "v1" },
        ],
      ]),
    );
    const got = await cache.getMany(["for the sauce"]);
    expect(got.get("for the sauce")).toMatchObject({ items: [], source: "llm" });
  });

  it("ignores rows whose result is not a parse", async () => {
    const db = new FakeDb();
    db.table("ingredient_parse_cache").push(
      { normalized_text: "a", result: { nope: true }, source: "llm" },
      { normalized_text: "b", result: { items: [{ rawText: 1 }] }, source: "llm" },
    );
    expect((await new SupabaseParseCache(db.asClient()).getMany(["a", "b"])).size).toBe(0);
  });

  it("overwrites an existing key", async () => {
    const db = new FakeDb();
    const cache = new SupabaseParseCache(db.asClient());
    const entry = (name: string) =>
      new Map([
        [
          "k",
          {
            items: [{ ...item, ingredientName: name } as never],
            source: "llm" as const,
            model: null,
            promptVersion: null,
          },
        ],
      ]);
    await cache.putMany(entry("a"));
    await cache.putMany(entry("b"));
    expect(db.table("ingredient_parse_cache")).toHaveLength(1);
    const stored = db.table("ingredient_parse_cache")[0] as Row;
    const result = stored.result as { items: { ingredientName: string }[] };
    expect(result.items[0]?.ingredientName).toBe("b");
  });
});

describe("SupabaseProposalSink", () => {
  it("calls record_ingredient_alias_proposal with the household", async () => {
    const db = new FakeDb();
    await new SupabaseProposalSink(db.asClient(), "house-1").record({
      rawText: "1 tbsp gochugaru",
      proposedName: "gochugaru",
      proposedCategory: "international",
    });
    expect(db.rpcCalls).toEqual([
      {
        name: "record_ingredient_alias_proposal",
        args: {
          p_raw_text: "1 tbsp gochugaru",
          p_proposed_name: "gochugaru",
          p_proposed_category: "international",
          p_household_id: "house-1",
        },
      },
    ]);
  });

  it("throws when the function fails", async () => {
    const db = new FakeDb();
    db.rpcResults.set("record_ingredient_alias_proposal", {
      data: null,
      error: { message: "boom" },
    });
    await expect(
      new SupabaseProposalSink(db.asClient(), null).record({
        rawText: "x",
        proposedName: "x",
        proposedCategory: null,
      }),
    ).rejects.toThrow(/boom/);
  });
});

describe("recordAiRun", () => {
  const usage: LlmUsage = {
    model: "claude-haiku-5-5",
    promptVersion: "ingredient-parse.v1",
    inputTokens: 900,
    outputTokens: 400,
    cacheReadTokens: 800,
    latencyMs: 640,
    ok: true,
    lines: 20,
  };

  it("writes one ai_runs row per call", async () => {
    const db = new FakeDb();
    await recordAiRun(db.asClient(), usage, 0.00033, "house-1");
    expect(db.table("ai_runs")).toEqual([
      {
        household_id: "house-1",
        kind: "parse_ingredients",
        model: "claude-haiku-5-5",
        prompt_version: "ingredient-parse.v1",
        input_tokens: 900,
        output_tokens: 400,
        cache_read_tokens: 800,
        cost_usd: 0.00033,
        latency_ms: 640,
        ok: true,
        error: null,
      },
    ]);
  });

  it("only warns when the table does not exist yet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = new FakeDb();
    db.failTable = "ai_runs";
    await expect(recordAiRun(db.asClient(), usage, 0, null)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("SupabaseRecipeStore", () => {
  function setup() {
    const db = new FakeDb();
    db.table("recipes").push({ id: "rec-1", household_id: "house-1" });
    db.table("recipe_ingredients").push(
      {
        id: "a",
        recipe_id: "rec-1",
        position: 1,
        group_name: null,
        raw_text: "2 cups flour",
        parse_confidence: null,
      },
      {
        id: "b",
        recipe_id: "rec-1",
        position: 0,
        group_name: "Dough",
        raw_text: "1 egg",
        parse_confidence: null,
      },
      {
        id: "c",
        recipe_id: "rec-1",
        position: 2,
        group_name: null,
        raw_text: "salt",
        parse_confidence: 0.9,
      },
      {
        id: "d",
        recipe_id: "rec-2",
        position: 0,
        group_name: null,
        raw_text: "other",
        parse_confidence: null,
      },
    );
    const tokens: string[] = [];
    const store = new SupabaseRecipeStore((auth) => {
      tokens.push(auth);
      return db.asClient();
    });
    return { db, store, tokens };
  }

  it("loads only the unparsed rows of the recipe, in order, as the caller", async () => {
    const { store, tokens } = setup();
    const loaded = await store.load("Bearer t", "rec-1");
    expect(loaded?.householdId).toBe("house-1");
    expect(loaded?.rows.map((r) => r.id)).toEqual(["b", "a"]);
    expect(loaded?.rows[0]).toEqual({ id: "b", position: 0, groupName: "Dough", rawText: "1 egg" });
    expect(tokens).toEqual(["Bearer t"]);
  });

  it("returns null for a recipe the caller cannot see", async () => {
    expect(await setup().store.load("Bearer t", "rec-9")).toBeNull();
  });

  it("updates rows and inserts the extra ingredients", async () => {
    const { db, store } = setup();
    await store.save(
      "Bearer t",
      "rec-1",
      [
        {
          id: "a",
          qty: 2,
          qty_max: null,
          unit: "cup",
          ingredient_id: "flour",
          prep_note: null,
          optional: false,
          parse_confidence: 0.97,
        },
      ],
      [
        {
          recipe_id: "rec-1",
          position: 1,
          group_name: null,
          raw_text: "2 cups flour",
          qty: null,
          qty_max: null,
          unit: null,
          ingredient_id: "salt",
          prep_note: null,
          optional: false,
          parse_confidence: 0.85,
        },
      ],
    );
    const rows = db.table("recipe_ingredients");
    expect(rows.find((r) => r.id === "a")).toMatchObject({
      qty: 2,
      unit: "cup",
      ingredient_id: "flour",
      parse_confidence: 0.97,
    });
    expect(rows).toHaveLength(5);
  });
});
