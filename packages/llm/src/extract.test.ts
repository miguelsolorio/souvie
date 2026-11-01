import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LlmError, type MessagesClient, type ParsedResponse } from "./client.ts";
import { extract } from "./extract.ts";
import type { AiRunRecord, CostGuard } from "./log.ts";

const Answer = z.object({ title: z.string().min(1), n: z.number() });

const usage = (over: Partial<ParsedResponse["usage"]> = {}) => ({
  input_tokens: 1000,
  output_tokens: 200,
  cache_read_input_tokens: 0,
  ...over,
});

function reply(parsed: unknown, over: Partial<ParsedResponse> = {}): ParsedResponse {
  return { parsed_output: parsed, stop_reason: "end_turn", usage: usage(), ...over };
}

/** A client that returns the given responses in order, and records every call's params. */
function fakeClient(responses: Array<ParsedResponse | Error>) {
  const calls: Array<Record<string, unknown>> = [];
  const beta: Array<Record<string, unknown>> = [];
  const next = async (params: Record<string, unknown>, sink: Array<Record<string, unknown>>) => {
    sink.push(params);
    const r = responses.shift();
    if (!r) throw new Error("fake client ran out of responses");
    if (r instanceof Error) throw r;
    return r;
  };
  const client: MessagesClient = {
    messages: { parse: (p) => next(p, calls) },
    beta: { messages: { parse: (p) => next(p, beta) } },
  };
  return { client, calls, beta };
}

function recorder() {
  const rows: AiRunRecord[] = [];
  return { rows, log: (r: AiRunRecord) => void rows.push(r) };
}

const REQUEST = {
  system: "You extract.",
  user: "Input text",
  kind: "extract_recipe",
  promptVersion: "recipe-extract.v1",
  householdId: "0a000000-0000-4000-8000-00000000000a",
};

