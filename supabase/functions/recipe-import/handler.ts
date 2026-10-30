// recipe-import request handling (WS02). No Deno globals and no supabase-js here: the handler
// takes a `Runtime`, so Vitest drives it with fakes (index.test.ts). index.ts builds the real
// runtime. Request and response shapes are in README.md and in @mp/core (recipe.ts).

import {
  IMPORT_ERROR_MESSAGES,
  type ImportErrorCode,
  type ImportJobKind,
  ImportRecipeRequest,
  type NormalizedRecipe,
  type RecipeSourceType,
} from "../../../packages/core/src/index.ts";
import type { ExtractImage, ImageMediaType } from "../../../packages/llm/src/index.ts";
import {
  type ImportResult,
  importFromCaption,
  importFromImage,
  importFromText,
  importFromUrl,
  type ModelExtract,
} from "../../../packages/recipe-import/src/index.ts";
import type { DownloadedImage, ImportStore } from "./store.ts";

/** Imports one household may start in an hour. A cap on fetches from our infrastructure. */
export const HOURLY_IMPORT_LIMIT = 120;
/** Largest request body accepted, in bytes. Pasted text is at most 30,000 characters. */
export const MAX_BODY_BYTES = 200_000;
/** Largest photo read from Storage, in bytes. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export interface Runtime {
  authenticate(authHeader: string): Promise<{ userId: string } | null>;
  store: ImportStore;
  /**
   * The model for one request, bound to the household's logging and cost cap. Undefined when no
   * API key is configured, which leaves only the scrapers.
   */
  modelFor(householdId: string): ModelExtract | undefined;
  /** For the URL path's DNS check. */
  resolveHost?: (hostname: string) => Promise<string[]>;
  /** For tests. */
  fetch?: typeof fetch;
  now(): Date;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
}

function fail(error: ImportErrorCode, status: number, jobId?: string, message?: string): Response {
  return json(
    {
      ok: false,
      error,
      message: message ?? IMPORT_ERROR_MESSAGES[error],
      ...(jobId ? { jobId } : {}),
    },
    status,
  );
}

/** Request-level problems get an HTTP error; import-level outcomes are a 200 with `ok: false`. */
const REQUEST_STATUS: Partial<Record<ImportErrorCode, number>> = {
  unauthorized: 401,
  invalid_request: 400,
  no_household: 400,
  not_a_member: 403,
  save_failed: 500,
  internal_error: 500,
};

const JOB_KIND: Record<"url" | "text" | "image" | "caption", ImportJobKind> = {
  url: "url",
  text: "text",
  image: "photo",
  caption: "caption",
};

