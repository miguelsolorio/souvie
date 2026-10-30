import { LlmError, MODELS } from "@mp/llm";
import { describe, expect, it, vi } from "vitest";
import { importFromImage } from "./image.ts";
import type { ModelExtract } from "./schema.ts";
import { importFromText } from "./text.ts";

const ANSWER = {
  found: true,
  title: "Pancakes",
  description: null,
  servings: 4,
  prep_minutes: 5,
  cook_minutes: 10,
  ingredients: [
    { text: "2 cups flour", group: null },
    { text: "1 cup milk", group: null },
    { text: "1 egg", group: null },
  ],
  steps: ["Whisk.", "Fry."],
  tags: ["breakfast"],
  cuisine: null,
};

function scripted(answers: unknown[]) {
  const calls: Array<{ model?: string; user: string; images?: unknown }> = [];
  const extract: ModelExtract = async (schema, request) => {
    calls.push({
      ...(request.model ? { model: request.model } : {}),
      user: request.user,
      images: request.images,
    });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return {
      value: schema.parse(next),
      model: request.model ?? "claude-sonnet-5-5",
      attempts: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
    };
  };
  return { extract, calls };
}

const TEXT = "Pancakes\n2 cups flour\n1 cup milk\n1 egg\nWhisk. Fry.";

describe("importFromText", () => {
  it("turns pasted text into a recipe with the text path and no source link", async () => {
    const { extract, calls } = scripted([ANSWER]);
    const result = await importFromText(TEXT, { extract, householdId: "h1" });
    expect(result).toMatchObject({ ok: true, path: "text" });
    if (!result.ok) return;
    expect(result.recipe).toMatchObject({
      title: "Pancakes",
      servings: 4,
      prepMin: 5,
      cookMin: 10,
    });
    expect(result.recipe).not.toHaveProperty("sourceUrl");
    expect(calls[0]?.user).toContain("text a person pasted");
    expect(calls[0]?.user).toContain("<source>\nPancakes");
  });

  it("rejects text that is too short without calling the model", async () => {
    const { extract, calls } = scripted([ANSWER]);
    const result = await importFromText("hi", { extract });
    expect(result).toMatchObject({ ok: false, reason: "not_enough_text" });
    expect(calls).toHaveLength(0);
  });

  it("caps very long text before sending it", async () => {
    const { extract, calls } = scripted([ANSWER]);
    await importFromText(`Pancakes\n${"2 cups flour\n".repeat(5000)}`, { extract });
    expect(calls[0]?.user.length).toBeLessThan(31_000);
  });

  it("reports no_recipe_found when the model finds none", async () => {
    const { extract } = scripted([
      { ...ANSWER, found: false, title: "", ingredients: [], steps: [] },
    ]);
    expect(await importFromText(TEXT, { extract })).toMatchObject({
      ok: false,
      reason: "no_recipe_found",
    });
  });

  it("maps model errors", async () => {
    const result = await importFromText(TEXT, {
      extract: scripted([new LlmError("cost_cap", "over")]).extract,
    });
    expect(result).toMatchObject({ ok: false, reason: "cost_cap" });
    expect(await importFromText(TEXT, {})).toMatchObject({
      ok: false,
      reason: "model_unavailable",
    });
  });
});

describe("importFromImage", () => {
  const image = { mediaType: "image/jpeg" as const, data: "QUJD" };

  it("reads a photo and sends it as an image", async () => {
    const { extract, calls } = scripted([ANSWER]);
    const result = await importFromImage([image], { extract });
    expect(result).toMatchObject({ ok: true, path: "vision", warnings: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.images).toEqual([image]);
    expect(calls[0]?.user).toContain("attached photos");
    expect(calls[0]?.model).toBeUndefined();
  });

  it("retries a partial reading once on Opus and keeps the fuller one", async () => {
    const partial = { ...ANSWER, ingredients: [{ text: "2 cups flour", group: null }], steps: [] };
    const { extract, calls } = scripted([partial, ANSWER]);
    const result = await importFromImage([image], { extract });
    expect(calls.map((c) => c.model)).toEqual([undefined, MODELS.opus]);
    expect(result).toMatchObject({ ok: true, path: "vision" });
    if (result.ok) {
      expect(result.recipe.ingredients).toHaveLength(3);
      expect(result.warnings).toContain("escalated_to_opus");
    }
  });

  it("keeps the first reading when Opus does no better, and when Opus fails", async () => {
    const partial = { ...ANSWER, ingredients: [{ text: "2 cups flour", group: null }], steps: [] };
    const worse = { ...ANSWER, ingredients: [{ text: "x", group: null }], steps: [] };
    for (const second of [worse, new LlmError("api", "503")]) {
      const { extract } = scripted([partial, second]);
      const result = await importFromImage([image], { extract });
      expect(result.ok && result.recipe.ingredients[0]?.rawText).toBe("2 cups flour");
    }
  });

  it("does not escalate when the photo has no recipe", async () => {
    const { extract, calls } = scripted([
      { ...ANSWER, found: false, title: "", ingredients: [], steps: [] },
    ]);
    expect(await importFromImage([image], { extract })).toMatchObject({
      ok: false,
      reason: "no_recipe_found",
    });
    expect(calls).toHaveLength(1);
  });

  it("validates the photos before any model call", async () => {
    const { extract, calls } = scripted([ANSWER]);
    expect(await importFromImage([], { extract })).toMatchObject({
      ok: false,
      reason: "invalid_request",
    });
    expect(
      await importFromImage([{ mediaType: "image/heic" as never, data: "QUJD" }], { extract }),
    ).toMatchObject({ ok: false, reason: "invalid_request" });
    expect(
      await importFromImage([{ mediaType: "image/png", data: "A".repeat(7_000_000) }], { extract }),
    ).toMatchObject({ ok: false, reason: "too_large" });
    expect(await importFromImage(Array(5).fill(image), { extract })).toMatchObject({
      ok: false,
      reason: "invalid_request",
    });
    expect(calls).toHaveLength(0);
  });

  it("reports model_unavailable without a model", async () => {
    expect(await importFromImage([image], {})).toMatchObject({
      ok: false,
      reason: "model_unavailable",
    });
    vi.restoreAllMocks();
  });
});
