import type { MpClient } from "@mp/db";
import { describe, expect, it, vi } from "vitest";
import {
  isSuggestEnabled,
  parseSwapSuggestion,
  requestSwapSuggestion,
  SuggestUnavailableError,
} from "./suggest";

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const RECIPE = "aa000000-0000-4000-8000-000000000001";

const request = {
  householdId: HOUSEHOLD,
  weekStart: "2026-11-02",
  date: "2026-11-03",
  slot: "dinner" as const,
  excludeRecipeIds: [RECIPE],
};

function clientReturning(result: { data?: unknown; error?: unknown }) {
  const invoke = vi.fn().mockResolvedValue({ data: null, error: null, ...result });
  return { client: { functions: { invoke } } as unknown as MpClient, invoke };
}

describe("isSuggestEnabled", () => {
  it("is off unless the flag says on", () => {
    expect(isSuggestEnabled(undefined)).toBe(false);
    expect(isSuggestEnabled("")).toBe(false);
    expect(isSuggestEnabled("0")).toBe(false);
    expect(isSuggestEnabled("false")).toBe(false);
    expect(isSuggestEnabled("1")).toBe(true);
    expect(isSuggestEnabled("true")).toBe(true);
    expect(isSuggestEnabled(" ON ")).toBe(true);
  });
});

describe("requestSwapSuggestion", () => {
  it("posts the slot and the recipes to avoid, and returns the first entry", async () => {
    const { client, invoke } = clientReturning({
      data: {
        planId: "ca000000-0000-4000-8000-0000000000a1",
        entries: [
          {
            date: "2026-11-03",
            slot: "dinner",
            recipeId: RECIPE,
            servings: 3,
            why: "Uses the leftover lemons",
          },
        ],
      },
    });
    const result = await requestSwapSuggestion(client, request);
    expect(invoke).toHaveBeenCalledWith("suggest", { body: { ...request, mode: "swap" } });
    expect(result).toEqual({ recipeId: RECIPE, servings: 3, why: "Uses the leftover lemons" });
  });

  it("tolerates a suggestion without servings or a reason", async () => {
    const { client } = clientReturning({
      data: { entries: [{ date: "2026-11-03", slot: "dinner", recipeId: RECIPE }] },
    });
    expect(await requestSwapSuggestion(client, request)).toEqual({
      recipeId: RECIPE,
      servings: null,
      why: null,
    });
  });

  it("says suggestions are unavailable when the function is not deployed", async () => {
    const { client } = clientReturning({
      error: { message: "Not Found", context: { status: 404 } },
    });
    await expect(requestSwapSuggestion(client, request)).rejects.toBeInstanceOf(
      SuggestUnavailableError,
    );
  });

  it("passes other errors through", async () => {
    const { client } = clientReturning({
      error: { message: "model busy", context: { status: 503 } },
    });
    await expect(requestSwapSuggestion(client, request)).rejects.toThrow("model busy");
  });

  it("refuses an answer it cannot read, such as an invented recipe id", async () => {
    const empty = clientReturning({ data: { entries: [] } });
    await expect(requestSwapSuggestion(empty.client, request)).rejects.toThrow(/shape/);
    const invented = clientReturning({
      data: { entries: [{ date: "2026-11-03", slot: "dinner", recipeId: "pasta-primavera" }] },
    });
    await expect(requestSwapSuggestion(invented.client, request)).rejects.toThrow(/shape/);
  });
});

describe("parseSwapSuggestion", () => {
  const entry = { date: "2026-11-03", slot: "dinner", recipeId: RECIPE };

  it("trims the reason to a short line", () => {
    expect(
      parseSwapSuggestion({ entries: [{ ...entry, why: "x".repeat(400) }] })?.why,
    ).toHaveLength(280);
    expect(parseSwapSuggestion({ entries: [{ ...entry, why: "   " }] })?.why).toBeUndefined();
  });

  it("rejects a bad slot, a missing date, and non-positive servings", () => {
    expect(parseSwapSuggestion({ entries: [{ ...entry, slot: "brunch" }] })).toBeNull();
    expect(parseSwapSuggestion({ entries: [{ slot: "dinner", recipeId: RECIPE }] })).toBeNull();
    expect(parseSwapSuggestion({ entries: [{ ...entry, servings: 0 }] })?.servings).toBeUndefined();
  });

  it("rejects anything that is not an entries list", () => {
    expect(parseSwapSuggestion(null)).toBeNull();
    expect(parseSwapSuggestion({})).toBeNull();
    expect(parseSwapSuggestion({ entries: "nope" })).toBeNull();
  });
});