function mediaTypeOf(image: DownloadedImage, path: string): ImageMediaType | null {
  const declared = image.contentType.toLowerCase().split(";")[0]?.trim();
  if (declared === "image/jpeg" || declared === "image/png" || declared === "image/webp") {
    return declared;
  }
  const ext = path.toLowerCase().split(".").pop();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return null;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** A Storage path inside the household's folder, with no traversal. */
export function isHouseholdImagePath(path: string, householdId: string): boolean {
  if (!path.startsWith(`${householdId}/`)) return false;
  if (path.includes("..") || path.includes("//") || path.includes("\\") || path.endsWith("/")) {
    return false;
  }
  return /^[A-Za-z0-9._\-/]+$/.test(path);
}

export async function handleRecipeImport(req: Request, runtime: Runtime): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return Response.json(
      { ok: false, error: "method_not_allowed" },
      { status: 405, headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS" } },
    );
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader || !/^Bearer\s+\S+/i.test(authHeader)) return fail("unauthorized", 401);
  let user: { userId: string } | null = null;
  try {
    user = await runtime.authenticate(authHeader);
  } catch (err) {
    console.error("recipe-import: auth check failed", err);
  }
  if (!user) return fail("unauthorized", 401);

  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return fail("invalid_request", 413, undefined, "The request is too large.");
  }
  let raw: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) {
      return fail("invalid_request", 413, undefined, "The request is too large.");
    }
    raw = JSON.parse(text);
  } catch {
    return fail("invalid_request", 400, undefined, "The request body is not valid JSON.");
  }
  const parsed = ImportRecipeRequest.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "request";
    return fail("invalid_request", 400, undefined, `${where}: ${issue?.message ?? "invalid"}`);
  }
  const request = parsed.data;

  try {
    const household = await runtime.store.resolveHousehold(
      authHeader,
      user.userId,
      request.householdId,
    );
    if (household.kind === "none") return fail("no_household", 400);
    if (household.kind === "not_member") return fail("not_a_member", 403);
    const householdId = household.householdId;

    if (request.kind === "image" && !isHouseholdImagePath(request.input.path, householdId)) {
      return fail(
        "invalid_request",
        400,
        undefined,
        "The photo is not in your household's folder.",
      );
    }

    const hourAgo = new Date(runtime.now().getTime() - 60 * 60 * 1000).toISOString();
    if ((await runtime.store.recentJobCount(householdId, hourAgo)) >= HOURLY_IMPORT_LIMIT) {
      return fail("rate_limited", 200);
    }

    const jobId = await runtime.store.createJob({
      householdId,
      kind: JOB_KIND[request.kind],
      input: jobInput(request),
    });

    const finishFailed = async (code: ImportErrorCode, message?: string) => {
      try {
        await runtime.store.finishJob(jobId, householdId, {
          status: "failed",
          error: `${code}${message ? `: ${message}` : ""}`,
        });
      } catch (err) {
        console.error("recipe-import: could not close the job", err);
      }
    };

    const extract = runtime.modelFor(householdId);
    const deps = {
      ...(extract ? { extract } : {}),
      householdId,
    };

    let result: ImportResult;
    switch (request.kind) {
      case "url":
        result = await importFromUrl(request.input, {
          ...deps,
          ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
          ...(runtime.resolveHost ? { resolveHost: runtime.resolveHost } : {}),
        });
        break;
      case "text":
        result = await importFromText(request.input, deps);
        break;
      case "caption":
        result = await importFromCaption(request.input, deps, { sourceUrl: request.sourceUrl });
        break;
      case "image": {
        const image = await runtime.store.downloadImage(authHeader, request.input.path);
        if (!image) {
          await finishFailed("image_not_found");
          return fail("image_not_found", 200, jobId);
        }
        const mediaType = mediaTypeOf(image, request.input.path);
        if (!mediaType || image.bytes.byteLength === 0) {
          await finishFailed("invalid_request", "unsupported image type");
          return fail("invalid_request", 400, jobId, "That photo format is not supported.");
        }
        if (image.bytes.byteLength > MAX_IMAGE_BYTES) {
          await finishFailed("too_large");
          return fail("too_large", 200, jobId);
        }
        const images: ExtractImage[] = [{ mediaType, data: toBase64(image.bytes) }];
        result = await importFromImage(images, deps);
        break;
      }
    }

    if (!result.ok) {
      await finishFailed(result.reason, result.message);
      return fail(result.reason, REQUEST_STATUS[result.reason] ?? 200, jobId, result.message);
    }

    // Photos and captions are saved only after the person edits and confirms them, unless the
    // caller explicitly asks to save.
    const save = request.save ?? true;
    if (!save) {
      await runtime.store.finishJob(jobId, householdId, { status: "done" });
      return json({
        ok: true,
        jobId,
        path: result.path,
        draft: draftFor(request, result.recipe),
        warnings: result.warnings,
      });
    }

    let recipeId: string;
    try {
      recipeId = await runtime.store.saveRecipe(authHeader, {
        householdId,
        recipe: result.recipe,
        ...saveFields(request, result.recipe),
      });
    } catch (err) {
      console.error("recipe-import: save failed", err);
      await finishFailed("save_failed");
      return fail("save_failed", 500, jobId);
    }
    await runtime.store.finishJob(jobId, householdId, { status: "done", resultRecipeId: recipeId });
    return json({ ok: true, jobId, path: result.path, recipeId, warnings: result.warnings });
  } catch (err) {
    console.error("recipe-import failed", err);
    return fail("internal_error", 500);
  }
}

/** What goes in import_jobs.input: enough to debug, never the pasted text or a caption. */
function jobInput(request: ImportRecipeRequest): Record<string, unknown> {
  switch (request.kind) {
    case "url":
      return { url: request.input.slice(0, 500) };
    case "text":
      return { length: request.input.length };
    case "image":
      return { path: request.input.path };
    case "caption":
      return {
        length: request.input.length,
        ...(request.sourceUrl ? { sourceUrl: request.sourceUrl.slice(0, 500) } : {}),
      };
  }
}

/** The source_type, image, and attribution to store for each kind of import. */
function saveFields(
  request: ImportRecipeRequest,
  recipe: NormalizedRecipe,
): {
  sourceType: RecipeSourceType;
  imageUrl?: string | undefined;
  sourceUrl?: string | undefined;
} {
  switch (request.kind) {
    case "url":
      return { sourceType: "url", sourceUrl: recipe.sourceUrl ?? request.input };
    case "text":
      return { sourceType: "text" };
    case "image":
      // The photo of the card is the recipe's image, in the household's folder of the bucket.
      return { sourceType: "photo", imageUrl: request.input.path };
    case "caption":
      // With the shared post's link it is a video import (attribution is required); without one
      // it is just text.
      return request.sourceUrl
        ? { sourceType: "video", sourceUrl: request.sourceUrl }
        : { sourceType: "text" };
  }
}

/** The draft the app shows for editing: for a photo, the Storage path rides along as the image. */
function draftFor(request: ImportRecipeRequest, recipe: NormalizedRecipe): NormalizedRecipe {
  if (request.kind === "image") return { ...recipe, imageUrl: request.input.path };
  if (request.kind === "caption" && request.sourceUrl) {
    return { ...recipe, sourceUrl: request.sourceUrl };
  }
  return recipe;
}
