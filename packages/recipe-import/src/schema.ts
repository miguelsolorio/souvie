// Shared types for the importers (WS02). Every importer returns an `ImportResult`: either a
// `NormalizedRecipe` plus the stage that produced it, or a typed failure the UI can explain.
// docs/03-ai-design.md §4.

import type { ImportErrorCode, ImportPath, NormalizedRecipe } from "@mp/core";
import type { ExtractRequest, ExtractResult } from "@mp/llm";
import type { z } from "zod";

export type { ImportErrorCode, ImportPath, NormalizedRecipe };

/**
 * Asks a model for structured output. Production binds `@mp/llm`'s `extract` to a client, a log
 * sink, and a cost guard; tests and the offline eval pass a fake or a replay of recorded answers.
 */
export type ModelExtract = <T>(
  schema: z.ZodType<T>,
  request: ExtractRequest<T>,
) => Promise<ExtractResult<T>>;

export interface ImportDeps {
  /**
   * The model path (page text the scrapers could not read, pasted text, captions, photos).
   * Without it those paths fail with `model_unavailable`; the deterministic path still works.
   */
  extract?: ModelExtract;
  /** ai_runs.household_id for the model calls. */
  householdId?: string | null;
}

export interface UrlImportDeps extends ImportDeps {
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Overall budget for one page, redirects included. Default 10 s. */
  timeoutMs?: number;
  /** Largest page accepted, in bytes. Default 4 MiB. */
  maxBytes?: number;
  /**
   * Resolves a host name to IP addresses so the private-address check can see through DNS. The
   * Edge Function passes Deno's resolver; without it only IP literals and well-known internal
   * names are rejected.
   */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

export interface ImportSuccess {
  ok: true;
  recipe: NormalizedRecipe;
  /** `jsonld` and `scraper` read the page's own data; the rest used a model. */
  path: ImportPath;
  /** Short codes the UI may explain, for example `no_instructions`. */
  warnings: string[];
}

export interface ImportFailure {
  ok: false;
  reason: ImportErrorCode;
  message: string;
  /** The HTTP status, when the failure came from a response. */
  status?: number;
}

export type ImportResult = ImportSuccess | ImportFailure;

export function failure(reason: ImportErrorCode, message: string, status?: number): ImportFailure {
  return status === undefined
    ? { ok: false, reason, message }
    : { ok: false, reason, message, status };
}

/** The ai_runs.kind for every recipe-import model call. */
export const EXTRACT_KIND = "extract_recipe";

/** Maps an `@mp/llm` error to an import failure. */
export function failureFromModelError(err: unknown): ImportFailure {
  const code = (err as { code?: unknown } | null)?.code;
  switch (code) {
    case "cost_cap":
      return failure("cost_cap", "The daily limit for reading recipes has been reached.");
    case "not_configured":
      return failure("model_unavailable", "Recipe reading is not configured.");
    default:
      return failure("model_failed", "The recipe could not be read.");
  }
}
