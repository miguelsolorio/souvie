import { describe, expect, it, vi } from "vitest";
import { LlmError } from "./client.ts";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  embed,
  estimateEmbeddingCostUsd,
  formatVector,
  isEmbeddingConfigured,
} from "./embed.ts";
import type { AiRunRecord } from "./log.ts";

const vector = (seed: number) =>
  Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => ((i + seed) % 7) / 10);

function voyageResponse(count: number, tokens = 12, indexOrder: number[] | null = null) {
  const order = indexOrder ?? Array.from({ length: count }, (_, i) => i);
  return Response.json({
    object: "list",
    model: EMBEDDING_MODEL,
    data: order.map((index) => ({ object: "embedding", index, embedding: vector(index) })),
    usage: { total_tokens: tokens },
  });
}

function fakeFetch(...responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const queue = [...responses];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra request");
    if (next instanceof Error) throw next;
    return next;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("embed", () => {
  it("throws not_configured without a key, before any request", async () => {
    const { fn, calls } = fakeFetch();
    await expect(embed(["x"], { apiKey: "", fetch: fn })).rejects.toMatchObject({
      name: "LlmError",
      code: "not_configured",
    });
    expect(calls).toHaveLength(0);
  });

  it("reports whether a key is configured", () => {
    expect(isEmbeddingConfigured("pa-test")).toBe(true);
    expect(isEmbeddingConfigured("   ")).toBe(false);
  });

  it("sends voyage-3 with the input type and returns vectors in input order", async () => {
    const { fn, calls } = fakeFetch(voyageResponse(2, 20, [1, 0]));
    const vectors = await embed(["first", "second"], {
      apiKey: "pa-test",
      inputType: "query",
      fetch: fn,
    });
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toEqual(vector(0));
    expect(vectors[1]).toEqual(vector(1));
    const call = calls[0];
    expect(call?.url).toBe("https://api.voyageai.com/v1/embeddings");
    const body = JSON.parse(String(call?.init.body));
    expect(body).toEqual({
      input: ["first", "second"],
      model: "voyage-3",
      input_type: "query",
      truncation: true,
    });
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer pa-test");
  });

  it("logs one ai_runs record per request with tokens and cost", async () => {
    const { fn } = fakeFetch(voyageResponse(2, 1_000_000));
    const runs: AiRunRecord[] = [];
    await embed(["a", "b"], {
      apiKey: "pa-test",
      kind: "suggest.embed",
      householdId: "0a000000-0000-4000-8000-00000000000a",
      log: (run) => {
        runs.push(run);
      },
      fetch: fn,
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      kind: "suggest.embed",
      model: "voyage-3",
      householdId: "0a000000-0000-4000-8000-00000000000a",
      inputTokens: 1_000_000,
      outputTokens: 0,
      ok: true,
      error: null,
    });
    expect(runs[0]?.costUsd).toBeCloseTo(0.06, 8);
  });

  it("defaults the kind to embed and the input type to document", async () => {
    const { fn, calls } = fakeFetch(voyageResponse(1));
    const runs: AiRunRecord[] = [];
    await embed(["a"], { apiKey: "k", log: (r) => void runs.push(r), fetch: fn });
    expect(runs[0]?.kind).toBe("embed");
    expect(JSON.parse(String(calls[0]?.init.body)).input_type).toBe("document");
  });

  it("batches large inputs and keeps the order", async () => {
    const texts = Array.from({ length: 130 }, (_, i) => `recipe ${i}`);
    const { fn, calls } = fakeFetch(voyageResponse(64), voyageResponse(64), voyageResponse(2));
    const vectors = await embed(texts, { apiKey: "k", fetch: fn });
    expect(vectors).toHaveLength(130);
    expect(calls).toHaveLength(3);
    expect(JSON.parse(String(calls[2]?.init.body)).input).toEqual(["recipe 128", "recipe 129"]);
  });

  it("retries once on a rate limit, then succeeds", async () => {
    const { fn, calls } = fakeFetch(
      new Response("slow down", { status: 429, headers: { "retry-after": "1" } }),
      voyageResponse(1),
    );
    const sleep = vi.fn(async () => {});
    const runs: AiRunRecord[] = [];
    const vectors = await embed(["a"], {
      apiKey: "k",
      fetch: fn,
      sleep,
      log: (r) => void runs.push(r),
    });
    expect(vectors).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(runs.map((r) => r.ok)).toEqual([false, true]);
  });

  it("gives up after the second failure with a typed error that carries no key or body", async () => {
    const { fn } = fakeFetch(
      new Response("echo pa-secret-key", { status: 500 }),
      new Response("echo pa-secret-key", { status: 500 }),
    );
    const error = await embed(["a"], {
      apiKey: "pa-secret-key",
      fetch: fn,
      sleep: async () => {},
    }).catch((e) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error.code).toBe("api");
    expect(error.message).not.toContain("pa-secret-key");
  });

  it("does not retry a refused key", async () => {
    const { fn, calls } = fakeFetch(new Response("no", { status: 401 }));
    await expect(embed(["a"], { apiKey: "bad", fetch: fn })).rejects.toMatchObject({ code: "api" });
    expect(calls).toHaveLength(1);
  });

  it("reports a network failure as an api error", async () => {
    const { fn } = fakeFetch(new Error("socket hang up"));
    await expect(embed(["a"], { apiKey: "k", fetch: fn })).rejects.toMatchObject({ code: "api" });
  });

  it("rejects a vector of the wrong size", async () => {
    const bad = Response.json({
      data: [{ index: 0, embedding: [0.1, 0.2] }],
      usage: { total_tokens: 3 },
    });
    const { fn } = fakeFetch(bad);
    await expect(embed(["a"], { apiKey: "k", fetch: fn })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("rejects a response with the wrong number of vectors", async () => {
    const { fn } = fakeFetch(voyageResponse(1));
    await expect(embed(["a", "b"], { apiKey: "k", fetch: fn })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("checks the cost guard before each request", async () => {
    const { fn, calls } = fakeFetch();
    const guard = {
      check: vi.fn(async () => {
        throw new LlmError("cost_cap", "over budget");
      }),
    };
    await expect(embed(["a"], { apiKey: "k", fetch: fn, guard })).rejects.toMatchObject({
      code: "cost_cap",
    });
    expect(calls).toHaveLength(0);
  });

  it("returns nothing for no input and refuses an empty text", async () => {
    const { fn, calls } = fakeFetch();
    await expect(embed([], { apiKey: "k", fetch: fn })).resolves.toEqual([]);
    await expect(embed(["  "], { apiKey: "k", fetch: fn })).rejects.toMatchObject({
      code: "invalid",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("vector helpers", () => {
  it("formats pgvector text", () => {
    expect(formatVector([0.5, -1, 2])).toBe("[0.5,-1,2]");
  });

  it("prices voyage-3 at 6 cents per million tokens", () => {
    expect(estimateEmbeddingCostUsd(1_000_000)).toBeCloseTo(0.06, 8);
    expect(estimateEmbeddingCostUsd(0)).toBe(0);
  });
});