describe("extract", () => {
  it("returns the validated value and sends a Sonnet structured-output request", async () => {
    const { client, calls } = fakeClient([reply({ title: "Soup", n: 4 })]);
    const { rows, log } = recorder();

    const result = await extract(Answer, REQUEST, { client, log });

    expect(result.value).toEqual({ title: "Soup", n: 4 });
    expect(result.model).toBe("claude-sonnet-5-5");
    expect(result.attempts).toBe(1);
    expect(calls).toHaveLength(1);
    const params = calls[0] ?? {};
    expect(params.model).toBe("claude-sonnet-5-5");
    expect(params.max_tokens).toBe(16000);
    // Sonnet 5.5 rejects thinking: disabled and non-default sampling values.
    expect(params).not.toHaveProperty("thinking");
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("top_p");
    const config = params.output_config as { effort: string; format: { type: string } };
    expect(config.effort).toBe("low");
    expect(config.format.type).toBe("json_schema");
    expect(params.system).toEqual([
      { type: "text", text: "You extract.", cache_control: { type: "ephemeral" } },
    ]);
    expect(params.messages).toEqual([{ role: "user", content: "Input text" }]);
    expect(params).not.toHaveProperty("betas");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      householdId: "0a000000-0000-4000-8000-00000000000a",
      kind: "extract_recipe",
      model: "claude-sonnet-5-5",
      promptVersion: "recipe-extract.v1",
      inputTokens: 1000,
      outputTokens: 200,
      ok: true,
      error: null,
    });
    // 1000 * $2/M + 200 * $10/M
    expect(rows[0]?.costUsd).toBeCloseTo(0.004, 8);
    expect(result.costUsd).toBeCloseTo(0.004, 8);
  });

  it("sends images before the text as base64 blocks", async () => {
    const { client, calls } = fakeClient([reply({ title: "Card", n: 1 })]);
    await extract(
      Answer,
      { ...REQUEST, images: [{ mediaType: "image/jpeg", data: "QUJD" }] },
      { client },
    );
    const messages = calls[0]?.messages as Array<{ content: unknown }>;
    expect(messages[0]?.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
      { type: "text", text: "Input text" },
    ]);
  });

  it("honors model, effort, and maxTokens", async () => {
    const { client, calls } = fakeClient([reply({ title: "x", n: 1 })]);
    await extract(
      Answer,
      { ...REQUEST, model: "claude-opus-5-5", effort: "high", maxTokens: 4000 },
      { client },
    );
    const params = calls[0] ?? {};
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.max_tokens).toBe(4000);
    expect((params.output_config as { effort: string }).effort).toBe("high");
  });

  it("retries once when the answer fails the schema, and logs both calls", async () => {
    const { client, calls } = fakeClient([
      reply({ title: "", n: "x" }),
      reply({ title: "Soup", n: 2 }),
    ]);
    const { rows, log } = recorder();

    const result = await extract(Answer, REQUEST, { client, log });

    expect(result.value).toEqual({ title: "Soup", n: 2 });
    expect(result.attempts).toBe(2);
    expect(rows.map((r) => r.ok)).toEqual([false, true]);
    expect(rows[0]?.error).toMatch(/did not match the schema/);
    const second = calls[1]?.messages as Array<{ content: string }>;
    expect(second[0]?.content).toMatch(/^Input text\n\nYour previous answer was rejected/);
    expect(result.inputTokens).toBe(2000);
  });

  it("gives up after the retry and throws invalid", async () => {
    const { client } = fakeClient([reply({ nope: 1 }), reply({ nope: 2 })]);
    const { rows, log } = recorder();
    await expect(extract(Answer, REQUEST, { client, log })).rejects.toMatchObject({
      name: "LlmError",
      code: "invalid",
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => !r.ok)).toBe(true);
  });

  it("retries when the caller's check rejects the value", async () => {
    const { client } = fakeClient([reply({ title: "Bad", n: 1 }), reply({ title: "Good", n: 1 })]);
    const check = vi.fn((v: { title: string }) => (v.title === "Bad" ? "title is bad" : null));
    const result = await extract(Answer, { ...REQUEST, check }, { client });
    expect(result.value.title).toBe("Good");
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("honors maxRetries 0", async () => {
    const { client } = fakeClient([reply({ nope: 1 })]);
    await expect(extract(Answer, REQUEST, { client, maxRetries: 0 })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("throws refusal without retrying", async () => {
    const { client, calls } = fakeClient([reply(null, { stop_reason: "refusal" })]);
    const { rows, log } = recorder();
    await expect(extract(Answer, REQUEST, { client, log })).rejects.toMatchObject({
      code: "refusal",
    });
    expect(calls).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ok).toBe(false);
  });

  it("throws truncated when the response hit max_tokens", async () => {
    const { client } = fakeClient([reply(null, { stop_reason: "max_tokens" })]);
    await expect(extract(Answer, REQUEST, { client })).rejects.toMatchObject({ code: "truncated" });
  });

  it("maps an API error with a status to api and does not retry", async () => {
    const err = Object.assign(new Error("429 rate limited: too many requests"), { status: 429 });
    const { client, calls } = fakeClient([err]);
    const { rows, log } = recorder();
    await expect(extract(Answer, REQUEST, { client, log })).rejects.toMatchObject({ code: "api" });
    expect(calls).toHaveLength(1);
    expect(rows).toEqual([expect.objectContaining({ ok: false, inputTokens: 0, costUsd: 0 })]);
  });

  it("retries the SDK's own parse error once", async () => {
    const { client } = fakeClient([
      new Error("Failed to parse structured output: Unexpected token"),
      reply({ title: "Soup", n: 1 }),
    ]);
    const result = await extract(Answer, REQUEST, { client });
    expect(result.attempts).toBe(2);
  });

  it("checks the cost guard before calling the model and never calls it when over cap", async () => {
    const { client, calls } = fakeClient([reply({ title: "x", n: 1 })]);
    const { rows, log } = recorder();
    const guard: CostGuard = {
      check: async () => {
        throw new LlmError("cost_cap", "over");
      },
    };
    await expect(extract(Answer, REQUEST, { client, log, guard })).rejects.toMatchObject({
      code: "cost_cap",
    });
    expect(calls).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  it("passes the household and the call to the guard", async () => {
    const { client } = fakeClient([reply({ title: "x", n: 1 })]);
    const check = vi.fn(async () => {});
    await extract(Answer, REQUEST, { client, guard: { check } });
    expect(check).toHaveBeenCalledWith(
      "0a000000-0000-4000-8000-00000000000a",
      expect.objectContaining({
        kind: "extract_recipe",
        model: "claude-sonnet-5-5",
        promptVersion: "recipe-extract.v1",
        estimatedCostUsd: expect.any(Number),
      }),
    );
  });

  it("reports not_configured when there is neither a client nor a key", async () => {
    await expect(extract(Answer, REQUEST, {})).rejects.toMatchObject({ code: "not_configured" });
  });

  it("uses the beta endpoint with the fallback flag only when asked", async () => {
    const { client, calls, beta } = fakeClient([reply({ title: "x", n: 1 })]);
    await extract(Answer, REQUEST, { client, serverFallback: true });
    expect(calls).toHaveLength(0);
    expect(beta).toHaveLength(1);
    expect(beta[0]).toMatchObject({
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
  });

  it("keeps working when the log sink throws", async () => {
    const { client } = fakeClient([reply({ title: "x", n: 1 })]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await extract(Answer, REQUEST, {
      client,
      log: () => {
        throw new Error("db down");
      },
    });
    expect(result.value.title).toBe("x");
    warn.mockRestore();
  });

  it("measures latency with the injected clock", async () => {
    const { client } = fakeClient([reply({ title: "x", n: 1 })]);
    const { rows, log } = recorder();
    const times = [1000, 1250];
    await extract(Answer, REQUEST, { client, log, now: () => times.shift() ?? 0 });
    expect(rows[0]?.latencyMs).toBe(250);
  });
});
